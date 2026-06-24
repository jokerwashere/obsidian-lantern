/**
 * Metadata-scoped search (ROADMAP Phase 2.5).
 *
 * qmd ignores YAML frontmatter and has no per-note filters, but Lantern can
 * read Obsidian's metadataCache — so scoping works client-side: compute the
 * candidate note set from metadata (tag and/or folder), over-fetch the qmd
 * search, and intersect. Shared by the agent's search_vault tool and the
 * search pane's `#tag` query tokens.
 */

import type { App, CachedMetadata } from "obsidian";
import { normalizeTag } from "../util";

function normalizeFrontmatterTags(value: unknown): string[] {
	if (typeof value === "string") return value.split(/[,\s]+/).map((s) => s.replace(/^#/, "")).filter(Boolean);
	if (Array.isArray(value)) return value.flatMap((v) => normalizeFrontmatterTags(v));
	return [];
}

/** Merge a note's inline (#tag) and frontmatter tags into a sorted, de-duped '#tag' list. */
export function noteTags(cache: CachedMetadata | null): string[] {
	const set = new Set<string>();
	for (const t of cache?.tags ?? []) {
		if (t?.tag) set.add(t.tag.replace(/^#/, ""));
	}
	for (const t of normalizeFrontmatterTags(cache?.frontmatter?.tags)) set.add(t);
	return [...set].sort().map((t) => `#${t}`);
}

/** True when a note tag (no '#') matches the wanted tag exactly or as a nested child. */
export function tagMatches(noteTag: string, want: string): boolean {
	const a = noteTag.toLowerCase();
	const b = want.toLowerCase();
	return a === b || a.startsWith(`${b}/`);
}

export interface WhereClause {
	key: string;
	value: string;
}

/**
 * Parse a `where` filter string: comma-separated `key=value` pairs with AND
 * semantics, e.g. "status=active, type=project". Malformed segments are
 * dropped. Friendlier to small local models than nested JSON objects.
 */
export function parseWhere(input: string): WhereClause[] {
	return input
		.split(",")
		.map((part) => {
			const eq = part.indexOf("=");
			if (eq === -1) return null;
			const key = part.slice(0, eq).trim();
			const value = part.slice(eq + 1).trim();
			return key && value ? { key, value } : null;
		})
		.filter((c): c is WhereClause => c !== null);
}

/** Case-insensitive frontmatter match: scalar equality or array-contains. */
export function frontmatterMatches(
	frontmatter: Record<string, unknown> | undefined,
	clause: WhereClause
): boolean {
	if (!frontmatter) return false;
	const wantKey = clause.key.toLowerCase();
	const entry = Object.entries(frontmatter).find(([k]) => k.toLowerCase() === wantKey);
	if (!entry) return false;
	const wantValue = clause.value.toLowerCase();
	const matches = (v: unknown): boolean => String(v).toLowerCase() === wantValue;
	const value = entry[1];
	return Array.isArray(value) ? value.some(matches) : matches(value);
}

export interface SearchScope {
	/** Tag without the leading '#'. */
	tag?: string;
	/** Tags without the leading '#'; ALL must match (AND). */
	tags?: string[];
	/** Folder prefix, e.g. "Projects/". */
	folder?: string;
	/** Frontmatter-property equality clauses (AND). */
	where?: WhereClause[];
	/** Only notes modified within this many days. */
	withinDays?: number;
	/** Clock injection for tests. */
	now?: number;
}

/** Normalize a folder filter to a "Prefix/" form ("" = vault root → no-op). */
function folderPrefix(folder: string): string {
	const trimmed = folder.replace(/^\/+|\/+$/g, "");
	return trimmed.length > 0 ? `${trimmed}/` : "";
}

/**
 * The set of vault paths matching the scope, or null when the scope is empty
 * (callers then skip filtering entirely). An empty returned set means the
 * scope matches nothing.
 */
export function scopeCandidates(app: App, scope: SearchScope): Set<string> | null {
	const wantTags = [...(scope.tag ? [scope.tag] : []), ...(scope.tags ?? [])]
		.map(normalizeTag)
		.filter(Boolean);
	const folder = scope.folder ? folderPrefix(scope.folder) : "";
	const where = scope.where ?? [];
	const withinDays = scope.withinDays && scope.withinDays > 0 ? scope.withinDays : 0;
	if (wantTags.length === 0 && !folder && where.length === 0 && !withinDays) return null;

	const cutoff = withinDays ? (scope.now ?? Date.now()) - withinDays * 86_400_000 : 0;
	const folderLower = folder.toLowerCase();
	const out = new Set<string>();
	for (const file of app.vault.getMarkdownFiles()) {
		if (folder && !file.path.toLowerCase().startsWith(folderLower)) continue;
		if (cutoff && file.stat.mtime < cutoff) continue;
		// One metadata lookup per file, reused for both tag and frontmatter checks.
		const cache = wantTags.length > 0 || where.length > 0 ? app.metadataCache.getFileCache(file) : null;
		if (wantTags.length > 0) {
			const noteTagList = noteTags(cache).map((t) => t.slice(1));
			if (!wantTags.every((want) => noteTagList.some((t) => tagMatches(t, want)))) continue;
		}
		if (where.length > 0) {
			const fm = cache?.frontmatter;
			if (!where.every((clause) => frontmatterMatches(fm, clause))) continue;
		}
		out.add(file.path);
	}
	return out;
}

/** A `#tag` token: '#' at start or after whitespace, then tag characters. */
const TAG_TOKEN = /(^|\s)#([\p{L}\p{N}_/-]+)/gu;

/** A `folder:<path>` token (value may be quoted to allow spaces). */
const FOLDER_TOKEN = /(^|\s)folder:("[^"]*"|\S+)/giu;
/** A `within:<N>[d]` recency token. */
const WITHIN_TOKEN = /(^|\s)within:(\d+)d?(?=\s|$)/giu;
/** A `key=value` frontmatter token (value may be quoted to allow spaces). */
const WHERE_TOKEN = /(^|\s)([\p{L}\p{N}_-]+)=("[^"]*"|\S+)/giu;

function unquote(value: string): string {
	return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

export interface ParsedScopeQuery {
	scope: SearchScope;
	/** Free-text remainder after scope tokens are removed. */
	rest: string;
	/** True when at least one scope token was found. */
	hasScope: boolean;
}

/**
 * Parse search-box scope tokens into a SearchScope + the free-text remainder.
 * Supports `#tag` (repeatable, AND), `folder:<path>`, `within:<N>[d]`, and
 * `key=value` frontmatter filters; quoted values allow spaces. Backs the search
 * pane, reusing the same metadata scoping the agent's search_vault uses.
 */
export function parseScopeTokens(query: string): ParsedScopeQuery {
	const tags: string[] = [];
	const where: WhereClause[] = [];
	let folder: string | undefined;
	let withinDays: number | undefined;

	const rest = query
		.replace(FOLDER_TOKEN, (_m, lead: string, val: string) => {
			folder = unquote(val);
			return lead;
		})
		.replace(WITHIN_TOKEN, (_m, lead: string, n: string) => {
			withinDays = parseInt(n, 10);
			return lead;
		})
		.replace(WHERE_TOKEN, (_m, lead: string, key: string, val: string) => {
			where.push({ key, value: unquote(val) });
			return lead;
		})
		.replace(TAG_TOKEN, (_m, lead: string, tag: string) => {
			tags.push(tag);
			return lead;
		})
		.replace(/\s+/g, " ")
		.trim();

	const scope: SearchScope = {};
	if (tags.length > 0) scope.tags = tags;
	if (folder) scope.folder = folder;
	if (where.length > 0) scope.where = where;
	if (withinDays !== undefined && withinDays > 0) scope.withinDays = withinDays;
	// hasScope mirrors scopeCandidates' own emptiness test, so no-op tokens like
	// `within:0d` or `folder:""` don't trigger a dead, always-empty scope.
	const hasScope =
		scope.tags !== undefined ||
		scope.folder !== undefined ||
		scope.where !== undefined ||
		scope.withinDays !== undefined;
	return { scope, rest, hasScope };
}

/** Human-readable scope description, e.g. "#meeting folder:Projects/ within:7d status=active". */
export function describeScope(scope: SearchScope): string {
	const parts: string[] = [];
	for (const t of scope.tags ?? []) parts.push(`#${t}`);
	if (scope.tag) parts.push(`#${scope.tag}`);
	if (scope.folder) parts.push(`folder:${scope.folder}`);
	if (scope.withinDays) parts.push(`within:${scope.withinDays}d`);
	for (const w of scope.where ?? []) parts.push(`${w.key}=${w.value}`);
	return parts.join(" ");
}

/** How many results to over-fetch when a client-side scope will filter them. */
export function scopedFetchLimit(limit: number): number {
	return Math.min(Math.max(limit * 4, 24), 60);
}
