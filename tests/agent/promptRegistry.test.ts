import { describe, it, expect } from "vitest";
import {
	PROMPT_DEFS,
	bundledPrompt,
	resolvePrompt,
	missingRequiredPrompts,
	missingPlaceholders,
} from "../../src/agent/promptRegistry";

describe("promptRegistry", () => {
	it("ships the six known prompts, each with a non-empty bundled default", () => {
		expect(PROMPT_DEFS.map((d) => d.id).sort()).toEqual([
			"datetime-context",
			"final-answer",
			"reference-libraries",
			"system",
			"web-search",
			"write-tools",
		]);
		for (const d of PROMPT_DEFS) expect(bundledPrompt(d.id).length).toBeGreaterThan(0);
	});

	it("marks only the system prompt as required", () => {
		expect(PROMPT_DEFS.filter((d) => d.required).map((d) => d.id)).toEqual(["system"]);
	});

	describe("resolvePrompt (overrides-only)", () => {
		it("falls back to the bundled default with no override or a blank one", () => {
			expect(resolvePrompt("system", undefined)).toBe(bundledPrompt("system"));
			expect(resolvePrompt("system", {})).toBe(bundledPrompt("system"));
			expect(resolvePrompt("system", { system: "   " })).toBe(bundledPrompt("system"));
		});
		it("uses a non-blank override, trimmed", () => {
			expect(resolvePrompt("web-search", { "web-search": "  custom text  " })).toBe("custom text");
		});
	});

	describe("missingRequiredPrompts", () => {
		it("is empty in normal use — a blanked required prompt reverts to the (non-empty) bundled default", () => {
			expect(missingRequiredPrompts(undefined)).toEqual([]);
			expect(missingRequiredPrompts({ system: "" })).toEqual([]);
			expect(missingRequiredPrompts({ system: "my own prompt" })).toEqual([]);
		});
	});

	describe("missingPlaceholders", () => {
		it("flags dropped placeholders only for prompts that require them", () => {
			expect(missingPlaceholders("reference-libraries", "no token here")).toEqual(["{{collections}}"]);
			expect(missingPlaceholders("reference-libraries", "lists {{collections}} fine")).toEqual([]);
			expect(missingPlaceholders("datetime-context", "only {{when}} kept")).toEqual(["{{zone}}"]);
			expect(missingPlaceholders("system", "anything goes")).toEqual([]);
		});
	});
});
