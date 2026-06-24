/**
 * Registry of the agent's bundled prompts and the user-override resolution that
 * makes them tunable from settings.
 *
 * Storage model (overrides-only): settings persist ONLY what the user changes.
 * A blank/absent override means "use the bundled default", resolved at runtime —
 * so an untouched prompt automatically tracks future improvements to the shipped
 * `.md`, and "reset" is simply "clear the override". Effective prompts are
 * therefore never empty (the bundled defaults are non-empty), and the settings
 * editor shows the bundled text whenever there is no override.
 *
 * The bundled `.md` files are inlined at build by esbuild's text loader.
 */

import systemPrompt from "./prompts/system.md";
import webSearchPrompt from "./prompts/web-search.md";
import writeToolsPrompt from "./prompts/write-tools.md";
import referenceLibrariesPrompt from "./prompts/reference-libraries.md";
import datetimeContextPrompt from "./prompts/datetime-context.md";
import finalAnswerPrompt from "./prompts/final-answer.md";

export type PromptId =
	| "system"
	| "web-search"
	| "write-tools"
	| "reference-libraries"
	| "datetime-context"
	| "final-answer";

export interface PromptDef {
	id: PromptId;
	label: string;
	/** Shown under the editor to explain what the prompt does + when it applies. */
	description: string;
	/** Refuse chat when the effective value is blank (only the core system prompt). */
	required: boolean;
	/** Placeholders that must survive an edit; warned (non-fatally) if dropped. */
	placeholders: string[];
	/** The trimmed bundled default (the shipped `.md`). */
	bundled: string;
}

export const PROMPT_DEFS: PromptDef[] = [
	{
		id: "system",
		label: "System prompt",
		description:
			"The core instructions: how the agent searches, reads, grounds answers, and cites. Always in effect. A System prompt note, if set, overrides this.",
		required: true,
		placeholders: [],
		bundled: systemPrompt.trim(),
	},
	{
		id: "web-search",
		label: "Web-search appendix",
		description: "Appended to the system prompt only when Web search is enabled — teaches how and when to use web_search.",
		required: false,
		placeholders: [],
		bundled: webSearchPrompt.trim(),
	},
	{
		id: "write-tools",
		label: "Write-tools appendix",
		description: "Appended only when Write tools are enabled — teaches the gated create_note / append_to_daily_note behavior.",
		required: false,
		placeholders: [],
		bundled: writeToolsPrompt.trim(),
	},
	{
		id: "reference-libraries",
		label: "Reference-libraries appendix",
		description:
			"Appended only when reference libraries are configured — teaches search_references / read_reference. Keep {{collections}}: the enabled libraries are substituted in.",
		required: false,
		placeholders: ["{{collections}}"],
		bundled: referenceLibrariesPrompt.trim(),
	},
	{
		id: "datetime-context",
		label: "Date / time context",
		description:
			"Appended to every system prompt with the current date and time. Keep {{when}} and {{zone}}: they are filled per question.",
		required: false,
		placeholders: ["{{when}}", "{{zone}}"],
		bundled: datetimeContextPrompt.trim(),
	},
	{
		id: "final-answer",
		label: "Final-answer message (iteration cap)",
		description: "Sent when the agent reaches its tool-iteration cap, telling it to answer now from what it has gathered.",
		required: false,
		placeholders: [],
		bundled: finalAnswerPrompt.trim(),
	},
];

const BY_ID: Record<PromptId, PromptDef> = Object.fromEntries(PROMPT_DEFS.map((d) => [d.id, d])) as Record<
	PromptId,
	PromptDef
>;

/** The trimmed bundled default for a prompt. */
export function bundledPrompt(id: PromptId): string {
	return BY_ID[id].bundled;
}

/** Effective prompt text: a non-blank user override, else the bundled default (never empty). */
export function resolvePrompt(id: PromptId, overrides: Record<string, string> | undefined): string {
	const override = overrides?.[id]?.trim();
	return override ? override : BY_ID[id].bundled;
}

/** Required prompts whose effective value is blank — chat should be refused if any. */
export function missingRequiredPrompts(overrides: Record<string, string> | undefined): PromptId[] {
	return PROMPT_DEFS.filter((d) => d.required && !resolvePrompt(d.id, overrides).trim()).map((d) => d.id);
}

/** Placeholders a (would-be) override drops vs. the prompt's required set — for a non-fatal warning. */
export function missingPlaceholders(id: PromptId, text: string): string[] {
	return BY_ID[id].placeholders.filter((p) => !text.includes(p));
}
