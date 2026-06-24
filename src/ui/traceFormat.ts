/**
 * Pure formatting helpers for the chat tool trace (no Obsidian imports, so
 * they are unit-testable — the view itself is verified manually in Obsidian).
 */

import { decodeUriSafe, normalizeTag } from "../util";

/** Lucide icon name for a tool's trace row. */
export function toolIconName(name: string): string {
	if (name === "search_vault") return "search";
	if (name === "read_file") return "file-text";
	if (name === "get_note_info") return "link";
	if (name === "find_notes_by_tag") return "tag";
	if (name === "list_recent_notes") return "history";
	if (name === "find_tasks") return "list-checks";
	if (name === "read_daily_notes") return "calendar-days";
	if (name === "search_references") return "library";
	if (name === "read_reference") return "book-open";
	if (name === "create_note") return "file-plus";
	if (name === "append_to_daily_note") return "calendar-plus";
	if (name === "web_search") return "globe";
	return "wrench";
}

/** A plain-language summary of a tool call, derived from its arguments. */
export function friendlyToolLabel(name: string, rawArgs: string): string {
	const args = safeParseArgs(rawArgs);
	if (name === "search_vault") {
		const query = typeof args.query === "string" ? args.query.trim() : "";
		const scope = searchScopeSuffix(args);
		return query ? `Searching your notes for “${shorten(query, 60)}”${scope}` : `Searching your notes${scope}`;
	}
	if (name === "read_file") {
		const path = typeof args.path === "string" ? args.path.trim() : "";
		return path ? `Reading ${baseName(path)}` : "Reading a note";
	}
	if (name === "get_note_info") {
		const path = typeof args.path === "string" ? args.path.trim() : "";
		return path ? `Inspecting ${baseName(path)}` : "Inspecting a note";
	}
	if (name === "find_notes_by_tag") {
		const tag = typeof args.tag === "string" ? normalizeTag(args.tag) : "";
		return tag ? `Finding notes tagged #${tag}` : "Finding notes by tag";
	}
	if (name === "list_recent_notes") {
		return "Listing recent notes";
	}
	if (name === "find_tasks") {
		const status = typeof args.status === "string" ? args.status : "open";
		const scope = searchScopeSuffix(args);
		return `Finding ${status === "any" ? "" : `${status} `}tasks${scope}`;
	}
	if (name === "read_daily_notes") {
		const days = typeof args.days === "number" && args.days > 1 ? ` (${args.days} days)` : "";
		return `Reading daily notes${days}`;
	}
	if (name === "search_references") {
		const query = typeof args.query === "string" ? args.query.trim() : "";
		const where = typeof args.collection === "string" && args.collection.trim() ? args.collection.trim() : "references";
		return query ? `Consulting ${where} for “${shorten(query, 50)}”` : `Consulting ${where}`;
	}
	if (name === "read_reference") {
		const path = typeof args.path === "string" ? args.path.trim() : "";
		const coll = typeof args.collection === "string" ? args.collection.trim() : "";
		return path ? `Reading ${baseName(path)}${coll ? ` (${coll})` : ""}` : "Reading a reference";
	}
	if (name === "create_note") {
		const title = typeof args.title === "string" ? args.title.trim() : "";
		return title ? `Creating note “${shorten(title, 50)}”` : "Creating a note";
	}
	if (name === "append_to_daily_note") {
		const date = typeof args.date === "string" && args.date.trim() ? args.date.trim() : "today";
		return `Adding to the ${date === "today" ? "daily" : date} note`;
	}
	if (name === "web_search") {
		const query = typeof args.query === "string" ? args.query.trim() : "";
		return query ? `Searching the web for “${shorten(query, 60)}”` : "Searching the web";
	}
	return `Running ${humanize(name)}`;
}

/** " (in #tag, Projects/)" when the search call is scoped. */
function searchScopeSuffix(args: Record<string, unknown>): string {
	const parts: string[] = [];
	if (typeof args.tag === "string" && args.tag.trim()) {
		parts.push(`#${normalizeTag(args.tag)}`);
	}
	if (typeof args.folder === "string" && args.folder.trim()) {
		parts.push(args.folder.trim());
	}
	return parts.length > 0 ? ` (in ${parts.join(", ")})` : "";
}

/** Parse a JSON tool result ({...} on the first byte), else null. */
function jsonResult(text: string): Record<string, unknown> | null {
	if (!text.startsWith("{")) return null;
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function count(value: unknown): number {
	return Array.isArray(value) ? value.length : 0;
}

/** A short, human outcome shown at the end of the (collapsed) summary row. */
export function toolOutcome(name: string, content: string): string {
	const text = content.trim();
	if (/^error\b/i.test(text)) return "error";
	const json = jsonResult(text);

	if (name === "search_vault" && json) {
		const n = count(json.results);
		return n > 0 ? `${n} ${n === 1 ? "note" : "notes"}` : "no matches";
	}
	if (name === "web_search" && json) {
		const n = count(json.results);
		return n > 0 ? `${n} ${n === 1 ? "result" : "results"}` : "no results";
	}
	if (name === "search_references") {
		if (json) {
			const n = count(json.results);
			return n > 0 ? `${n} ${n === 1 ? "hit" : "hits"}` : "no matches";
		}
		if (/^No reference collections are enabled/i.test(text)) return "disabled";
	}
	if (name === "find_notes_by_tag" && json) {
		const n = typeof json.total === "number" ? json.total : 0;
		return n > 0 ? `${n} ${n === 1 ? "note" : "notes"}` : "none";
	}
	if (name === "list_recent_notes" && json) {
		const n = count(json.notes);
		return n > 0 ? `${n} ${n === 1 ? "note" : "notes"}` : "none";
	}
	if (name === "find_tasks" && json) {
		const n = typeof json.total === "number" ? json.total : 0;
		return n > 0 ? `${n} ${n === 1 ? "task" : "tasks"}` : "none";
	}
	if (name === "get_note_info" && json) {
		const out = json.links_out as { total?: number } | undefined;
		const back = json.backlinks as { total?: number } | undefined;
		return `${out?.total ?? 0} out · ${back?.total ?? 0} back`;
	}
	if (name === "read_file" || name === "read_reference") {
		const lines = text.match(/\((?:lines [\d–-]+ of )?(\d+) lines?\)/) ?? text.match(/of (\d+)\)/);
		if (lines) return `${lines[1]} lines`;
	}
	if (name === "read_daily_notes") {
		const days = text.match(/^## date=\d{4}-\d{2}-\d{2}/gm);
		if (days) return `${days.length} day${days.length === 1 ? "" : "s"}`;
	}
	if (name === "create_note" || name === "append_to_daily_note") {
		if (/^User declined/i.test(text)) return "declined";
		if (/^Created/i.test(text)) return "created";
		if (/^Appended/i.test(text)) return "appended";
	}
	return "done";
}

export function shorten(s: string, max: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? t.slice(0, max) + "…" : t;
}

/** Pretty-print tool-call argument JSON; fall back to the raw string. */
export function prettyJson(raw: string): string {
	try {
		return JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		return raw;
	}
}

export function safeParseArgs(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Split "collection/path" after the first slash; null if no path part. */
function splitCollectionPath(body: string): { collection: string; path: string } | null {
	const clean = body.split("#")[0].replace(/^\/+/, "");
	const slash = clean.indexOf("/");
	if (slash === -1) return null;
	const path = clean.slice(slash + 1);
	return path ? { collection: clean.slice(0, slash), path } : null;
}

/**
 * Parse a `qmd://<collection>/<path>` reference href (the form the agent is
 * told to cite reference documents with). Null when it isn't a qmd:// link.
 */
export function parseQmdHref(href: string): { collection: string; path: string } | null {
	if (!/^qmd:\/\//i.test(href)) return null;
	return splitCollectionPath(decodeUriSafe(href.replace(/^qmd:\/\//i, "")));
}

/**
 * A bare vault-relative link whose first segment is a CONFIGURED external
 * collection (e.g. a model that cited a reference as `[[pmbokguide/x.md]]`).
 * Used only after a vault-existence check fails, so it never shadows a real note.
 */
export function externalRefFromPath(
	href: string,
	externalCollections: string[]
): { collection: string; path: string } | null {
	const parsed = splitCollectionPath(decodeUriSafe(href));
	return parsed && externalCollections.includes(parsed.collection) ? parsed : null;
}

/** Last path segment, e.g. "Projects/Foo.md" -> "Foo.md". */
export function baseName(path: string): string {
	const parts = path.split("/").filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : path;
}

/** "search_vault" -> "search vault". */
export function humanize(name: string): string {
	return name.replace(/[_-]+/g, " ").trim();
}

// ---------------------------------------------------------- result parsing
// Typed extraction of the meta tools' JSON results, so the view can render
// structured rows instead of raw JSON dumps. Returns null for content-tool
// text (rendered as <pre>) and for anything malformed (fallback likewise).

export interface SearchHitData {
	collection?: string;
	path: string;
	line: number;
	score: number;
	title: string;
	snippet?: string;
}

export type ToolResultData =
	| { kind: "search"; scope?: string; note?: string; hits: SearchHitData[] }
	| { kind: "notes"; notes: Array<{ path: string; title?: string; modified?: string }>; total?: number; truncated?: boolean }
	| {
			kind: "tasks";
			total: number;
			note?: string;
			notes: Array<{ path: string; modified: string; tasks: Array<{ line: number; status: string; text: string }> }>;
	  }
	| {
			kind: "noteInfo";
			path: string;
			properties?: Record<string, unknown>;
			tags: string[];
			headings?: { total: number; list: string[] };
			linksOut: { total: number; paths: string[] };
			backlinks: { total: number; paths: string[] };
	  };

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> | undefined =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export function parseToolResult(name: string, content: string): ToolResultData | null {
	const json = jsonResult(content.trim());
	if (!json) return null;

	if (name === "search_vault" || name === "search_references") {
		const hits: SearchHitData[] = arr(json.results).flatMap((h) => {
			const r = rec(h);
			const path = str(r?.path);
			if (!r || !path) return [];
			return [{
				collection: str(r.collection),
				path,
				line: num(r.line, 1),
				score: num(r.score),
				title: str(r.title) ?? path,
				snippet: str(r.snippet),
			}];
		});
		return { kind: "search", scope: str(json.scope), note: str(json.note), hits };
	}

	if (name === "find_notes_by_tag" || name === "list_recent_notes") {
		const notes = arr(json.notes).flatMap((n) => {
			const r = rec(n);
			const path = str(r?.path);
			return r && path ? [{ path, title: str(r.title), modified: str(r.modified) }] : [];
		});
		return {
			kind: "notes",
			notes,
			total: typeof json.total === "number" ? json.total : undefined,
			truncated: json.truncated === true,
		};
	}

	if (name === "find_tasks") {
		const notes = arr(json.notes).flatMap((n) => {
			const r = rec(n);
			const path = str(r?.path);
			if (!r || !path) return [];
			const tasks = arr(r.tasks).flatMap((t) => {
				const task = rec(t);
				const text = str(task?.text);
				return task && text
					? [{ line: num(task.line, 1), status: str(task.status) ?? "open", text }]
					: [];
			});
			return [{ path, modified: str(r.modified) ?? "", tasks }];
		});
		return { kind: "tasks", total: num(json.total), note: str(json.note), notes };
	}

	if (name === "get_note_info") {
		const path = str(json.path);
		if (!path) return null;
		// links_out/backlinks are { total, notes: [{path, link}] }; the trace
		// only needs the paths (it builds its own clickable rows).
		const links = (v: unknown) => {
			const r = rec(v);
			const paths = arr(r?.notes).flatMap((n) => {
				const o = rec(n);
				return o && typeof o.path === "string" ? [o.path] : [];
			});
			return { total: num(r?.total), paths };
		};
		const headings = rec(json.headings);
		return {
			kind: "noteInfo",
			path,
			properties: rec(json.properties),
			tags: arr(json.tags).flatMap((t) => (typeof t === "string" ? [t] : [])),
			headings: headings
				? { total: num(headings.total), list: arr(headings.list).flatMap((h) => (typeof h === "string" ? [h] : [])) }
				: undefined,
			linksOut: links(json.links_out),
			backlinks: links(json.backlinks),
		};
	}

	return null;
}
