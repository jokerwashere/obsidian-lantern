/**
 * LIVE end-to-end test of the streaming agent stack against a real local LLM
 * server. Skipped unless LANTERN_LIVE=1 (it generates real tokens).
 *
 *   LANTERN_LIVE=1 npx vitest run tests/live/agentLive.test.ts
 *
 * Exercises, against the actual server: SSE streaming, tool-call delta
 * accumulation, tool-result feedback, reasoning suppression (effort off),
 * and the final streamed answer.
 */
import { describe, it, expect } from "vitest";
import { AgentLoop, type AgentEvent } from "../../src/agent/AgentLoop";
import { LlmClient } from "../../src/agent/LlmClient";
import type { ToolRegistry } from "../../src/agent/tools";

const LIVE = process.env.LANTERN_LIVE === "1";
const BASE_URL = process.env.LANTERN_LLM_URL ?? "http://localhost:8080/v1";
/** Optional explicit model (else Lantern's resident-first auto-resolution). */
const MODEL = process.env.LANTERN_LLM_MODEL || undefined;
/** Optional Bearer key — llama-server started with `--api-key` requires one. */
const API_KEY = process.env.LANTERN_LLM_KEY || process.env.LLAMACPP_API_KEY || undefined;

const cannedTools: ToolRegistry = {
	search_vault: {
		def: {
			type: "function",
			function: {
				name: "search_vault",
				description: "Search the user's notes. Returns ranked results with paths.",
				parameters: {
					type: "object",
					properties: { query: { type: "string" } },
					required: ["query"],
				},
			},
		},
		// Real JSON-with-link shape: the result hands the model a ready `link`.
		execute: async () =>
			JSON.stringify({
				query: "capital of France",
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
				parameters: {
					type: "object",
					properties: { path: { type: "string" } },
					required: ["path"],
				},
			},
		},
		execute: async () =>
			"File: path=\"Geo/France.md\" (2 lines) link=[[Geo/France.md]]\n1: # France\n2: The capital of France is Paris.",
	},
};

describe.skipIf(!LIVE)("LIVE agent loop against the local LLM", () => {
	it(
		"streams a grounded, cited answer through a real tool round-trip",
		{ timeout: 300_000 }, // generous: a router-mode server may cold-load the model
		async () => {
			const llm = new LlmClient({
				baseUrl: BASE_URL,
				apiKey: API_KEY,
				model: MODEL,
				temperature: 0,
				reasoningEffort: "off",
			});
			const loop = new AgentLoop(llm, cannedTools, { maxIterations: 4 });

			const events: AgentEvent[] = [];
			const { answer } = await loop.run(
				"What is the capital of France according to my notes? Answer in one sentence with a citation.",
				(e) => events.push(e)
			);

			// The model used at least one tool, streamed deltas, and answered.
			expect(events.some((e) => e.type === "tool_call")).toBe(true);
			expect(events.some((e) => e.type === "answer_delta")).toBe(true);
			expect(answer.toLowerCase()).toContain("paris");
			expect(answer).not.toMatch(/<think/i);
			// It pasted the provided `link` verbatim rather than inventing one.
			expect(answer).toContain("[[Geo/France.md]]");

			const usage = events.find((e) => e.type === "usage");
			if (usage?.type === "usage") {
				console.info(
					`[live local] context ${usage.contextTokens}/${usage.maxContextTokens}, ` +
						`out ${usage.completionTokens}, ` +
						`${usage.tokensPerSecondEstimated ? "~" : ""}${Math.round(usage.tokensPerSecond ?? 0)} tok/s, ` +
						`cached ${usage.cachedTokens ?? 0}`
				);
				// llama.cpp reports its OWN speed — it must not be overwritten by ours.
				expect(usage.tokensPerSecond).toBeGreaterThan(0);
				expect(usage.tokensPerSecondEstimated).toBeUndefined();
			}
		}
	);
});

/**
 * The "don't break local" guarantee, made explicit.
 *
 * Everything the wire-format seam touches — auth headers, URL, body shape,
 * /props detection, the model catalog — must behave on a real llama-server
 * exactly as it did before hosted providers existed. Offline tests assert the
 * shape; only this asserts the server agrees.
 */
describe.skipIf(!LIVE)("LIVE local server plumbing", () => {
	const client = (effort: "off" | "medium" = "off") =>
		new LlmClient({ baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL, temperature: 0, reasoningEffort: effort });

	it("still routes to /v1/chat/completions with a Bearer key", async () => {
		// A local host must never be pulled onto another wire format.
		const res = await client().chat([{ role: "user", content: "Reply with the single word: OK" }]);
		expect(res.content?.toLowerCase()).toContain("ok");
	}, 120_000);

	it("detects the real context window (llama.cpp /props, or router launch args)", async () => {
		const ctx = await client().getContextSize();
		// Null would mean detection broke and every budget silently fell back to
		// the 8k guess — the failure mode this probe exists to prevent.
		expect(ctx, "context detection returned null against a live llama-server").not.toBeNull();
		expect(ctx).toBeGreaterThan(0);
		console.info(`[live] detected context: ${ctx} tokens`);
	}, 60_000);

	it("lists served models with load state for the settings picker", async () => {
		const models = await client().listModelStatuses();
		expect(models.length).toBeGreaterThan(0);
		if (MODEL) expect(models.map((m) => m.id)).toContain(MODEL);
		console.info(`[live] models: ${models.map((m) => `${m.id} [${m.state}]`).join(", ")}`);
	}, 60_000);

	it("accepts the llama.cpp reasoning controls when thinking is on", async () => {
		// chat_template_kwargs + thinking_budget_tokens + reasoning_control go out
		// on every thinking request. A template that rejects them would 400 here.
		const res = await client("medium").chat([{ role: "user", content: "Reply with the single word: OK" }]);
		expect(res.content !== null || res.reasoning !== null).toBe(true);
	}, 120_000);
});
