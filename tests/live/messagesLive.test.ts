/**
 * LIVE verification of the Anthropic Messages wire format against the real API.
 * Skipped unless LANTERN_LIVE_ANTHROPIC=1 (it spends real tokens — a few cents
 * at most; the prompts are two sentences and max_tokens is small).
 *
 *   ANTHROPIC_API_KEY=sk-ant-… LANTERN_LIVE_ANTHROPIC=1 \
 *     npx vitest run tests/live/messagesLive.test.ts
 *
 * Optional: LANTERN_ANTHROPIC_MODEL (default claude-sonnet-4-6),
 *           LANTERN_ANTHROPIC_URL   (default https://api.anthropic.com/v1).
 *
 * The key is read from the environment and never logged; captured SSE frames
 * are written to tests/live/captures/ so the fixtures in
 * tests/agent/wire/messages.test.ts can be checked against reality.
 *
 * What only a live call can settle — every assertion here exists because the
 * offline tests CANNOT prove it:
 *  1. the request body is accepted at all (tools + tool_choice + system);
 *  2. `thinking:{type:"adaptive",display:"summarized"}` + `output_config.effort`
 *     is the right pairing for a current model (vs the deprecated
 *     `{type:"enabled", budget_tokens}`);
 *  3. thinking_delta / signature_delta really arrive WITH tools in play;
 *  4. tool arguments really stream as input_json_delta fragments;
 *  5. THE BIG ONE — a second turn replaying our reconstructed `thinking` block
 *     (signature included) plus tool_use and tool_result is ACCEPTED. If the
 *     block rebuild in MessagesStreamAccumulator.result() is wrong, this 400s.
 *  6. usage field names, and that message_delta usage is cumulative.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AgentLoop, type AgentEvent } from "../../src/agent/AgentLoop";
import { LlmClient, type ChatMessage, type ToolDef } from "../../src/agent/LlmClient";
import type { ToolRegistry } from "../../src/agent/tools";
import { SseDecoder } from "../../src/agent/stream";
import {
	MessagesStreamAccumulator,
	anthropicHeaders,
	buildMessagesBody,
	messagesUrl,
	parseMessagesResult,
	usesManualThinking,
} from "../../src/agent/wire/messages";

const LIVE = process.env.LANTERN_LIVE_ANTHROPIC === "1" && Boolean(process.env.ANTHROPIC_API_KEY);
const BASE_URL = process.env.LANTERN_ANTHROPIC_URL ?? "https://api.anthropic.com/v1";
const MODEL = process.env.LANTERN_ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
const CAPTURES = join(__dirname, "captures");

const tools: ToolDef[] = [
	{
		type: "function",
		function: {
			name: "search_vault",
			description: "Search the user's notes. Returns ranked results with paths.",
			parameters: {
				type: "object",
				properties: { query: { type: "string" }, keywords: { type: "array", items: { type: "string" } } },
				required: ["query"],
			},
		},
	},
];

/** Canned vault tools, mirroring tests/live/agentLive.test.ts so the two are comparable. */
const cannedTools: ToolRegistry = {
	search_vault: {
		def: tools[0],
		execute: async () =>
			JSON.stringify({
				results: [
					{
						path: "Geo/France.md",
						line: 2,
						score: 0.99,
						title: "France",
						snippet: "The capital of France is Paris.",
						link: "[[Geo/France.md]]",
					},
				],
			}),
	},
	read_vault: {
		def: {
			type: "function",
			function: {
				name: "read_vault",
				description: "Read a note by path.",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
		},
		execute: async () =>
			'File: path="Geo/France.md" (2 lines) link=[[Geo/France.md]]\n1: # France\n2: The capital of France is Paris.',
	},
};

const SYSTEM = "You answer from the user's vault. Use search_vault before answering questions about their notes.";
// Deliberately generic: these tests are published to the public mirror, and the
// captured frames get transcribed into the offline fixture verbatim.
const QUESTION = "What did I write about the database migration? Search my notes first.";

/** POST a body, returning status + text so a 400 is reported with its message, not swallowed. */
async function post(body: Record<string, unknown>): Promise<{ status: number; text: string }> {
	const res = await fetch(messagesUrl(BASE_URL), {
		method: "POST",
		headers: anthropicHeaders(process.env.ANTHROPIC_API_KEY),
		body: JSON.stringify(body),
	});
	return { status: res.status, text: await res.text() };
}

function save(name: string, content: string): void {
	mkdirSync(CAPTURES, { recursive: true });
	writeFileSync(join(CAPTURES, name), content, "utf8");
}

describe.skipIf(!LIVE)("Anthropic Messages — live", () => {
	it("accepts the non-streaming body and returns a tool_use we can parse", async () => {
		// Neither temperature nor an effort here: this test POSTs the raw body,
		// bypassing LlmClient, so it has none of the drop-and-retry that makes
		// model-specific rejections survivable — `temperature` on Opus 5/Sonnet 5,
		// `thinking:{type:"disabled"}` on Fable 5. Omitting both keeps this test
		// about the body/parse shape on EVERY model; the recovery paths are
		// covered through the client below.
		const body = buildMessagesBody({
			model: MODEL,
			messages: [
				{ role: "system", content: SYSTEM },
				{ role: "user", content: QUESTION },
			],
			tools,
			maxTokens: 1024,
		});
		const { status, text } = await post(body);
		save("messages-nonstreaming.json", text);
		expect(status, `HTTP ${status}: ${text.slice(0, 600)}`).toBe(200);

		const res = parseMessagesResult(JSON.parse(text));
		expect(res.toolCalls.length, "expected the model to call search_vault").toBeGreaterThan(0);
		expect(res.toolCalls[0].function.name).toBe("search_vault");
		// Arguments must be a JSON STRING here even though Anthropic sends an object.
		expect(() => JSON.parse(res.toolCalls[0].function.arguments)).not.toThrow();
		expect(res.finishReason).toBe("tool_calls");
		expect(res.usage?.promptTokens).toBeGreaterThan(0);
		expect(res.usage?.completionTokens).toBeGreaterThan(0);
	}, 60_000);

	it("streams thinking + a tool call, and the replayed turn is accepted", async () => {
		// --- Turn 1: stream, with thinking ON alongside tools -------------------
		const first = buildMessagesBody({
			model: MODEL,
			messages: [
				{ role: "system", content: SYSTEM },
				{ role: "user", content: QUESTION },
			],
			tools,
			effort: "medium",
			maxTokens: 4096,
		});
		// Guard the premise: this model should be on the adaptive path.
		expect(usesManualThinking(MODEL)).toBe(false);
		expect(first.thinking).toEqual({ type: "adaptive", display: "summarized" });

		const res = await fetch(messagesUrl(BASE_URL), {
			method: "POST",
			headers: { ...anthropicHeaders(process.env.ANTHROPIC_API_KEY), Accept: "text/event-stream" },
			body: JSON.stringify({ ...first, stream: true }),
		});
		const raw = await res.text();
		save("messages-stream.sse", raw);
		expect(res.status, `HTTP ${res.status}: ${raw.slice(0, 600)}`).toBe(200);

		// Decode with the SHARED decoder — Anthropic's `event:` lines are ignored
		// and every payload repeats its own `type`. If that assumption is wrong,
		// the accumulator gets nothing and this fails loudly.
		const decoder = new SseDecoder();
		const acc = new MessagesStreamAccumulator();
		const reasoning: string[] = [];
		const content: string[] = [];
		for (const payload of decoder.feed(raw)) {
			const delta = acc.push(JSON.parse(payload));
			if (delta.reasoning) reasoning.push(delta.reasoning);
			if (delta.content) content.push(delta.content);
		}
		const turn1 = acc.result();

		expect(turn1.toolCalls.length, "expected a streamed tool call").toBeGreaterThan(0);
		expect(turn1.toolCalls[0].function.arguments).not.toBe("{}"); // input_json_delta reassembled
		expect(turn1.finishReason).toBe("tool_calls");
		expect(turn1.usage?.completionTokens).toBeGreaterThan(0);
		if (reasoning.length > 0) {
			// display:"summarized" streamed thinking → the block must carry a signature.
			const block = turn1.reasoningBlocks?.[0]?.data as { type?: string; signature?: string };
			expect(block?.type).toBe("thinking");
			expect(block?.signature, "a streamed thinking block must carry its signature").toBeTruthy();
		}

		// --- Turn 2: replay the assistant turn + tool results -------------------
		// This is the assertion the offline suite cannot make: our reconstructed
		// thinking block (signature and all) has to survive Anthropic's validator.
		//
		// EVERY tool_use must be answered: Anthropic rejects a replay where any id
		// lacks a tool_result in the very next message ("`tool_use` ids were found
		// without `tool_result` blocks immediately after"). Models issue parallel
		// calls, so answering only the first is not a valid conversation — which
		// is exactly what AgentLoop guarantees by running the whole batch.
		const history: ChatMessage[] = [
			{ role: "system", content: SYSTEM },
			{ role: "user", content: QUESTION },
			{
				role: "assistant",
				content: turn1.content,
				tool_calls: turn1.toolCalls,
				...(turn1.reasoningBlocks ? { reasoning_blocks: turn1.reasoningBlocks } : {}),
			},
			...turn1.toolCalls.map(
				(call): ChatMessage => ({
					role: "tool",
					tool_call_id: call.id,
					name: call.function.name,
					content: JSON.stringify({
						results: [
							{ path: "Work/Migration.md", line: 4, score: 0.91, snippet: "Migration moved to Q3; blocked on SSO." },
						],
					}),
				})
			),
		];
		const second = buildMessagesBody({ model: MODEL, messages: history, tools, effort: "medium", maxTokens: 4096 });
		const replay = await post(second);
		save("messages-replay.json", replay.text);
		expect(
			replay.status,
			`replaying the thinking block was REJECTED — HTTP ${replay.status}: ${replay.text.slice(0, 600)}`
		).toBe(200);

		const turn2 = parseMessagesResult(JSON.parse(replay.text));
		expect(turn2.content, "expected a final answer after the tool result").toBeTruthy();
		expect(turn2.finishReason).toBe("stop");
	}, 120_000);

	/**
	 * The wiring, end to end: LlmClient picks the Messages format from the host,
	 * streams over the shared Node `http` core, and AgentLoop runs a real tool
	 * round-trip — including replaying the opaque thinking block it got back.
	 * This is what the pure-function tests above cannot cover.
	 */
	it("runs a full AgentLoop tool round-trip through the wired client", async () => {
		const llm = new LlmClient({
			baseUrl: BASE_URL,
			apiKey: process.env.ANTHROPIC_API_KEY,
			model: MODEL,
			temperature: 0,
			reasoningEffort: "medium", // thinking ON, so the block replay is exercised
		});
		const loop = new AgentLoop(llm, cannedTools, { maxIterations: 4 });

		const events: AgentEvent[] = [];
		const { answer, messages } = await loop.run(
			"What is the capital of France according to my notes? Answer in one sentence with a citation.",
			(e) => events.push(e)
		);

		expect(events.some((e) => e.type === "tool_call"), "no tool was called").toBe(true);
		expect(events.some((e) => e.type === "answer_delta"), "nothing streamed").toBe(true);
		expect(answer.toLowerCase()).toContain("paris");
		expect(answer).toContain("[[Geo/France.md]]"); // used the provided link verbatim

		// The assistant turn carried its signed thinking block forward, and the
		// NEXT request in the run was accepted — the loop completed, so it was.
		const assistantTurn = messages.find((m) => m.role === "assistant" && m.tool_calls?.length);
		if (assistantTurn?.reasoning_blocks) {
			expect(assistantTurn.reasoning_blocks[0].transport).toBe("messages");
		}

		const usage = events.find((e) => e.type === "usage");
		expect(usage && usage.type === "usage" && usage.promptTokens).toBeGreaterThan(0);

		// The footer's numbers, as this provider can actually supply them.
		if (usage?.type === "usage") {
			console.info(
				`[live anthropic] context ${usage.contextTokens}/${usage.maxContextTokens}, ` +
					`out ${usage.completionTokens} (thinking ${usage.reasoningTokens ?? "n/a"}), ` +
					`${usage.tokensPerSecondEstimated ? "~" : ""}${Math.round(usage.tokensPerSecond ?? 0)} tok/s, ` +
					`cached ${usage.cachedTokens ?? 0}`
			);
			// Anthropic reports no speed of its own, so any speed shown here was
			// measured client-side — asserted only when the sample was rateable
			// (a very short answer is legitimately declined rather than guessed).
			if (usage.tokensPerSecond) expect(usage.tokensPerSecondEstimated).toBe(true);
			expect(usage.completionTokens).toBeGreaterThan(0);
		}
	}, 180_000);

	it("recovers from a model-specific parameter rejection through the client", async () => {
		// Lantern's SHIPPED defaults are temperature 0.2 + reasoning off, which on
		// Opus 5 / Sonnet 5 is a hard 400 ("`temperature` is deprecated for this
		// model") — every chat, including the settings-tab test. Anthropic sends no
		// `error.param`, so recovery depends on reading the name out of the prose.
		const llm = new LlmClient({
			baseUrl: BASE_URL,
			apiKey: process.env.ANTHROPIC_API_KEY,
			model: MODEL,
			temperature: 0.2,
			reasoningEffort: "off",
		});

		const res = await llm.chat([{ role: "user", content: "Reply with the single word: OK" }]);
		expect(res.content?.toLowerCase()).toContain("ok");

		// And the lesson sticks: the second call doesn't pay for the 400 again.
		const again = await llm.chat([{ role: "user", content: "Reply with the single word: OK" }]);
		expect(again.content?.toLowerCase()).toContain("ok");
	}, 90_000);

	it("reports an unknown parameter without a `param` field (why learning is gated)", async () => {
		// The premise behind MESSAGES_WIRE.namesRejectedParams === false.
		const { status, text } = await post({
			model: MODEL,
			max_tokens: 16,
			messages: [{ role: "user", content: "hi" }],
			chat_template_kwargs: { enable_thinking: false }, // a llama.cpp-ism
		});
		save("messages-error.json", text);
		expect(status).toBe(400);
		const body = JSON.parse(text) as { type?: string; error?: { type?: string; message?: string; param?: string } };
		expect(body.type).toBe("error");
		expect(body.error?.message).toBeTruthy();
		expect(body.error?.param).toBeUndefined();
	}, 60_000);
});
