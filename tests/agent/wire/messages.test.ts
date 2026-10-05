/**
 * Anthropic Messages wire format.
 *
 * Fixtures come from two grounded sources, never memory: Anthropic's published
 * SSE captures (docs: "Streaming messages"), and — at the bottom — a REAL turn
 * captured from api.anthropic.com against claude-sonnet-4-6,
 * whose thinking block was replayed back to the API and accepted. Same
 * discipline as stream.ts, which was grounded against a live llama-server probe.
 * Re-run the live check with tests/live/messagesLive.test.ts.
 */
import { describe, it, expect } from "vitest";
import type { ChatMessage, ToolDef } from "../../../src/agent/LlmClient";
import { WireStreamError } from "../../../src/agent/wire/types";
import {
	MESSAGES_WIRE,
	MessagesStreamAccumulator,
	anthropicHeaders,
	anthropicModelsUrl,
	buildMessagesBody,
	mapStopReason,
	messagesUrl,
	parseAnthropicModels,
	parseMessagesResult,
	thinkingFor,
	toAnthropicMessages,
	toAnthropicTools,
	toChatUsage,
	usesManualThinking,
	CLAUDE_CONTEXT_TOKENS,
} from "../../../src/agent/wire/messages";

const tools: ToolDef[] = [
	{
		type: "function",
		function: {
			name: "search_vault",
			description: "Search the vault.",
			parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		},
	},
];

describe("urls and headers", () => {
	it("targets /messages and /models under the base URL", () => {
		expect(messagesUrl("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com/v1/messages");
		expect(messagesUrl("https://api.anthropic.com/v1/")).toBe("https://api.anthropic.com/v1/messages");
		expect(anthropicModelsUrl("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com/v1/models");
	});

	it("authenticates with x-api-key + anthropic-version, never Bearer", () => {
		const headers = anthropicHeaders("sk-ant-xxx");
		expect(headers["x-api-key"]).toBe("sk-ant-xxx");
		expect(headers["anthropic-version"]).toBe("2023-06-01");
		expect(headers["Authorization"]).toBeUndefined();
		// No key configured → no auth header at all (the request 401s honestly).
		expect(anthropicHeaders()["x-api-key"]).toBeUndefined();
	});
});

describe("toAnthropicTools", () => {
	it("flattens to name/description/input_schema", () => {
		expect(toAnthropicTools(tools)).toEqual([
			{
				name: "search_vault",
				description: "Search the vault.",
				input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
			},
		]);
	});
});

describe("toAnthropicMessages", () => {
	it("lifts system messages out of the array", () => {
		const { system, messages } = toAnthropicMessages([
			{ role: "system", content: "You are Lantern." },
			{ role: "user", content: "hi" },
		]);
		expect(system).toBe("You are Lantern.");
		expect(messages).toEqual([{ role: "user", content: "hi" }]);
	});

	it("collapses a run of tool results into ONE user message", () => {
		// The structural difference from chat completions: there is no tool role.
		const history: ChatMessage[] = [
			{ role: "user", content: "q" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "toolu_1", type: "function", function: { name: "search_vault", arguments: '{"query":"a"}' } },
					{ id: "toolu_2", type: "function", function: { name: "read_vault", arguments: '{"path":"b.md"}' } },
				],
			},
			{ role: "tool", tool_call_id: "toolu_1", name: "search_vault", content: "hit" },
			{ role: "tool", tool_call_id: "toolu_2", name: "read_vault", content: "body" },
			{ role: "assistant", content: "answer" },
		];
		const { messages } = toAnthropicMessages(history);

		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(messages[1].content).toEqual([
			{ type: "tool_use", id: "toolu_1", name: "search_vault", input: { query: "a" } },
			{ type: "tool_use", id: "toolu_2", name: "read_vault", input: { path: "b.md" } },
		]);
		expect(messages[2].content).toEqual([
			{ type: "tool_result", tool_use_id: "toolu_1", content: "hit" },
			{ type: "tool_result", tool_use_id: "toolu_2", content: "body" },
		]);
	});

	it("replays its OWN thinking blocks first, and ignores another transport's", () => {
		const { messages } = toAnthropicMessages([
			{ role: "user", content: "q" },
			{
				role: "assistant",
				content: "text after thinking",
				reasoning_blocks: [
					{ transport: "messages", data: { type: "thinking", thinking: "hmm", signature: "EqQBCg…" } },
					// An OpenAI encrypted item would be rejected here — must be skipped.
					{ transport: "responses", data: { type: "reasoning", encrypted_content: "gAAAAABo…" } },
				],
			},
		]);
		expect(messages[1].content).toEqual([
			{ type: "thinking", thinking: "hmm", signature: "EqQBCg…" },
			{ type: "text", text: "text after thinking" },
		]);
	});

	it("never emits an empty content array", () => {
		const { messages } = toAnthropicMessages([
			{ role: "user", content: "q" },
			{ role: "assistant", content: "" },
		]);
		expect(messages).toHaveLength(1);
	});
});

describe("usesManualThinking", () => {
	it("classifies real model ids across both naming schemes", () => {
		// ≤ 4.5 → manual only ({type:"adaptive"} 400s there).
		for (const id of [
			"claude-3-5-sonnet-20241022",
			"claude-3-opus-20240229",
			"claude-sonnet-4-20250514",
			"claude-opus-4-1-20250805",
			"claude-sonnet-4-5-20250929",
			"claude-opus-4-5",
			"claude-haiku-4-5",
		]) {
			expect({ id, manual: usesManualThinking(id) }).toEqual({ id, manual: true });
		}
		// 4.6+ → adaptive (and 4.7+ rejects {type:"enabled"} outright).
		for (const id of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-5", "claude-sonnet-5", "claude-fable-5"]) {
			expect({ id, manual: usesManualThinking(id) }).toEqual({ id, manual: false });
		}
	});

	it("assumes current behavior for unversioned ids", () => {
		expect(usesManualThinking("claude-mythos-preview")).toBe(false);
	});
});

describe("thinkingFor", () => {
	it("maps effort to adaptive + output_config on current models", () => {
		expect(thinkingFor("claude-opus-5", "high", 16384)).toEqual({
			thinking: { type: "adaptive", display: "summarized" },
			output_config: { effort: "high" },
		});
	});

	it("uses manual budgets on 4.5-and-earlier, where adaptive 400s", () => {
		const cfg = thinkingFor("claude-sonnet-4-5", "medium", 16384);
		expect(cfg.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
		expect(cfg.output_config).toBeUndefined();
	});

	it("keeps the manual budget under max_tokens and above the 1024 floor", () => {
		const cfg = thinkingFor("claude-sonnet-4-5", "high", 2048);
		expect(cfg.thinking).toEqual({ type: "enabled", budget_tokens: 1228 }); // 60% of max_tokens
		expect(thinkingFor("claude-sonnet-4-5", "high", 100).thinking).toEqual({
			type: "enabled",
			budget_tokens: 1024, // never below the API minimum
		});
	});

	it("disables thinking for 'off' and sends nothing when unset", () => {
		expect(thinkingFor("claude-opus-5", "off", 4096)).toEqual({ thinking: { type: "disabled" } });
		expect(thinkingFor("claude-opus-5", undefined, 4096)).toEqual({});
	});
});

describe("buildMessagesBody", () => {
	const base = {
		model: "claude-opus-5",
		messages: [
			{ role: "system" as const, content: "sys" },
			{ role: "user" as const, content: "q" },
		],
		maxTokens: 8192,
	};

	it("always sends max_tokens — the API requires it", () => {
		expect(buildMessagesBody(base).max_tokens).toBe(8192);
	});

	it("sends system separately and tools with tool_choice auto", () => {
		const body = buildMessagesBody({ ...base, tools });
		expect(body.system).toBe("sys");
		expect(body.tool_choice).toEqual({ type: "auto" });
		expect((body.tools as unknown[])[0]).toMatchObject({ name: "search_vault" });
		expect(body.messages).toEqual([{ role: "user", content: "q" }]);
	});

	it("clamps temperature into Anthropic's 0–1 range when thinking is off", () => {
		expect(buildMessagesBody({ ...base, effort: "off", temperature: 1.8 }).temperature).toBe(1);
		expect(buildMessagesBody({ ...base, effort: "off", temperature: 0.2 }).temperature).toBe(0.2);
	});

	it("omits temperature whenever thinking is on — the API 400s otherwise", () => {
		// Live: "`temperature` may only be set to 1 when thinking is enabled or in
		// adaptive mode". Also omitted when `thinking` is unset, since Claude 5
		// thinks by default and the same rule applies.
		expect(buildMessagesBody({ ...base, effort: "medium", temperature: 0 }).temperature).toBeUndefined();
		expect(buildMessagesBody({ ...base, model: "claude-sonnet-4-5", effort: "high", temperature: 0 }).temperature).toBeUndefined();
		expect(buildMessagesBody({ ...base, temperature: 0.2 }).temperature).toBeUndefined();
	});

	it("carries no chat-completions or Responses params", () => {
		const body = buildMessagesBody({ ...base, tools, effort: "medium", temperature: 0.2 });
		for (const param of [
			"chat_template_kwargs",
			"reasoning_effort",
			"thinking_budget_tokens",
			"max_completion_tokens",
			"store",
			"input",
			"instructions",
		]) {
			expect(body[param]).toBeUndefined();
		}
	});
});

describe("parseMessagesResult", () => {
	it("splits text, thinking and tool_use out of the content array", () => {
		const res = parseMessagesResult({
			content: [
				{ type: "thinking", thinking: "Let me search.", signature: "EqQBCg…" },
				{ type: "text", text: "Looking now." },
				{ type: "tool_use", id: "toolu_1", name: "search_vault", input: { query: "a" } },
			],
			stop_reason: "tool_use",
			usage: { input_tokens: 100, output_tokens: 20 },
		});

		expect(res.content).toBe("Looking now.");
		expect(res.reasoning).toBe("Let me search.");
		expect(res.toolCalls).toEqual([
			{ id: "toolu_1", type: "function", function: { name: "search_vault", arguments: '{"query":"a"}' } },
		]);
		expect(res.finishReason).toBe("tool_calls");
		// The signed block round-trips untouched, tagged with its transport.
		expect(res.reasoningBlocks).toEqual([
			{ transport: "messages", data: { type: "thinking", thinking: "Let me search.", signature: "EqQBCg…" } },
		]);
	});

	it("keeps redacted thinking replayable even though it has no text", () => {
		const res = parseMessagesResult({ content: [{ type: "redacted_thinking", data: "AAAA…" }] });
		expect(res.reasoning).toBeNull();
		expect(res.reasoningBlocks).toEqual([{ transport: "messages", data: { type: "redacted_thinking", data: "AAAA…" } }]);
	});

	it("ignores block types it doesn't model", () => {
		const res = parseMessagesResult({
			content: [{ type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] }, { type: "text", text: "hi" }],
		});
		expect(res.content).toBe("hi");
		expect(res.toolCalls).toEqual([]);
	});
});

describe("mapStopReason", () => {
	it("maps to the finish reasons the rest of Lantern reads", () => {
		expect(mapStopReason("max_tokens")).toBe("length");
		expect(mapStopReason("tool_use")).toBe("tool_calls");
		expect(mapStopReason("end_turn")).toBe("stop");
		expect(mapStopReason("stop_sequence")).toBe("stop");
	});

	it("passes through reasons that have no equivalent rather than inventing one", () => {
		expect(mapStopReason("refusal")).toBe("refusal");
		expect(mapStopReason("model_context_window_exceeded")).toBe("model_context_window_exceeded");
		expect(mapStopReason(null)).toBeNull();
	});
});

describe("toChatUsage", () => {
	it("counts cache reads as prompt tokens — input_tokens excludes them", () => {
		const usage = toChatUsage({
			input_tokens: 100,
			output_tokens: 50,
			cache_read_input_tokens: 900,
			cache_creation_input_tokens: 0,
		});
		expect(usage).toEqual({
			promptTokens: 1000,
			completionTokens: 50,
			totalTokens: 1050,
			contextTokens: 1050,
			cachedTokens: 900,
		});
	});

	it("surfaces the thinking split so billed-but-unseen output is visible", () => {
		const usage = toChatUsage({ input_tokens: 621, output_tokens: 126, output_tokens_details: { thinking_tokens: 28 } });
		expect(usage?.completionTokens).toBe(126);
		expect(usage?.reasoningTokens).toBe(28);
	});

	it("is undefined when the server reported nothing", () => {
		expect(toChatUsage(undefined)).toBeUndefined();
		expect(toChatUsage({})).toBeUndefined();
	});
});

describe("MessagesStreamAccumulator", () => {
	/** Feed Anthropic's documented event sequence, payload by payload. */
	const feed = (acc: MessagesStreamAccumulator, events: unknown[]): string[] => {
		const seen: string[] = [];
		for (const e of events) {
			const delta = acc.push(e);
			if (delta.content) seen.push(delta.content);
		}
		return seen;
	};

	it("accumulates the documented text stream", () => {
		const acc = new MessagesStreamAccumulator();
		const content = feed(acc, [
			{ type: "message_start", message: { id: "msg_1", role: "assistant", content: [], usage: { input_tokens: 25, output_tokens: 1 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "ping" },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 15 } },
			{ type: "message_stop" },
		]);

		expect(content).toEqual(["Hello", "!"]);
		const res = acc.result();
		expect(res.content).toBe("Hello!");
		expect(res.finishReason).toBe("stop");
		// message_delta usage is CUMULATIVE — 15, not 1 + 15.
		expect(res.usage?.completionTokens).toBe(15);
		expect(res.usage?.promptTokens).toBe(25);
	});

	it("reassembles a tool call from partial_json fragments", () => {
		const acc = new MessagesStreamAccumulator();
		feed(acc, [
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Okay, checking:" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01T1", name: "get_weather", input: {} } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"location":' } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' "San' } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: " Francisc" } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "o," } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' CA"}' } },
			{ type: "content_block_stop", index: 1 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 89 } },
			{ type: "message_stop" },
		]);

		const res = acc.result();
		expect(res.content).toBe("Okay, checking:");
		expect(res.toolCalls).toEqual([
			{ id: "toolu_01T1", type: "function", function: { name: "get_weather", arguments: '{"location": "San Francisco, CA"}' } },
		]);
		expect(res.finishReason).toBe("tool_calls");
	});

	it("streams thinking deltas and captures the trailing signature", () => {
		const acc = new MessagesStreamAccumulator();
		const reasoning: string[] = [];
		for (const e of [
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "GCD of 1071 and 462." } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "\n462 = 3 × 147 + 21" } },
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pki" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "It's **21**." } },
			{ type: "content_block_stop", index: 1 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" } },
			{ type: "message_stop" },
		]) {
			const d = acc.push(e);
			if (d.reasoning) reasoning.push(d.reasoning);
		}

		expect(reasoning).toEqual(["GCD of 1071 and 462.", "\n462 = 3 × 147 + 21"]);
		const res = acc.result();
		expect(res.content).toBe("It's **21**.");
		expect(res.reasoning).toBe("GCD of 1071 and 462.\n462 = 3 × 147 + 21");
		// Rebuilt WITH the signature, which only exists after its own delta.
		expect(res.reasoningBlocks).toEqual([
			{
				transport: "messages",
				data: {
					type: "thinking",
					thinking: "GCD of 1071 and 462.\n462 = 3 × 147 + 21",
					signature: "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pki",
				},
			},
		]);
	});

	it("throws on an error event delivered inside a 200 stream", () => {
		const acc = new MessagesStreamAccumulator();
		expect(() =>
			acc.push({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })
		).toThrow(WireStreamError);
	});

	it("ignores unknown event types (the versioning policy requires it)", () => {
		const acc = new MessagesStreamAccumulator();
		expect(() => acc.push({ type: "some_future_event", index: 9 })).not.toThrow();
		expect(acc.push({ type: "content_block_delta", index: 42, delta: { type: "text_delta", text: "x" } })).toEqual({});
	});
});

/**
/**
 * Replay of a REAL captured turn (claude-sonnet-4-6, thinking + text + tool
 * call). Kept verbatim, field noise included, because the live run surfaced
 * things the docs never showed: `caller` on tool_use blocks, `stop_details`,
 * `cache_creation`/`service_tier`/`inference_geo` in usage,
 * `output_tokens_details.thinking_tokens`, whitespace padding inside each data
 * payload, and `input_tokens` REPEATED on message_delta (cumulative, so it must
 * be assigned rather than added). Raw capture: tests/live/captures/ (gitignored).
 */
describe("MessagesStreamAccumulator — live capture replay", () => {
	// The exact fragments Anthropic sent: split mid-word and mid-string, which is
	// the whole reason tool arguments can't be parsed until the block closes.
	const FRAGMENTS = [
		"",
		'{"',
		"quer",
		'y": "data',
		"base migrat",
		'ion"',
		', "keywords"',
		': ["database',
		'","migrat',
		"ion",
		'"]}',
	];

	const THINKING = "Let me search the user's vault for notes about database migration.";
	const SIGNATURE = "ErECCosBCBAYAipAL2UG0HmKLaaZcRGZK8iOFX8KtEEKuglIcygQkOgdtZW8eD9YCebsNLCHoKlg";

	const CAPTURE: unknown[] = [
		{
			type: "message_start",
			message: {
				model: "claude-sonnet-4-6",
				id: "msg_011CdkBDH5jD1kXKpKNDAS44",
				type: "message",
				role: "assistant",
				content: [],
				stop_reason: null,
				stop_details: null,
				usage: {
					input_tokens: 618,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
					output_tokens: 7,
					service_tier: "standard",
					inference_geo: "global",
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		{ type: "ping" },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: THINKING } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: SIGNATURE } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Sure! Let me search your notes for that" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " right away." } },
		{ type: "content_block_stop", index: 1 },
		{
			type: "content_block_start",
			index: 2,
			// `caller` is undocumented in the streaming guide but real — must be ignored.
			content_block: { type: "tool_use", id: "toolu_01EhNZXCAf4gcysJ71jvTkBV", name: "search_vault", input: {}, caller: { type: "direct" } },
		},
		...FRAGMENTS.map((partial_json) => ({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json } })),
		{ type: "content_block_stop", index: 2 },
		{
			type: "message_delta",
			delta: { stop_reason: "tool_use", stop_sequence: null, stop_details: null },
			usage: {
				input_tokens: 618,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				output_tokens: 117,
				output_tokens_details: { thinking_tokens: 25 },
			},
		},
		{ type: "message_stop" },
	];

	it("reproduces the captured turn exactly", () => {
		const acc = new MessagesStreamAccumulator();
		const reasoning: string[] = [];
		const content: string[] = [];
		for (const event of CAPTURE) {
			const delta = acc.push(event);
			if (delta.reasoning) reasoning.push(delta.reasoning);
			if (delta.content) content.push(delta.content);
		}
		const res = acc.result();

		expect(content.join("")).toBe("Sure! Let me search your notes for that right away.");
		expect(reasoning.join("")).toBe(THINKING);
		expect(res.toolCalls).toEqual([
			{
				id: "toolu_01EhNZXCAf4gcysJ71jvTkBV",
				type: "function",
				function: { name: "search_vault", arguments: '{"query": "database migration", "keywords": ["database","migration"]}' },
			},
		]);
		// Reassembled arguments must be parseable — the fragments split mid-string.
		expect(JSON.parse(res.toolCalls[0].function.arguments)).toEqual({
			query: "database migration",
			keywords: ["database", "migration"],
		});
		expect(res.finishReason).toBe("tool_calls");
		// This exact block (signature included) was replayed to the API and ACCEPTED.
		expect(res.reasoningBlocks).toEqual([
			{ transport: "messages", data: { type: "thinking", thinking: THINKING, signature: SIGNATURE } },
		]);
		// Cumulative, not additive: 117, not 7 + 117.
		expect(res.usage?.completionTokens).toBe(117);
		expect(res.usage?.promptTokens).toBe(618);
		// The thinking split the provider reported.
		expect(res.usage?.reasoningTokens).toBe(25);
	});
});


describe("parseAnthropicModels", () => {
	it("reads the model list; no load state is reported", () => {
		expect(parseAnthropicModels({ data: [{ id: "claude-opus-5" }, { id: "claude-sonnet-4-6" }, {}] })).toEqual({
			served: [
				{ id: "claude-opus-5", state: "unknown" },
				{ id: "claude-sonnet-4-6", state: "unknown" },
			],
			resident: [],
		});
	});
});

describe("MESSAGES_WIRE", () => {
	it("declares its errors learnable — Anthropic names the param in prose", () => {
		// Reversed from the original design after live 400s showed the key IS
		// identifiable ("`temperature` is deprecated for this model."), and that
		// without drop-and-retry, Opus 5 / Sonnet 5 / Fable 5 are simply unusable.
		expect(MESSAGES_WIRE.namesRejectedParams).toBe(true);
		expect(MESSAGES_WIRE.id).toBe("messages");
		expect(MESSAGES_WIRE.fallbackContextTokens()).toBe(CLAUDE_CONTEXT_TOKENS);
	});

	it("protects the params that have no valid absence", () => {
		// A 400 naming max_tokens must never be "fixed" by removing it.
		for (const p of ["max_tokens", "messages", "model"]) {
			expect(MESSAGES_WIRE.requiredParams?.has(p)).toBe(true);
		}
	});

	it("sends no stream_options — that is an OpenAI-ism Anthropic rejects", () => {
		expect(MESSAGES_WIRE.streamParams).toBeUndefined();
	});
});
