import { describe, it, expect } from "vitest";
import {
	deriveContextBudget,
	estimateMessagesChars,
	FALLBACK_CONTEXT_TOKENS,
} from "../../src/agent/contextBudget";

describe("deriveContextBudget", () => {
	it("scales the prompt + compaction budgets with the context size", () => {
		const small = deriveContextBudget(8192);
		const large = deriveContextBudget(32768);
		expect(large.promptChars).toBeGreaterThan(small.promptChars);
		expect(large.compact.maxHistoryChars).toBeGreaterThan(small.compact.maxHistoryChars);
		expect(large.compact.maxMessages).toBeGreaterThanOrEqual(small.compact.maxMessages);
	});

	it("clamps compaction knobs within bounds", () => {
		const tiny = deriveContextBudget(1024);
		expect(tiny.compact.maxToolChars).toBeGreaterThanOrEqual(700);
		expect(tiny.compact.maxMessages).toBeGreaterThanOrEqual(12);
		const huge = deriveContextBudget(1_000_000);
		expect(huge.compact.maxToolChars).toBeLessThanOrEqual(4000);
		expect(huge.compact.maxMessages).toBeLessThanOrEqual(120);
	});

	it("reserves output room (prompt budget below the raw context in chars)", () => {
		const b = deriveContextBudget(32768);
		expect(b.promptChars).toBeLessThan(32768 * 3.5);
	});

	it("uses a custom chars-per-token ratio (falls back on invalid)", () => {
		expect(deriveContextBudget(32768, 5).promptChars).toBeGreaterThan(deriveContextBudget(32768, 3).promptChars);
		expect(deriveContextBudget(32768, 0).promptChars).toBe(deriveContextBudget(32768).promptChars);
	});

	it("falls back for non-positive / non-finite input", () => {
		expect(deriveContextBudget(0).ctxTokens).toBe(FALLBACK_CONTEXT_TOKENS);
		expect(deriveContextBudget(-5).ctxTokens).toBe(FALLBACK_CONTEXT_TOKENS);
		expect(deriveContextBudget(NaN).ctxTokens).toBe(FALLBACK_CONTEXT_TOKENS);
	});
});

describe("estimateMessagesChars", () => {
	it("counts content, reasoning, tool calls, and per-message overhead", () => {
		expect(estimateMessagesChars([{ content: "hello" }])).toBe(16 + 5);
		expect(estimateMessagesChars([{ content: "hi", reasoning_content: "think" }])).toBe(16 + 2 + 5);
		expect(estimateMessagesChars([])).toBe(0);
	});
});
