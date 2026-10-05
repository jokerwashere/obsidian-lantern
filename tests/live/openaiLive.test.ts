/**
 * LIVE verification of the OpenAI chat-completions path against api.openai.com.
 * Skipped unless LANTERN_LIVE_OPENAI=1 (it spends real tokens — small prompts,
 * capped output, a few cents at most).
 *
 *   OPENAI_API_KEY=sk-… LANTERN_LIVE_OPENAI=1 \
 *     npx vitest run tests/live/openaiLive.test.ts
 *
 * Optional: LANTERN_OPENAI_REASONING_MODEL (default gpt-5.6-luna),
 *           LANTERN_OPENAI_CHAT_MODEL      (default gpt-4o-mini).
 *
 * This is the regression suite for the bug that started the whole hosted-API
 * effort: Lantern sent llama.cpp's reasoning controls unconditionally, and
 * OpenAI 400s on the first unknown key. Each test below maps to one failure
 * that actually happened.
 */
import { describe, it, expect } from "vitest";
import { AgentLoop, type AgentEvent } from "../../src/agent/AgentLoop";
import { LlmClient, type ToolDef } from "../../src/agent/LlmClient";
import type { ToolRegistry } from "../../src/agent/tools";

const LIVE = process.env.LANTERN_LIVE_OPENAI === "1" && Boolean(process.env.OPENAI_API_KEY);
const BASE_URL = "https://api.openai.com/v1";
const REASONING_MODEL = process.env.LANTERN_OPENAI_REASONING_MODEL ?? "gpt-5.6-luna";
const CHAT_MODEL = process.env.LANTERN_OPENAI_CHAT_MODEL ?? "gpt-4o-mini";

const searchTool: ToolDef = {
	type: "function",
	function: {
		name: "search_vault",
		description: "Search the user's notes. Returns ranked results with paths.",
		parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
	},
};

const cannedTools: ToolRegistry = {
	search_vault: {
		def: searchTool,
		execute: async () =>
			JSON.stringify({
				results: [
					{ path: "Geo/France.md", line: 2, score: 0.99, snippet: "The capital of France is Paris.", link: "[[Geo/France.md]]" },
				],
			}),
	},
};

const client = (model: string, effort: "off" | "low" | "medium" | "high") =>
	new LlmClient({ baseUrl: BASE_URL, apiKey: process.env.OPENAI_API_KEY, model, temperature: 0.2, reasoningEffort: effort });

const ASK = [{ role: "user" as const, content: "Say the single word: OK" }];

describe.skipIf(!LIVE)("OpenAI chat completions — live", () => {
	it("no longer 400s on chat_template_kwargs (the original bug)", async () => {
		// Before the dialect layer: HTTP 400 "Unknown parameter:
		// 'chat_template_kwargs'." on the very first request, reasoning off.
		const res = await client(CHAT_MODEL, "off").chat(ASK);
		expect(res.content?.toLowerCase()).toContain("ok");
	}, 60_000);

	it("sends a reasoning model a body it accepts with function tools", async () => {
		// The second bug: "Function tools with reasoning_effort are not supported
		// for <model> … set reasoning_effort to 'none'." Effort off now maps to an
		// explicit reasoning_effort:"none", so this must pass on the FIRST try.
		const res = await client(REASONING_MODEL, "off").chat(ASK, [searchTool]);
		expect(res.content !== null || res.toolCalls.length > 0).toBe(true);
	}, 90_000);

	it("recovers when reasoning IS requested alongside tools", async () => {
		// Effort medium + tools is rejected by gpt-5.x; the learning layer must
		// read "set reasoning_effort to 'none'" from the 400 and retry.
		const llm = client(REASONING_MODEL, "medium");
		const res = await llm.chat(ASK, [searchTool]);
		expect(res.content !== null || res.toolCalls.length > 0).toBe(true);

		// The lesson stuck: a second question does not pay for the 400 again.
		const again = await llm.chat(ASK, [searchTool]);
		expect(again.content !== null || again.toolCalls.length > 0).toBe(true);
	}, 120_000);

	it("streams a full AgentLoop tool round-trip", async () => {
		const llm = client(REASONING_MODEL, "off");
		const loop = new AgentLoop(llm, cannedTools, { maxIterations: 4 });

		const events: AgentEvent[] = [];
		const { answer } = await loop.run(
			"What is the capital of France according to my notes? Answer in one sentence with a citation.",
			(e) => events.push(e)
		);

		expect(events.some((e) => e.type === "tool_call"), "no tool was called").toBe(true);
		expect(events.some((e) => e.type === "answer_delta"), "nothing streamed").toBe(true);
		expect(answer.toLowerCase()).toContain("paris");
		const usage = events.find((e) => e.type === "usage");
		expect(usage && usage.type === "usage" && usage.promptTokens).toBeGreaterThan(0);

		if (usage?.type === "usage") {
			console.info(
				`[live openai] context ${usage.contextTokens}/${usage.maxContextTokens}, ` +
					`out ${usage.completionTokens} (reasoning ${usage.reasoningTokens ?? "n/a"}), ` +
					`${usage.tokensPerSecondEstimated ? "~" : ""}${Math.round(usage.tokensPerSecond ?? 0)} tok/s, ` +
					`cached ${usage.cachedTokens ?? 0}`
			);
			// A one-sentence answer can arrive in a single sub-100ms burst, which is
			// too thin to rate — declining is correct, so presence isn't asserted.
			// What IS invariant: a speed shown here was measured, never invented.
			if (usage.tokensPerSecond) expect(usage.tokensPerSecondEstimated).toBe(true);
		}
	}, 180_000);

	it("measures generation speed once the stream is long enough to rate", async () => {
		// The deterministic half of the above: a long generation always clears the
		// sample floors, so a missing speed here would mean measurement is broken.
		const deltas: string[] = [];
		const res = await client(CHAT_MODEL, "off").chat(
			[{ role: "user", content: "Count from 1 to 60, comma separated. No other text." }],
			undefined,
			{ onDelta: (d) => d.content && deltas.push(d.content) }
		);

		expect(deltas.length).toBeGreaterThan(10); // genuinely streamed
		expect(res.usage?.completionTokens ?? 0).toBeGreaterThan(20);
		expect(res.usage?.tokensPerSecond, "a long stream must yield a measured rate").toBeGreaterThan(0);
		expect(res.usage?.tokensPerSecondEstimated).toBe(true);
		console.info(`[live openai] measured ${Math.round(res.usage?.tokensPerSecond ?? 0)} tok/s over ${deltas.length} deltas`);
	}, 120_000);

	it("reads the model list the settings picker uses", async () => {
		const models = await client(CHAT_MODEL, "off").listModels();
		expect(models).toContain(CHAT_MODEL);
	}, 60_000);
});
