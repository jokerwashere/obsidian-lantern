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
	read_file: {
		def: {
			type: "function",
			function: {
				name: "read_file",
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
			const llm = new LlmClient({ baseUrl: BASE_URL, model: MODEL, temperature: 0, reasoningEffort: "off" });
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
		}
	);
});
