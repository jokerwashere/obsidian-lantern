/**
 * Opt-in persistent chat threads (settings → default OFF; when off, nothing
 * is ever written and chat stays in-memory exactly as before).
 *
 * Storage: `<plugin dir>/threads.json` via the vault adapter. Messages are
 * the already-compacted history (tool traces are not persisted — re-rendered
 * transcripts show user bubbles + assistant answers only).
 */

import type { ChatMessage } from "../agent/LlmClient";

export interface ChatThread {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messages: ChatMessage[];
}

export interface ThreadFile {
	version: 1;
	activeId: string | null;
	threads: ChatThread[];
}

/** Default cap on persisted threads (0 = unlimited). User-configurable. */
export const DEFAULT_MAX_THREADS = 10;
const TITLE_MAX = 40;

/** Minimal adapter surface (vault.adapter satisfies it; tests inject). */
export interface ThreadAdapter {
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	exists(path: string): Promise<boolean>;
}

export function emptyThreadFile(): ThreadFile {
	return { version: 1, activeId: null, threads: [] };
}

/** Parse persisted JSON, tolerating corruption/foreign shapes. */
export function parseThreadFile(jsonText: string): ThreadFile {
	try {
		const parsed = JSON.parse(jsonText) as Partial<ThreadFile>;
		if (parsed && parsed.version === 1 && Array.isArray(parsed.threads)) {
			const threads = parsed.threads.filter(
				(t): t is ChatThread =>
					!!t && typeof t.id === "string" && typeof t.title === "string" && Array.isArray(t.messages)
			);
			const activeId =
				typeof parsed.activeId === "string" && threads.some((t) => t.id === parsed.activeId)
					? parsed.activeId
					: null;
			return { version: 1, activeId, threads };
		}
	} catch {
		/* corrupt → start clean */
	}
	return emptyThreadFile();
}

/** Thread title from its first user message. */
export function threadTitle(messages: ChatMessage[]): string {
	const first = messages.find((m) => m.role === "user")?.content ?? "";
	const flat = first.replace(/\s+/g, " ").trim();
	if (!flat) return "Untitled thread";
	return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX)}…` : flat;
}

/**
 * Insert or update a thread, then prune to `maxThreads` by LAST INTERACTION
 * date (updatedAt is stamped to `now` here, so the just-touched thread is
 * newest and the oldest-interacted are dropped). `maxThreads <= 0` keeps all.
 * Pure — returns a new ThreadFile.
 */
export function upsertThread(
	file: ThreadFile,
	id: string,
	messages: ChatMessage[],
	now: number,
	maxThreads: number = DEFAULT_MAX_THREADS
): ThreadFile {
	const existing = file.threads.find((t) => t.id === id);
	const thread: ChatThread = existing
		? { ...existing, messages, updatedAt: now, title: existing.title || threadTitle(messages) }
		: { id, title: threadTitle(messages), createdAt: now, updatedAt: now, messages };

	const others = file.threads.filter((t) => t.id !== id);
	const ordered = [thread, ...others].sort((a, b) => b.updatedAt - a.updatedAt);
	const threads = maxThreads > 0 ? ordered.slice(0, maxThreads) : ordered;
	const activeId = threads.some((t) => t.id === file.activeId) || file.activeId === id ? id : null;
	return { version: 1, activeId: activeId ?? id, threads };
}

export function removeThread(file: ThreadFile, id: string): ThreadFile {
	const threads = file.threads.filter((t) => t.id !== id);
	return {
		version: 1,
		activeId: file.activeId === id ? null : file.activeId,
		threads,
	};
}

/** Disk-backed store; all mutations go through the pure helpers above. */
export class ThreadStore {
	private file: ThreadFile = emptyThreadFile();

	constructor(private adapter: ThreadAdapter, private path: string) {}

	get data(): ThreadFile {
		return this.file;
	}

	async load(): Promise<void> {
		try {
			if (await this.adapter.exists(this.path)) {
				this.file = parseThreadFile(await this.adapter.read(this.path));
				return;
			}
		} catch {
			/* unreadable → start clean */
		}
		this.file = emptyThreadFile();
	}

	async save(): Promise<void> {
		await this.adapter.write(this.path, JSON.stringify(this.file, null, "\t"));
	}

	async upsert(
		id: string,
		messages: ChatMessage[],
		maxThreads: number = DEFAULT_MAX_THREADS,
		now = Date.now()
	): Promise<void> {
		this.file = upsertThread(this.file, id, messages, now, maxThreads);
		await this.save();
	}

	async remove(id: string): Promise<void> {
		this.file = removeThread(this.file, id);
		await this.save();
	}

	async setActive(id: string | null): Promise<void> {
		this.file = { ...this.file, activeId: id };
		await this.save();
	}
}

export function newThreadId(): string {
	return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Human-friendly "last interaction" label for the chat picker: "just now",
 * "5m ago", "3h ago", "2d ago", "3w ago", then a calendar date ("Jun 3",
 * "Jun 3, 2025" across years). Pure; `now` injectable for tests.
 */
export function formatRelativeTime(ms: number, now: number = Date.now()): string {
	const sec = Math.floor((now - ms) / 1000);
	if (sec < 45) return "just now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	if (day < 7) return `${day}d ago`;
	if (day < 30) return `${Math.floor(day / 7)}w ago`;
	const d = new Date(ms);
	const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
	return d.getFullYear() === new Date(now).getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}
