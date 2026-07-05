import { describe, it, expect } from "vitest";
import {
	parseThreadFile,
	upsertThread,
	removeThread,
	threadTitle,
	emptyThreadFile,
	ThreadStore,
	DEFAULT_MAX_THREADS,
	formatRelativeTime,
	type ThreadAdapter,
} from "../../src/ui/threads";
import type { ChatMessage } from "../../src/agent/LlmClient";

const msgs = (q: string): ChatMessage[] => [
	{ role: "user", content: q },
	{ role: "assistant", content: `answer to ${q}` },
];

describe("formatRelativeTime", () => {
	const now = new Date("2026-06-13T12:00:00").getTime();
	const ago = (ms: number) => now - ms;
	const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;

	it("buckets recent times humanely", () => {
		expect(formatRelativeTime(ago(5 * S), now)).toBe("just now");
		expect(formatRelativeTime(ago(5 * M), now)).toBe("5m ago");
		expect(formatRelativeTime(ago(3 * H), now)).toBe("3h ago");
		expect(formatRelativeTime(ago(2 * D), now)).toBe("2d ago");
		expect(formatRelativeTime(ago(10 * D), now)).toBe("1w ago");
	});

	it("falls back to a calendar date past a month, adding the year across years", () => {
		expect(formatRelativeTime(new Date("2026-03-09T09:00:00").getTime(), now)).toBe("Mar 9");
		expect(formatRelativeTime(new Date("2025-12-01T09:00:00").getTime(), now)).toBe("Dec 1, 2025");
	});
});

describe("threadTitle", () => {
	it("uses the first user message, truncated", () => {
		expect(threadTitle(msgs("Plan the kitchen renovation"))).toBe("Plan the kitchen renovation");
		expect(threadTitle(msgs("x".repeat(60)))).toHaveLength(41); // 40 + ellipsis
		expect(threadTitle([])).toBe("Untitled thread");
	});
});

describe("upsertThread / removeThread", () => {
	it("inserts, updates, and keeps newest-updated first", () => {
		let file = emptyThreadFile();
		file = upsertThread(file, "a", msgs("first"), 100);
		file = upsertThread(file, "b", msgs("second"), 200);
		expect(file.threads.map((t) => t.id)).toEqual(["b", "a"]);

		file = upsertThread(file, "a", msgs("first again"), 300);
		expect(file.threads.map((t) => t.id)).toEqual(["a", "b"]);
		expect(file.threads[0].title).toBe("first"); // title sticks to the original
		expect(file.activeId).toBe("a");
	});

	it("prunes to DEFAULT_MAX_THREADS by oldest last-interaction date", () => {
		let file = emptyThreadFile();
		for (let i = 0; i < DEFAULT_MAX_THREADS + 5; i++) {
			file = upsertThread(file, `t${i}`, msgs(`q${i}`), i);
		}
		expect(file.threads).toHaveLength(DEFAULT_MAX_THREADS);
		expect(file.threads.some((t) => t.id === "t0")).toBe(false); // oldest dropped
		expect(file.threads[0].id).toBe(`t${DEFAULT_MAX_THREADS + 4}`); // newest first
	});

	it("honors an explicit cap and drops the oldest-interacted first", () => {
		let file = emptyThreadFile();
		// a,b,c created in order; then a is re-touched so it's newest.
		file = upsertThread(file, "a", msgs("a"), 1, 2);
		file = upsertThread(file, "b", msgs("b"), 2, 2);
		file = upsertThread(file, "c", msgs("c"), 3, 2); // over cap 2 → "a" (oldest) dropped
		expect(file.threads.map((t) => t.id)).toEqual(["c", "b"]);

		file = upsertThread(file, "b", msgs("b again"), 4, 2); // touch b → newest
		file = upsertThread(file, "d", msgs("d"), 5, 2); // cap 2 → "c" (now oldest) dropped
		expect(file.threads.map((t) => t.id)).toEqual(["d", "b"]);
	});

	it("keeps everything when the cap is 0 (unlimited)", () => {
		let file = emptyThreadFile();
		for (let i = 0; i < 25; i++) file = upsertThread(file, `t${i}`, msgs(`q${i}`), i, 0);
		expect(file.threads).toHaveLength(25);
	});

	it("removes and clears active when needed", () => {
		let file = upsertThread(emptyThreadFile(), "a", msgs("q"), 1);
		file = removeThread(file, "a");
		expect(file.threads).toHaveLength(0);
		expect(file.activeId).toBeNull();
	});
});

describe("parseThreadFile", () => {
	it("round-trips valid data and drops malformed entries", () => {
		const file = upsertThread(emptyThreadFile(), "a", msgs("hello"), 7);
		const parsed = parseThreadFile(JSON.stringify(file));
		expect(parsed.threads[0].messages[0].content).toBe("hello");
		expect(parsed.activeId).toBe("a");
	});

	it("survives corruption and foreign shapes", () => {
		expect(parseThreadFile("{broken").threads).toEqual([]);
		expect(parseThreadFile('{"version":99}').threads).toEqual([]);
		const mixed = '{"version":1,"activeId":"ghost","threads":[{"id":"ok","title":"t","createdAt":1,"updatedAt":1,"messages":[]},{"bad":true}]}';
		const parsed = parseThreadFile(mixed);
		expect(parsed.threads.map((t) => t.id)).toEqual(["ok"]);
		expect(parsed.activeId).toBeNull(); // ghost active id dropped
	});
});

describe("ThreadStore", () => {
	function memoryAdapter(initial: Record<string, string> = {}): ThreadAdapter & { files: Record<string, string> } {
		const files = { ...initial };
		return {
			files,
			read: async (p) => {
				if (!(p in files)) throw new Error("missing");
				return files[p];
			},
			write: async (p, data) => {
				files[p] = data;
			},
			exists: async (p) => p in files,
		};
	}

	it("loads, upserts, persists, and reloads", async () => {
		const adapter = memoryAdapter();
		const store = new ThreadStore(adapter, "plugins/lantern/threads.json");
		await store.load();
		await store.upsert("t1", msgs("persist me"), 10, 42);

		const reloaded = new ThreadStore(adapter, "plugins/lantern/threads.json");
		await reloaded.load();
		expect(reloaded.data.threads[0].title).toBe("persist me");
		expect(reloaded.data.activeId).toBe("t1");
	});

	it("starts clean when the file is missing or unreadable", async () => {
		const store = new ThreadStore(memoryAdapter(), "x.json");
		await store.load();
		expect(store.data.threads).toEqual([]);
	});
});
