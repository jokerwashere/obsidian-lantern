/**
 * Lightweight #tag / [[link autocomplete for the query textarea.
 *
 * The query box is our own <textarea> (not a CodeMirror editor), so Obsidian's
 * native suggesters don't apply. This attaches a small popover that opens above
 * the box, keyboard-navigable (↑/↓/Enter/Tab/Esc). Read-only — it only inserts
 * text into the input.
 *
 * It's a `Component`: DOM listeners (registerDomEvent) and vault events
 * (registerEvent) are torn down automatically when the parent view unloads, so
 * nothing leaks. Candidate lists (vault files, tags) are cached with their
 * lowercased keys pre-computed and re-sorted only when the vault changes, so
 * typing doesn't rescan/sort the whole vault on every keystroke.
 */

import { Component, setIcon, TFolder } from "obsidian";
import type { App, TFile } from "obsidian";

export type SuggestKind = "tag" | "link" | "folder" | "within" | "fmValue";

export interface SuggestToken {
	kind: SuggestKind;
	/** Index in the value where the token (including its trigger) starts. */
	start: number;
	/** Index of the caret (token end). */
	end: number;
	/** Text typed after the trigger, up to the caret. */
	query: string;
	/** For `fmValue`: the frontmatter key typed before `=`. */
	key?: string;
}

// A #tag tail: `#` at start-of-text or after whitespace, then tag characters.
const TAG_TAIL = /(?:^|\s)(#([\p{L}\p{N}_/-]*))$/u;
// Scope-token tails (search pane): folder:<path>, within:<n>, key=<value>.
// The value may be quoted to allow spaces. Mirrors src/search/scope.ts.
const FOLDER_TAIL = /(?:^|\s)folder:("[^"\n]*|\S*)$/u;
const WITHIN_TAIL = /(?:^|\s)within:(\S*)$/u;
const FMVALUE_TAIL = /(?:^|\s)([\p{L}\p{N}_-]+)=("[^"\n]*|\S*)$/u;

/** Strip a leading opening quote from a partial value (for matching). */
function stripOpenQuote(s: string): string {
	return s.startsWith('"') ? s.slice(1) : s;
}

/** Quote a scope value when it contains whitespace (so the parser keeps it whole). */
function quoteScopeValue(s: string): string {
	return /\s/.test(s) ? `"${s}"` : s;
}

/**
 * Detect a `#tag` or `[[link` token under the caret. Pure (no DOM/obsidian) so
 * it can be unit-tested. Returns null when the caret isn't in a token.
 */
export function detectToken(value: string, caret: number): SuggestToken | null {
	const text = value.slice(0, Math.max(0, caret));

	// [[ link: an unclosed `[[` before the caret, with a plausible name after it.
	const linkStart = text.lastIndexOf("[[");
	if (linkStart !== -1) {
		const between = text.slice(linkStart + 2);
		if (/^[^\]\n|#]*$/.test(between)) {
			return { kind: "link", start: linkStart, end: caret, query: between };
		}
	}

	// folder:<path>
	const folder = text.match(FOLDER_TAIL);
	if (folder) {
		const tok = `folder:${folder[1]}`;
		return { kind: "folder", start: caret - tok.length, end: caret, query: stripOpenQuote(folder[1]) };
	}

	// within:<n>
	const within = text.match(WITHIN_TAIL);
	if (within) {
		const tok = `within:${within[1]}`;
		return { kind: "within", start: caret - tok.length, end: caret, query: within[1] };
	}

	// key=<value> (frontmatter equality)
	const fm = text.match(FMVALUE_TAIL);
	if (fm) {
		const tok = `${fm[1]}=${fm[2]}`;
		return { kind: "fmValue", start: caret - tok.length, end: caret, query: stripOpenQuote(fm[2]), key: fm[1] };
	}

	// #tag
	const m = text.match(TAG_TAIL);
	if (m) {
		return { kind: "tag", start: caret - m[1].length, end: caret, query: m[2] };
	}

	return null;
}

/** Splice a completion in place of the token; returns the new value + caret. Pure. */
export function applyCompletion(
	value: string,
	token: SuggestToken,
	insert: string
): { value: string; caret: number } {
	const before = value.slice(0, token.start);
	const after = value.slice(token.end);
	return { value: before + insert + after, caret: before.length + insert.length };
}

const MAX_SUGGESTIONS = 8;
const REFRESH_DEBOUNCE_MS = 80;
const BLUR_CLOSE_MS = 120;

export interface SuggestItem {
	kind: SuggestKind;
	/** Text to splice in place of the token (already includes `#`/`[[ ]]`). */
	insert: string;
	label: string;
	sub?: string;
	icon: string;
}

/** Cached file entry: the file plus its lowercased name/path for cheap matching. */
export interface FileEntry {
	file: TFile;
	lname: string;
	lpath: string;
}
/** Cached tag entry: `#tag`, its lowercased name (no `#`), and use count. */
export interface TagEntry {
	tag: string;
	lname: string;
	count: number;
}
/** Cached folder entry: path + its lowercased form. */
export interface FolderEntry {
	path: string;
	lpath: string;
}
/** Cached frontmatter value entry: the value, lowercased form, and use count. */
export interface FmValueEntry {
	value: string;
	lvalue: string;
	count: number;
}

function fileItem(f: TFile): SuggestItem {
	return {
		kind: "link",
		insert: `[[${f.basename}]]`,
		label: f.basename,
		sub: f.parent && f.parent.path !== "/" ? f.parent.path : undefined,
		icon: "file-text",
	};
}
function tagItem(e: TagEntry): SuggestItem {
	return { kind: "tag", insert: `${e.tag} `, label: e.tag, sub: String(e.count), icon: "hash" };
}

/**
 * Pick file suggestions for a query from pre-sorted (mtime-desc) entries:
 * prefix matches first (keeping recency order), then substring matches. Pure —
 * no full re-sort, no per-call lowercasing of entries. Empty query → most recent.
 */
export function selectFileSuggestions(entries: FileEntry[], query: string, max = MAX_SUGGESTIONS): SuggestItem[] {
	const q = query.toLowerCase();
	if (!q) return entries.slice(0, max).map((e) => fileItem(e.file));
	const starts: FileEntry[] = [];
	const contains: FileEntry[] = [];
	for (const e of entries) {
		if (e.lname.startsWith(q)) starts.push(e);
		else if (e.lname.includes(q) || e.lpath.includes(q)) contains.push(e);
	}
	return starts.concat(contains).slice(0, max).map((e) => fileItem(e.file));
}

/** Pick tag suggestions from pre-sorted (count-desc) entries. Pure. */
export function selectTagSuggestions(entries: TagEntry[], query: string, max = MAX_SUGGESTIONS): SuggestItem[] {
	const q = query.toLowerCase();
	if (!q) return entries.slice(0, max).map(tagItem);
	const starts: TagEntry[] = [];
	const contains: TagEntry[] = [];
	for (const e of entries) {
		if (e.lname.startsWith(q)) starts.push(e);
		else if (e.lname.includes(q)) contains.push(e);
	}
	return starts.concat(contains).slice(0, max).map(tagItem);
}

function folderItem(e: FolderEntry): SuggestItem {
	return { kind: "folder", insert: `folder:${quoteScopeValue(`${e.path}/`)} `, label: e.path, icon: "folder" };
}
function withinItem(days: number): SuggestItem {
	return { kind: "within", insert: `within:${days}d `, label: `within:${days}d`, sub: "modified", icon: "clock" };
}
function fmValueItem(key: string, e: FmValueEntry): SuggestItem {
	return {
		kind: "fmValue",
		insert: `${key}=${quoteScopeValue(e.value)} `,
		label: `${key}=${e.value}`,
		sub: String(e.count),
		icon: "tag",
	};
}

/** within: presets (days), filtered by the digits already typed. Pure. */
const WITHIN_PRESETS = [7, 14, 30, 90, 365];
export function selectWithinSuggestions(query: string): SuggestItem[] {
	const digits = query.replace(/d$/i, "");
	const matches = digits ? WITHIN_PRESETS.filter((d) => String(d).startsWith(digits)) : WITHIN_PRESETS;
	return (matches.length > 0 ? matches : WITHIN_PRESETS).map(withinItem);
}

/** Pick folder suggestions from pre-sorted (path-asc) entries: prefix then substring. Pure. */
export function selectFolderSuggestions(entries: FolderEntry[], query: string, max = MAX_SUGGESTIONS): SuggestItem[] {
	const q = query.toLowerCase();
	if (!q) return entries.slice(0, max).map(folderItem);
	const starts: FolderEntry[] = [];
	const contains: FolderEntry[] = [];
	for (const e of entries) {
		if (e.lpath.startsWith(q)) starts.push(e);
		else if (e.lpath.includes(q)) contains.push(e);
	}
	return starts.concat(contains).slice(0, max).map(folderItem);
}

/** Pick frontmatter-value suggestions for a key from pre-sorted (count-desc) entries. Pure. */
export function selectFmValueSuggestions(
	entries: FmValueEntry[],
	key: string,
	query: string,
	max = MAX_SUGGESTIONS
): SuggestItem[] {
	const q = query.toLowerCase();
	if (!q) return entries.slice(0, max).map((e) => fmValueItem(key, e));
	const starts: FmValueEntry[] = [];
	const contains: FmValueEntry[] = [];
	for (const e of entries) {
		if (e.lvalue.startsWith(q)) starts.push(e);
		else if (e.lvalue.includes(q)) contains.push(e);
	}
	return starts.concat(contains).slice(0, max).map((e) => fmValueItem(key, e));
}

/** Flatten a frontmatter value to its scalar string forms (scalars + array members). */
export function flattenFmValue(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(flattenFmValue);
	if (value === null || value === undefined || typeof value === "object") return [];
	return [String(value)];
}

export class LanternInputSuggest extends Component {
	private popover: HTMLElement | null = null;
	private items: SuggestItem[] = [];
	private active = 0;
	private token: SuggestToken | null = null;
	private blurTimer: number | null = null;
	private refreshTimer: number | null = null;

	// Candidate caches, rebuilt lazily after a vault change invalidates them.
	private files: FileEntry[] | null = null;
	private tags: TagEntry[] | null = null;
	private folders: FolderEntry[] | null = null;
	private fmValues: Map<string, FmValueEntry[]> | null = null;

	constructor(
		private app: App,
		private input: HTMLTextAreaElement,
		private anchor: HTMLElement
	) {
		super();
	}

	onload(): void {
		this.registerDomEvent(this.input, "input", () => this.scheduleRefresh());
		this.registerDomEvent(this.input, "click", () => this.scheduleRefresh());
		// Capture phase: intercept Enter/Tab/arrows before the box's submit handler.
		this.registerDomEvent(this.input, "keydown", (e) => this.onKeyDown(e), { capture: true });
		this.registerDomEvent(this.input, "blur", () => {
			this.blurTimer = window.setTimeout(() => this.close(), BLUR_CLOSE_MS);
		});

		// Keep candidate caches fresh without rescanning on every keystroke.
		// Structural changes (add/remove/rename a file) can alter every cache;
		// a metadata "changed" fires on each save and only affects tags /
		// frontmatter / mtime ordering — never the folder tree.
		this.registerEvent(this.app.vault.on("create", this.invalidateAll));
		this.registerEvent(this.app.vault.on("delete", this.invalidateAll));
		this.registerEvent(this.app.vault.on("rename", this.invalidateAll));
		this.registerEvent(this.app.metadataCache.on("changed", this.invalidateMeta));

		// Tear down the popover + timers when the component unloads.
		this.register(() => this.close());
	}

	private invalidateAll = (): void => {
		this.files = null;
		this.tags = null;
		this.folders = null;
		this.fmValues = null;
	};

	// A single-file save can't add/remove folders — keep that (costlier) cache.
	private invalidateMeta = (): void => {
		this.files = null;
		this.tags = null;
		this.fmValues = null;
	};

	private scheduleRefresh(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.refresh();
		}, REFRESH_DEBOUNCE_MS);
	}

	private refresh(): void {
		const caret = this.input.selectionStart ?? this.input.value.length;
		const token = detectToken(this.input.value, caret);
		if (!token) return this.close();
		this.token = token;
		switch (token.kind) {
			case "tag":
				this.items = selectTagSuggestions(this.tagEntries(), token.query);
				break;
			case "link":
				this.items = selectFileSuggestions(this.fileEntries(), token.query);
				break;
			case "folder":
				this.items = selectFolderSuggestions(this.folderEntries(), token.query);
				break;
			case "within":
				this.items = selectWithinSuggestions(token.query);
				break;
			case "fmValue":
				this.items = selectFmValueSuggestions(this.fmValueEntries(token.key ?? ""), token.key ?? "", token.query);
				break;
		}
		if (this.items.length === 0) return this.close();
		this.active = 0;
		this.render();
	}

	private fileEntries(): FileEntry[] {
		if (!this.files) {
			this.files = this.app.vault
				.getMarkdownFiles()
				.map((file) => ({ file, lname: file.basename.toLowerCase(), lpath: file.path.toLowerCase() }))
				.sort((a, b) => b.file.stat.mtime - a.file.stat.mtime);
		}
		return this.files;
	}

	private tagEntries(): TagEntry[] {
		if (!this.tags) {
			// getTags() exists at runtime but isn't in Obsidian's public typings.
			const raw = (this.app.metadataCache as unknown as { getTags(): Record<string, number> }).getTags();
			this.tags = Object.entries(raw)
				.map(([tag, count]) => ({ tag, lname: tag.slice(1).toLowerCase(), count }))
				.sort((a, b) => b.count - a.count);
		}
		return this.tags;
	}

	private folderEntries(): FolderEntry[] {
		if (!this.folders) {
			this.folders = this.app.vault
				.getAllLoadedFiles()
				.filter((f): f is TFolder => f instanceof TFolder && f.path !== "/")
				.map((f) => ({ path: f.path, lpath: f.path.toLowerCase() }))
				.sort((a, b) => a.path.localeCompare(b.path));
		}
		return this.folders;
	}

	/** Frontmatter values grouped by (lowercased) key, built once and cached. */
	private fmValueEntries(key: string): FmValueEntry[] {
		if (!this.fmValues) {
			const counts = new Map<string, Map<string, number>>(); // lkey -> value -> count
			for (const file of this.app.vault.getMarkdownFiles()) {
				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
				if (!fm) continue;
				for (const [k, v] of Object.entries(fm)) {
					if (k === "position") continue;
					const lkey = k.toLowerCase();
					const values = counts.get(lkey) ?? new Map<string, number>();
					for (const val of flattenFmValue(v)) values.set(val, (values.get(val) ?? 0) + 1);
					if (values.size > 0) counts.set(lkey, values);
				}
			}
			this.fmValues = new Map(
				[...counts].map(([k, vals]) => [
					k,
					[...vals]
						.map(([value, count]) => ({ value, lvalue: value.toLowerCase(), count }))
						.sort((a, b) => b.count - a.count),
				])
			);
		}
		return this.fmValues.get(key.toLowerCase()) ?? [];
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (!this.popover) return;
		switch (e.key) {
			case "ArrowDown":
				this.move(1);
				break;
			case "ArrowUp":
				this.move(-1);
				break;
			case "Enter":
			case "Tab":
				this.accept(this.items[this.active]);
				break;
			case "Escape":
				this.close();
				break;
			default:
				return; // let the keystroke through to the textarea
		}
		e.preventDefault();
		e.stopImmediatePropagation(); // keep Enter from submitting the query
	}

	private move(delta: number): void {
		const n = this.items.length;
		if (n === 0) return;
		this.active = (this.active + delta + n) % n;
		this.render();
	}

	private accept(item: SuggestItem | undefined): void {
		if (!item || !this.token) return this.close();
		const { value, caret } = applyCompletion(this.input.value, this.token, item.insert);
		this.input.value = value;
		this.input.setSelectionRange(caret, caret);
		// Trigger the box's own input handler (auto-grow + live search).
		this.input.dispatchEvent(new Event("input"));
		this.input.focus();
		this.close();
	}

	private render(): void {
		if (!this.popover) {
			this.popover = this.anchor.createDiv({ cls: "lantern-suggest" });
		}
		this.popover.empty();
		this.items.forEach((item, i) => {
			const row = this.popover!.createDiv({
				cls: i === this.active ? "lantern-suggest-item is-active" : "lantern-suggest-item",
			});
			setIcon(row.createSpan({ cls: "lantern-suggest-icon" }), item.icon);
			row.createSpan({ cls: "lantern-suggest-label", text: item.label });
			if (item.sub) row.createSpan({ cls: "lantern-suggest-sub", text: item.sub });
			row.addEventListener("mousedown", (e) => {
				e.preventDefault(); // keep textarea focus
				this.accept(item);
			});
		});
	}

	private close(): void {
		if (this.blurTimer !== null) {
			window.clearTimeout(this.blurTimer);
			this.blurTimer = null;
		}
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.popover?.remove();
		this.popover = null;
		this.token = null;
		this.items = [];
	}
}
