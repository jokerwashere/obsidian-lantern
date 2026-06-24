/**
 * Agent tools — the read-only functions the model can call.
 *
 * P1: `search_vault` (discovery via qmd) and `read_file` (live vault content).
 * P2: `get_note_info` (graph: links/backlinks/tags/headings), `find_notes_by_tag`,
 *     `list_recent_notes`. All read-only; write tools are a later phase.
 * Each tool returns a compact text result that goes back into the chat as a
 * `tool` message. Keep outputs lean — local models have small context windows.
 */

import { App, TFile } from "obsidian";
import { readFile } from "fs/promises";
import type { QmdService } from "../qmd/QmdService";
import type { QmdSearchMode, QmdResult } from "../qmd/QmdClient";
import { resolveVaultPaths, resolveNotePathLoose } from "../qmd/vaultPath";
import { readCollectionRoots, resolveWithinRoot } from "../qmd/qmdConfig";
import { noteTags, tagMatches, scopeCandidates, scopedFetchLimit, parseWhere } from "../search/scope";
import { readDailyNotesConfig, dailyNotePath, resolveDateWord } from "../search/dailyNotes";
import { normalizeTag } from "../util";
import { buildWriteTools, type WriteToolOptions } from "./writes";
import { buildWebTools, type WebSearchOptions } from "./webSearch";
import type { ToolDef } from "./LlmClient";
import referenceLibrariesPrompt from "./prompts/reference-libraries.md";

export { noteTags };

export interface AgentTool {
	def: ToolDef;
	execute(args: Record<string, unknown>): Promise<string>;
}

export type ToolRegistry = Record<string, AgentTool>;

/** Reference libraries = external qmd collections (PMBOK, API docs, …). */
export interface ReferenceToolOptions {
	/** All configured reference collections (the settings list). */
	configured: string[];
	/** Currently enabled subset (chat-bar picker; may change mid-conversation). */
	getEnabled: () => string[];
	/** Injectable for tests (defaults: qmd's index.yml / node fs). */
	getRoots?: () => Record<string, string>;
	readFile?: (absPath: string) => Promise<string>;
}

export interface ToolOptions {
	/** Max bytes returned by read_file before truncation. */
	maxReadBytes: number;
	/** Default result count for search_vault. */
	searchLimit: number;
	/** Relevance floor for the agent's search_vault calls (default: qmd config). */
	searchMinScore?: number;
	/** Present = write tools enabled (gated in settings, default off). */
	writes?: WriteToolOptions;
	/** Present = reference collections configured ("Also search collections"). */
	references?: ReferenceToolOptions;
	/** Present = web search enabled (gated in settings, default off; needs an API key). */
	web?: WebSearchOptions;
}

/**
 * Prompt section for the reference tools, appended only when reference
 * collections are configured.
 */
export function referenceToolsPrompt(configured: string[], template: string = referenceLibrariesPrompt): string {
	// Template lives in prompts/reference-libraries.md (or a user override);
	// {{collections}} is filled with the configured collection names.
	return template.trim().replace(/\{\{collections\}\}/g, configured.join(", "));
}

const DEFAULT_OPTIONS: Omit<ToolOptions, "writes"> = { maxReadBytes: 8000, searchLimit: 6 };

/** Caps on graph/list tool output (local models have small context windows). */
const MAX_LINKS = 40;
const MAX_TAG_HITS = 50;
const MAX_RECENT = 50;
const DEFAULT_RECENT = 15;
/** find_tasks caps: total tasks reported / files actually read. */
const MAX_TASKS = 60;
const DEFAULT_TASKS = 30;
const MAX_TASK_FILE_READS = 40;
/** read_daily_notes caps. */
const MAX_DAILY_DAYS = 14;

type SearchCraftOptions = {
	mode?: QmdSearchMode;
	limit: number;
	intent?: string;
	lex?: string;
	hyde?: string;
	anyOf?: string[];
};

/**
 * The qmd query-craft parameter schema shared by `search_vault` and
 * `search_references`, so the model drives both with one mental model. The
 * vault-only metadata scopes (tag/folder/where/within_days) are added by
 * search_vault separately — they read Obsidian's metadataCache, which external
 * qmd collections don't have.
 */
function searchCraftParams(defaultLimit: number): Record<string, unknown> {
	return {
		query: {
			type: "string",
			description:
				"The concept in natural language — drives semantic ranking. If `keywords` is omitted, it also serves as the keyword query.",
		},
		keywords: {
			type: "string",
			description:
				'Exact keyword anchors for the lexical (BM25) match — names, titles, code symbols, rare terms (2–5; supports "phrase" and -exclude). Omit to reuse `query`.',
		},
		any_of: {
			type: "array",
			items: { type: "string" },
			description:
				"Match results containing ANY of these (OR), e.g. ['director','engineer','developer']. `query` still drives semantic ranking. (Replaces `keywords`.)",
		},
		mode: {
			type: "string",
			enum: ["hybrid", "text", "vector"],
			description: "hybrid (default) = keyword + semantic; text = keyword; vector = semantic.",
		},
		limit: { type: "integer", description: `Max results (default ${defaultLimit}).` },
		intent: {
			type: "string",
			description:
				"What you're looking for AND what to avoid, e.g. 'project status updates, not the original proposal'. Steers ranking and reranking — set it on almost every search.",
		},
		hyde: {
			type: "string",
			description:
				"A 50–100 word hypothetical answer passage; boosts semantic recall on nuanced questions.",
		},
	};
}

/** Parse the shared query-craft args into a qmd query + options (null = empty query). */
function parseSearchCraft(
	args: Record<string, unknown>,
	defaultLimit: number
): { query: string; options: SearchCraftOptions } | null {
	const query = String(args.query ?? "").trim();
	if (!query) return null;
	const anyOf = Array.isArray(args.any_of)
		? args.any_of.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
		: undefined;
	return {
		query,
		options: {
			mode: asMode(args.mode),
			limit: asPositiveInt(args.limit) ?? defaultLimit,
			intent: typeof args.intent === "string" && args.intent.trim() ? args.intent : undefined,
			lex: typeof args.keywords === "string" && args.keywords.trim() ? args.keywords.trim() : undefined,
			hyde: typeof args.hyde === "string" && args.hyde.trim() ? args.hyde : undefined,
			anyOf: anyOf && anyOf.length > 0 ? anyOf : undefined,
		},
	};
}

export function buildTools(
	app: App,
	qmd: QmdService,
	options: Partial<ToolOptions> = {}
): ToolRegistry {
	const opts = { ...DEFAULT_OPTIONS, ...options };

	return {
		search_vault: {
			def: {
				type: "function",
				function: {
					name: "search_vault",
					description:
						"Search the user's vault (hybrid keyword + semantic). " +
						"For best results give BOTH `keywords` (2–5 exact anchors: names, titles, terms — AND-ed) AND a natural-language `query` (the concept, in the words a note would use), plus an `intent` (what you want and what to avoid). " +
						"To match any of several alternatives, use `any_of`; narrow with `tag`/`folder` when you know where to look. " +
						'Keyword syntax: term = prefix, "phrase" = exact, -term = exclude. ' +
						"Returns JSON hits with `path` (→ read_file), `line`, and `link` (paste verbatim). Hits are leads — read the most relevant with read_file before answering.",
					parameters: {
						type: "object",
						properties: {
							...searchCraftParams(opts.searchLimit),
							tag: {
								type: "string",
								description:
									"Only notes with this tag (± '#'; nested match: 'project' matches 'project/active').",
							},
							folder: {
								type: "string",
								description: "Only notes under this folder, e.g. 'Projects/'.",
							},
							where: {
								type: "string",
								description:
									"Only notes whose frontmatter matches, e.g. 'status=active' or 'status=active, type=project' (AND).",
							},
							within_days: {
								type: "integer",
								description: "Only notes modified within this many days.",
							},
						},
						required: ["query"],
					},
				},
			},
			execute: async (args) => {
				const craft = parseSearchCraft(args, opts.searchLimit);
				if (!craft) return "Error: search_vault requires a non-empty 'query'.";
				const tag = typeof args.tag === "string" ? normalizeTag(args.tag) : undefined;
				const folder = typeof args.folder === "string" && args.folder.trim() ? args.folder.trim() : undefined;
				const where = typeof args.where === "string" && args.where.trim() ? parseWhere(args.where) : undefined;
				const withinDays = asPositiveInt(args.within_days);

				const scope = scopeCandidates(app, { tag, folder, where, withinDays });
				const fetchLimit = scope ? scopedFetchLimit(craft.options.limit) : craft.options.limit;

				// Vault only — reference collections have their own tool, so
				// vault questions aren't diluted by 80k-file doc collections.
				const results = await qmd.search(craft.query, {
					...craft.options,
					limit: fetchLimit,
					collections: [qmd.collectionName],
					minScore: opts.searchMinScore,
				});
				// Present real vault paths so the model reads/cites openable paths
				// (single vault pass for the whole batch).
				const resolution = resolveVaultPaths(app, results.map((r) => r.path));
				const resolved = results.map((r) => ({
					...r,
					path: resolution.get(r.path) ?? r.path,
				}));

				if (!scope) return formatSearchResults(craft.query, resolved);
				return formatScopedResults(craft.query, resolved, scope, {
					tag,
					folder,
					where: typeof args.where === "string" ? args.where : undefined,
					withinDays,
					limit: craft.options.limit,
				});
			},
		},

		find_tasks: {
			def: {
				type: "function",
				function: {
					name: "find_tasks",
					description:
						"List checkbox tasks (- [ ] …) across the vault — the user's action items. Custom marks like [/] count as done. " +
						"Returns JSON; paste a note's `link` to reference it.",
					parameters: {
						type: "object",
						properties: {
							status: {
								type: "string",
								enum: ["open", "done", "any"],
								description: "open (default) = unchecked; done = completed; any = both.",
							},
							tag: { type: "string", description: "Only tasks in notes with this tag." },
							folder: { type: "string", description: "Only tasks in notes under this folder." },
							within_days: { type: "integer", description: "Only notes modified within this many days." },
							limit: { type: "integer", description: `Max tasks (default ${DEFAULT_TASKS}, max ${MAX_TASKS}).` },
						},
					},
				},
			},
			execute: async (args) => {
				const status = args.status === "done" || args.status === "any" ? args.status : "open";
				const tag = typeof args.tag === "string" ? normalizeTag(args.tag) : undefined;
				const folder = typeof args.folder === "string" && args.folder.trim() ? args.folder.trim() : undefined;
				const withinDays = asPositiveInt(args.within_days);
				const limit = Math.min(asPositiveInt(args.limit) ?? DEFAULT_TASKS, MAX_TASKS);
				return findTasks(app, { status, tag, folder, withinDays, limit });
			},
		},

		read_daily_notes: {
			def: {
				type: "function",
				function: {
					name: "read_daily_notes",
					description:
						"Read the user's daily note(s) — their journal. 'days' reads a range ending at 'date', newest first. " +
						"Use for a specific day, 'my week', or recent activity.",
					parameters: {
						type: "object",
						properties: {
							date: {
								type: "string",
								description: "Day to read: 'today' (default), 'yesterday', or YYYY-MM-DD.",
							},
							days: {
								type: "integer",
								description: `How many days back from 'date' to include (1–${MAX_DAILY_DAYS}, default 1).`,
							},
						},
					},
				},
			},
			execute: async (args) => {
				const end = resolveDateWord(typeof args.date === "string" ? args.date : undefined);
				if (!end) return `Error: invalid date "${String(args.date)}" — use 'today', 'yesterday', or YYYY-MM-DD.`;
				const days = Math.min(asPositiveInt(args.days) ?? 1, MAX_DAILY_DAYS);
				const config = await readDailyNotesConfig(app);

				const sections: string[] = [];
				const perNoteBudget = Math.max(800, Math.floor(opts.maxReadBytes / days));
				for (let i = 0; i < days; i++) {
					const day = end.clone().subtract(i, "day");
					const path = dailyNotePath(config, day);
					const file = app.vault.getAbstractFileByPath(path);
					const label = day.format("YYYY-MM-DD");
					if (!(file instanceof TFile)) {
						sections.push(`## date=${label} (no daily note)`);
						continue;
					}
					const content = await app.vault.cachedRead(file);
					const { text, truncated } = truncateUtf8(content.trim(), perNoteBudget);
					sections.push(
						`## date=${label} path=${fieldValue(path)}\n${text}${truncated ? "\n…[truncated]" : ""}`
					);
				}
				return sections.join("\n\n");
			},
		},

		read_file: {
			def: {
				type: "function",
				function: {
					name: "read_file",
					description:
						"Read a vault note's current content by path. Use the EXACT path from search/tag results " +
						"(keep numbered prefixes like '3. Resources/'). For a long note, read a window around a search hit by passing from_line near the hit's `line`. Returns content with line numbers.",
					parameters: {
						type: "object",
						properties: {
							path: {
								type: "string",
								description: "Vault-relative path, e.g. 'Projects/Foo.md'.",
							},
							from_line: {
								type: "integer",
								description: "1-based first line to read (optional).",
							},
							line_count: {
								type: "integer",
								description: "Number of lines to read starting at from_line (optional).",
							},
						},
						required: ["path"],
					},
				},
			},
			execute: async (args) => {
				const path = cleanPathArg(args.path);
				if (!path) return "Error: read_file requires a 'path'.";
				const resolution = resolveNotePathLoose(app, path);
				if (!resolution.path) return missingNoteMessage(path, resolution.candidates);
				const file = app.vault.getAbstractFileByPath(resolution.path);
				if (!(file instanceof TFile)) {
					return missingNoteMessage(path, resolution.candidates);
				}
				const fromLine = asPositiveInt(args.from_line);
				const lineCount = asPositiveInt(args.line_count);
				const content = await app.vault.cachedRead(file);
				const note = resolution.corrected
					? `Note: "${path}" does not exist; resolved to "${resolution.path}" — cite [[${resolution.path}]].\n`
					: "";
				return (
					note +
					formatFile(resolution.path, content, fromLine, lineCount, opts.maxReadBytes, vaultLink(resolution.path))
				);
			},
		},

		get_note_info: {
			def: {
				type: "function",
				function: {
					name: "get_note_info",
					description:
						"Inspect a note's structure and links. Returns JSON (properties, tags, headings, links_out, backlinks); follow a `path` with read_file, paste a `link` to reference it.",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string", description: "Vault-relative path, e.g. 'Projects/Foo.md'." },
						},
						required: ["path"],
					},
				},
			},
			execute: async (args) => {
				const path = cleanPathArg(args.path);
				if (!path) return "Error: get_note_info requires a 'path'.";
				const resolution = resolveNotePathLoose(app, path);
				if (!resolution.path) return missingNoteMessage(path, resolution.candidates);
				const file = app.vault.getAbstractFileByPath(resolution.path);
				if (!(file instanceof TFile)) return missingNoteMessage(path, resolution.candidates);
				const note = resolution.corrected
					? `Note: "${path}" does not exist; resolved to "${resolution.path}".\n`
					: "";
				return note + formatNoteInfo(app, file);
			},
		},

		find_notes_by_tag: {
			def: {
				type: "function",
				function: {
					name: "find_notes_by_tag",
					description:
						"List notes carrying a tag (inline or frontmatter; nested match: 'project' matches 'project/active'). Returns JSON; paste a note's `link` to reference it.",
					parameters: {
						type: "object",
						properties: {
							tag: { type: "string", description: "Tag to find (± '#')." },
						},
						required: ["tag"],
					},
				},
			},
			execute: async (args) => {
				const tag = normalizeTag(String(args.tag ?? ""));
				if (!tag) return "Error: find_notes_by_tag requires a 'tag'.";
				return formatTagHits(app, tag);
			},
		},

		list_recent_notes: {
			def: {
				type: "function",
				function: {
					name: "list_recent_notes",
					description:
						"List recently edited notes, newest first. Returns JSON; paste a note's `link` to reference it.",
					parameters: {
						type: "object",
						properties: {
							limit: { type: "integer", description: `How many to list (default ${DEFAULT_RECENT}, max ${MAX_RECENT}).` },
							within_days: { type: "integer", description: "Only notes modified within this many days." },
						},
					},
				},
			},
			execute: async (args) => {
				const limit = Math.min(asPositiveInt(args.limit) ?? DEFAULT_RECENT, MAX_RECENT);
				const withinDays = asPositiveInt(args.within_days);
				return formatRecentNotes(app, limit, withinDays);
			},
		},

		// Reference tools — present only when external collections are configured.
		...(opts.references ? buildReferenceTools(qmd, opts.references, opts) : {}),

		// Gated write tools (Phase 3 slice) — absent unless enabled in settings.
		...(opts.writes ? buildWriteTools(app, opts.writes) : {}),

		// Web search (Perplexity / Exa) — absent unless enabled (+ a key, for Perplexity).
		...(opts.web ? buildWebTools(opts.web) : {}),
	};
}

// ---------------------------------------------------------- reference tools

function buildReferenceTools(
	qmd: QmdService,
	refs: ReferenceToolOptions,
	opts: { maxReadBytes: number; searchLimit: number; searchMinScore?: number }
): Record<string, AgentTool> {
	const enabledNow = () => refs.getEnabled().filter((c) => refs.configured.includes(c));

	return {
		search_references: {
			def: {
				type: "function",
				function: {
					name: "search_references",
					description:
						`Search the user's reference libraries (external collections: ${refs.configured.join(", ")}) — project knowledge, docs, and notes kept outside the vault. NOT the vault. ` +
						"Same query craft as search_vault: give BOTH `keywords` (2–5 exact anchors) AND a natural-language `query`, plus an `intent`; add `hyde` for nuanced questions and `any_of` for alternatives. Use for ANY relevant info (ideas, pricing, plans, research, decisions) — a collection often covers what the vault doesn't. Returns JSON; pass collection+path to read_reference, and cite as [title](qmd://collection/path), never [[wikilinks]].",
					parameters: {
						type: "object",
						properties: {
							...searchCraftParams(opts.searchLimit),
							collection: {
								type: "string",
								description: "Restrict to one configured collection (default: all enabled).",
							},
						},
						required: ["query"],
					},
				},
			},
			execute: async (args) => {
				const craft = parseSearchCraft(args, opts.searchLimit);
				if (!craft) return "Error: search_references requires a non-empty 'query'.";
				const enabled = enabledNow();
				if (enabled.length === 0) {
					return (
						"No reference collections are enabled for this chat " +
						`(configured: ${refs.configured.join(", ")}). The user controls this via the references picker — continue from the vault alone.`
					);
				}
				let chosen = enabled;
				const collection = typeof args.collection === "string" ? args.collection.trim() : "";
				if (collection) {
					if (!refs.configured.includes(collection)) {
						return `Unknown reference collection "${collection}". Available: ${enabled.join(", ")}.`;
					}
					if (!enabled.includes(collection)) {
						return `Reference collection "${collection}" is disabled for this chat. Enabled: ${enabled.join(", ") || "none"}.`;
					}
					chosen = [collection];
				}
				const results = await qmd.search(craft.query, {
					...craft.options,
					collections: chosen,
					minScore: opts.searchMinScore,
				});
				if (results.length === 0) {
					return `No reference results for "${craft.query}" in ${chosen.join(", ")}.`;
				}
				return JSON.stringify({
					query: craft.query,
					collections: chosen,
					results: results.map((r) => ({
						collection: r.collection,
						...searchHit(r),
						// References are NOT vault notes — override the vault link.
						link: referenceLink(r.collection, r.path, r.title),
					})),
				});
			},
		},

		read_reference: {
			def: {
				type: "function",
				function: {
					name: "read_reference",
					description:
						"Read a passage from a reference-collection doc (from search_references) — reference collections only, NOT web pages or vault notes. Docs can be long — prefer a line range.",
					parameters: {
						type: "object",
						properties: {
							collection: { type: "string", description: "Reference collection name." },
							path: { type: "string", description: "Document path within the collection." },
							from_line: { type: "integer", description: "1-based first line to read (optional)." },
							line_count: { type: "integer", description: "Number of lines to read (optional)." },
						},
						required: ["collection", "path"],
					},
				},
			},
			execute: async (args) => {
				const collection = String(args.collection ?? "").trim();
				const path = cleanPathArg(args.path).replace(/^\/+/, "");
				if (!collection || !path) return "Error: read_reference requires 'collection' and 'path'.";
				if (!refs.configured.includes(collection)) {
					return `Error: "${collection}" is not a configured reference collection (${refs.configured.join(", ")}).`;
				}
				const roots = (refs.getRoots ?? readCollectionRoots)();
				const root = roots[collection];
				if (!root) {
					return `Error: the root folder of "${collection}" is unknown (not in qmd's index.yml).`;
				}
				// Untrusted (LLM-authored) path — refuse anything escaping the root.
				const abs = resolveWithinRoot(root, path);
				if (!abs) return "Error: path may not contain '..' or escape the collection root.";
				let content: string;
				try {
					content = await (refs.readFile ?? ((p: string) => readFile(p, "utf-8")))(abs);
				} catch {
					return `Error: could not read "${collection}/${path}" — check the path against search_references results.`;
				}
				const fromLine = asPositiveInt(args.from_line);
				const lineCount = asPositiveInt(args.line_count);
				return formatFile(
					`${collection}/${path}`,
					content,
					fromLine,
					lineCount,
					opts.maxReadBytes,
					referenceLink(collection, path)
				);
			},
		},
	};
}

// --------------------------------------------------------------- find_tasks

interface TaskQuery {
	status: "open" | "done" | "any";
	tag?: string;
	folder?: string;
	withinDays?: number;
	limit: number;
}

/** Obsidian semantics: ' ' = open, ANY other mark = completed. */
function taskMatchesStatus(mark: string, status: TaskQuery["status"]): boolean {
	if (status === "any") return true;
	return status === "open" ? mark === " " : mark !== " ";
}

/** Strip the list/checkbox prefix from a task line. */
export function taskLineText(line: string): string {
	return line.replace(/^\s*(?:[-*+]|\d+[.)])\s*\[.\]\s*/, "").trim();
}

async function findTasks(app: App, query: TaskQuery): Promise<string> {
	const scope = scopeCandidates(app, {
		tag: query.tag,
		folder: query.folder,
		withinDays: query.withinDays,
	});

	const files = app.vault
		.getMarkdownFiles()
		.filter((f) => (scope ? scope.has(f.path) : true))
		.sort((a, b) => b.stat.mtime - a.stat.mtime);

	const notes: Array<{
		path: string;
		link: string;
		modified: string;
		tasks: Array<{ line: number; status: string; text: string }>;
	}> = [];
	let total = 0;
	let reads = 0;
	let scanCapped = false;

	for (const file of files) {
		if (total >= query.limit) break;
		if (reads >= MAX_TASK_FILE_READS) {
			scanCapped = true;
			break;
		}
		const items = (app.metadataCache.getFileCache(file)?.listItems ?? []).filter(
			(li) => li.task !== undefined && taskMatchesStatus(li.task, query.status)
		);
		if (items.length === 0) continue;

		reads++;
		const lines = (await app.vault.cachedRead(file)).split("\n");
		const tasks: Array<{ line: number; status: string; text: string }> = [];
		for (const item of items) {
			if (total >= query.limit) break;
			const lineNo = item.position.start.line;
			const text = taskLineText(lines[lineNo] ?? "");
			if (!text) continue;
			tasks.push({
				line: lineNo + 1,
				status: item.task === " " ? "open" : "done",
				text: text.slice(0, 160),
			});
			total++;
		}
		if (tasks.length > 0) {
			notes.push({ path: file.path, link: vaultLink(file.path), modified: isoDate(file.stat.mtime), tasks });
		}
	}

	return JSON.stringify({
		status: query.status,
		...(query.tag ? { tag: `#${query.tag}` } : {}),
		...(query.folder ? { folder: query.folder } : {}),
		...(query.withinDays ? { within_days: query.withinDays } : {}),
		total,
		...(scanCapped
			? { scan_capped: true, note: `scan capped at ${MAX_TASK_FILE_READS} notes — narrow with tag/folder/within_days` }
			: {}),
		notes,
	});
}

/**
 * Normalize a model-supplied path-ish argument: trim and unwrap surrounding
 * quotes or [[wikilink]] brackets (models echo our quoted output, or cite
 * style, back into arguments).
 */
export function cleanPathArg(value: unknown): string {
	let path = String(value ?? "").trim();
	for (;;) {
		const unwrapped = path
			.replace(/^"(.*)"$/s, "$1")
			.replace(/^'(.*)'$/s, "$1")
			.replace(/^\[\[(.*)\]\]$/s, "$1")
			.trim();
		if (unwrapped === path) return path;
		path = unwrapped;
	}
}

/** Error for unresolvable note paths, with "did you mean" when available. */
function missingNoteMessage(path: string, candidates: string[]): string {
	if (candidates.length > 0) {
		return (
			`Error: no file at "${path}". Did you mean: ` +
			candidates.map((c) => `[[${c}]]`).join(", ") +
			"? Retry with the exact path."
		);
	}
	return `Error: no file found at "${path}". Use the exact path as returned by search/tag tools.`;
}

function asMode(value: unknown): QmdSearchMode | undefined {
	return value === "hybrid" || value === "text" || value === "vector" ? value : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : NaN;
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Escape a value for key="value" rendering. Handles the full tricky-character
 * class: double quotes degrade to apostrophes (field-safe, never breaks the
 * delimiter), and newlines/tabs/control characters collapse to single spaces
 * (multiline YAML frontmatter strings would otherwise shatter row structure).
 * Vault paths/titles can't contain '"' (Obsidian forbids it in note names),
 * but frontmatter values and external reference paths can contain anything.
 */
export function fieldValue(s: string): string {
	const flat = s
		// eslint-disable-next-line no-control-regex -- intentional: collapse literal control bytes (newlines/tabs/etc.) to a space
		.replace(/[\u0000-\u001f\u007f]+/g, " ") // newlines, tabs, control chars
		.replace(/\s+/g, " ")
		.trim()
		.replace(/"/g, "'");
	return `"${flat}"`;
}

/**
 * One-line snippet, tidied for model consumption: YAML-frontmatter windows
 * (qmd indexes frontmatter as opaque body text, so tag matches land there)
 * leave `---` delimiters and `key: - item` fragments behind — strip/flatten
 * them so the snippet reads as plain labeled text.
 */
export function tidySnippet(snippet: string): string {
	return oneLine(snippet)
		.replace(/(?:^|\s)---(?=\s|$)/g, " ") // frontmatter delimiters / rules
		.replace(/:\s+-\s+/g, ": ") // YAML list fragments: "tags: - x" → "tags: x"
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 240);
}

/**
 * Ready-to-use Markdown links, so the model pastes the `link` field verbatim
 * instead of constructing links itself (and mis-constructing reference ones,
 * which then open empty vault notes).
 */
export function vaultLink(path: string): string {
	return `[[${path}]]`;
}

/** Percent-encode a reference path per segment (slashes kept literal). */
function encodeRefPath(path: string): string {
	return path
		.split("/")
		.map((seg) => encodeURIComponent(seg))
		.join("/");
}

/** Reference link: `[title](qmd://collection/path)`; bracket-safe link text. */
export function referenceLink(collection: string, path: string, title?: string): string {
	const text = ((title && title.trim()) || (path.split("/").pop() ?? path).replace(/\.md$/i, "")).replace(
		/[[\]]/g,
		""
	);
	return `[${text}](qmd://${collection}/${encodeRefPath(path)})`;
}

/** One search hit as a JSON-ready object (empty snippet drops out). */
function searchHit(r: { path: string; line: number; title: string; score: number; snippet: string }) {
	const snippet = tidySnippet(r.snippet);
	return {
		path: r.path,
		line: r.line,
		score: Number(r.score.toFixed(2)),
		title: r.title,
		...(snippet ? { snippet } : {}),
		link: vaultLink(r.path),
	};
}

/**
 * Meta-search tools return compact JSON (lossless escaping for free); the
 * content tools (read_file & co.) stay plain text for model readability.
 */
export function formatSearchResults(
	query: string,
	results: Array<{ path: string; line: number; title: string; score: number; snippet: string; collection: string }>
): string {
	return JSON.stringify({ query, results: results.map(searchHit) });
}

/** Human label for a scope, e.g. `#project in Projects/, status=active`. */
function scopeLabel(scope: { tag?: string; folder?: string; where?: string; withinDays?: number }): string {
	const parts: string[] = [];
	if (scope.tag) parts.push(`#${scope.tag}`);
	if (scope.folder) parts.push(`folder ${scope.folder}`);
	if (scope.where) parts.push(scope.where);
	if (scope.withinDays) parts.push(`last ${scope.withinDays} day(s)`);
	return parts.join(", ") || "scope";
}

/**
 * Intersect over-fetched results with the scope's candidate set; fall back to
 * unscoped results (with an explicit note) when the scope yields nothing.
 */
export function formatScopedResults(
	query: string,
	resolved: QmdResult[],
	scope: Set<string>,
	info: { tag?: string; folder?: string; where?: string; withinDays?: number; limit: number }
): string {
	const label = scopeLabel(info);
	if (scope.size === 0) {
		return JSON.stringify({
			query,
			scope: label,
			note: `no notes match ${label} at all; showing unscoped results`,
			results: resolved.slice(0, info.limit).map(searchHit),
		});
	}
	const within = resolved.filter((r) => scope.has(r.path)).slice(0, info.limit);
	if (within.length === 0) {
		return JSON.stringify({
			query,
			scope: label,
			note: `none of the top results are within ${label} (${scope.size} notes carry that scope); showing unscoped results`,
			results: resolved.slice(0, info.limit).map(searchHit),
		});
	}
	return JSON.stringify({ query, scope: label, results: within.map(searchHit) });
}

/** Truncate to a UTF-8 byte budget without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= maxBytes) return { text, truncated: false };
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--; // back off a partial code point
	return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

/** Render a (possibly sliced) file with line numbers, capped to maxBytes (UTF-8). */
export function formatFile(
	path: string,
	content: string,
	fromLine: number | undefined,
	lineCount: number | undefined,
	maxBytes: number,
	link?: string
): string {
	const allLines = content.split("\n");
	const start = fromLine ? fromLine - 1 : 0;
	const end = lineCount ? start + lineCount : allLines.length;
	const slice = allLines.slice(Math.max(0, start), end);

	const full = slice.map((line, i) => `${start + i + 1}: ${line}`).join("\n");
	const { text: body, truncated } = truncateUtf8(full, maxBytes);

	const range =
		fromLine || lineCount
			? `lines ${start + 1}–${Math.min(end, allLines.length)} of ${allLines.length}`
			: `${allLines.length} lines`;
	const note = truncated ? "\n…[truncated — read a smaller range to see more]" : "";
	const linkPart = link ? ` link=${link}` : "";
	return `File: path=${fieldValue(path)} (${range})${linkPart}\n${body}${note}`;
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

// ------------------------------------------------ Phase 2: graph / metadata

/** Outgoing resolved links for a note (target vault paths). */
export function outgoingLinks(app: App, path: string): string[] {
	const targets = app.metadataCache.resolvedLinks[path];
	return targets ? Object.keys(targets) : [];
}

/** Notes that link to the given note, derived from the resolved-link graph. */
export function backlinksOf(app: App, path: string): string[] {
	const links = app.metadataCache.resolvedLinks;
	const sources: string[] = [];
	for (const source in links) {
		if (links[source]?.[path]) sources.push(source);
	}
	return sources;
}

/**
 * Note metadata as JSON: frontmatter passes through RAW (JSON escaping is
 * lossless — multiline/quoted values survive exactly), lists carry totals
 * alongside capped contents.
 */
export function formatNoteInfo(app: App, file: TFile): string {
	const cache = app.metadataCache.getFileCache(file);

	const properties: Record<string, unknown> = {};
	for (const key in cache?.frontmatter ?? {}) {
		if (key === "position") continue;
		properties[key] = cache!.frontmatter![key];
	}

	const headings = (cache?.headings ?? []).map((h) => `${"#".repeat(h.level)} ${h.heading}`);
	const out = outgoingLinks(app, file.path);
	const back = backlinksOf(app, file.path);

	const linked = (paths: string[]) => ({
		total: paths.length,
		notes: paths.slice(0, MAX_LINKS).map((p) => ({ path: p, link: vaultLink(p) })),
	});

	return JSON.stringify({
		path: file.path,
		link: vaultLink(file.path),
		...(Object.keys(properties).length > 0 ? { properties } : {}),
		tags: noteTags(cache),
		...(headings.length > 0
			? { headings: { total: headings.length, list: headings.slice(0, 30) } }
			: {}),
		links_out: linked(out),
		backlinks: linked(back),
	});
}

/** List notes carrying `tag` (exact or nested). */
export function formatTagHits(app: App, tag: string): string {
	const hits = app.vault.getMarkdownFiles().filter((file) => {
		const tags = noteTags(app.metadataCache.getFileCache(file)).map((t) => t.slice(1));
		return tags.some((t) => tagMatches(t, tag));
	});
	return JSON.stringify({
		tag: `#${tag}`,
		total: hits.length,
		notes: hits.slice(0, MAX_TAG_HITS).map((f) => ({ path: f.path, title: f.basename, link: vaultLink(f.path) })),
		...(hits.length > MAX_TAG_HITS ? { truncated: true } : {}),
	});
}

/** List recently modified notes, newest first. */
export function formatRecentNotes(app: App, limit: number, withinDays: number | undefined): string {
	const cutoff = withinDays ? Date.now() - withinDays * 86_400_000 : 0;
	const files = app.vault
		.getMarkdownFiles()
		.filter((f) => f.stat.mtime >= cutoff)
		.sort((a, b) => b.stat.mtime - a.stat.mtime)
		.slice(0, limit);
	return JSON.stringify({
		...(withinDays ? { within_days: withinDays } : {}),
		notes: files.map((f) => ({ path: f.path, modified: isoDate(f.stat.mtime), link: vaultLink(f.path) })),
	});
}

function isoDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

