/**
 * Phase 3 (first slice): the two gated write tools.
 *
 * Guardrails (see ROADMAP): note content the agent reads is untrusted input,
 * so EVERY write goes through an injected `confirm()` that renders an
 * Apply/Deny card in the chat UI — no bypass in this slice. The blast radius
 * is deliberately tiny: create inside one inbox folder, or append to a daily
 * note. Tools are absent from the registry (and the system prompt) unless
 * the user enables them in settings (default off).
 */

import { App, TFile, normalizePath } from "obsidian";
import { readDailyNotesConfig, dailyNotePath, resolveDateWord } from "../search/dailyNotes";
import type { AgentTool } from "./tools";

export interface WriteRequest {
	action: "create" | "append";
	path: string;
	/** What will be written (capped by the UI). */
	preview: string;
}

export type WriteConfirmer = (request: WriteRequest) => Promise<boolean>;

export interface WriteToolOptions {
	inboxFolder: string;
	confirm: WriteConfirmer;
}

/** File-name-safe note title (strips Obsidian-reserved and path characters). */
export function sanitizeNoteTitle(title: string): string {
	const cleaned = title
		.replace(/[\\/:#^|[\]?*"<>]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120)
		.trim();
	return cleaned || "Untitled";
}

/** First free path: base.md, base-2.md … base-99.md (null when exhausted). */
export function uniqueNotePath(
	exists: (path: string) => boolean,
	folder: string,
	title: string
): string | null {
	const base = folder ? `${folder}/${title}` : title;
	if (!exists(`${base}.md`)) return `${base}.md`;
	for (let i = 2; i <= 99; i++) {
		if (!exists(`${base}-${i}.md`)) return `${base}-${i}.md`;
	}
	return null;
}

/** Append with exactly one blank line of separation and a trailing newline. */
export function appendWithSeparation(existing: string, text: string): string {
	const head = existing.replace(/\n*$/, "");
	const body = text.replace(/^\n+|\n+$/g, "");
	return head.length > 0 ? `${head}\n\n${body}\n` : `${body}\n`;
}

export function buildWriteTools(app: App, options: WriteToolOptions): Record<string, AgentTool> {
	const inbox = normalizePath(options.inboxFolder.trim() || "Lantern Inbox");

	return {
		create_note: {
			mutates: true,
			def: {
				type: "function",
				function: {
					name: "create_note",
					description:
						`Create a note in the user's "${inbox}" folder (the only writable folder). ` +
						"The user approves the content first. Use only when explicitly asked to capture or create something.",
					parameters: {
						type: "object",
						properties: {
							title: { type: "string", description: "Note title (becomes the file name)." },
							content: { type: "string", description: "Markdown body of the note." },
						},
						required: ["title", "content"],
					},
				},
			},
			execute: async (args) => {
				const title = sanitizeNoteTitle(String(args.title ?? ""));
				const content = String(args.content ?? "").trim();
				if (!content) return "Error: create_note requires non-empty 'content'.";

				const path = uniqueNotePath(
					(p) => app.vault.getAbstractFileByPath(p) !== null,
					inbox,
					title
				);
				if (!path) return `Error: too many notes named "${title}" in ${inbox}.`;

				const approved = await options.confirm({ action: "create", path, preview: content });
				if (!approved) return `User declined creating "${path}". Do not retry; continue without it.`;

				if (!app.vault.getAbstractFileByPath(inbox)) {
					try {
						await app.vault.createFolder(inbox);
					} catch {
						/* folder may have appeared concurrently */
					}
				}
				await app.vault.create(path, `${content}\n`);
				return `Created [[${path}]].`;
			},
		},

		append_to_daily_note: {
			mutates: true,
			def: {
				type: "function",
				function: {
					name: "append_to_daily_note",
					description:
						"Append a text block to the user's daily note (created if missing). The user approves the text first. " +
						"Use only when explicitly asked to log or add something.",
					parameters: {
						type: "object",
						properties: {
							text: { type: "string", description: "Text to append (Markdown; e.g. '- bought new tires')." },
							date: {
								type: "string",
								description: "Which day: 'today' (default), 'yesterday', or YYYY-MM-DD.",
							},
						},
						required: ["text"],
					},
				},
			},
			execute: async (args) => {
				const text = String(args.text ?? "").trim();
				if (!text) return "Error: append_to_daily_note requires non-empty 'text'.";
				const day = resolveDateWord(typeof args.date === "string" ? args.date : undefined);
				if (!day) return `Error: invalid date "${String(args.date)}" — use 'today', 'yesterday', or YYYY-MM-DD.`;

				const config = await readDailyNotesConfig(app);
				const path = normalizePath(dailyNotePath(config, day));

				const approved = await options.confirm({ action: "append", path, preview: text });
				if (!approved) return `User declined appending to "${path}". Do not retry; continue without it.`;

				const existing = app.vault.getAbstractFileByPath(path);
				if (existing instanceof TFile) {
					await app.vault.process(existing, (data) => appendWithSeparation(data, text));
					return `Appended to [[${path}]].`;
				}
				// Create the daily note (folder too, if needed). Daily-note
				// templates are intentionally not applied (out of scope).
				const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
				if (folder && !app.vault.getAbstractFileByPath(folder)) {
					try {
						await app.vault.createFolder(folder);
					} catch {
						/* may exist */
					}
				}
				await app.vault.create(path, `${text}\n`);
				return `Created [[${path}]] with the entry.`;
			},
		},
	};
}
