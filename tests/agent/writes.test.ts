import { describe, it, expect, vi } from "vitest";

vi.mock("obsidian", async () => {
	const real = await vi.importActual<Record<string, unknown>>("obsidian");
	class TFile {
		path = "";
	}
	return { ...real, TFile };
});

import { TFile } from "obsidian";
import type { App } from "obsidian";
import {
	sanitizeNoteTitle,
	uniqueNotePath,
	appendWithSeparation,
	buildWriteTools,
	type WriteRequest,
} from "../../src/agent/writes";

describe("sanitizeNoteTitle", () => {
	it("strips path/Obsidian-reserved characters and collapses whitespace", () => {
		expect(sanitizeNoteTitle('Plan: A/B "test" [v2] #now')).toBe("Plan A B test v2 now");
	});
	it("falls back to Untitled", () => {
		expect(sanitizeNoteTitle("///")).toBe("Untitled");
	});
});

describe("uniqueNotePath", () => {
	it("returns base.md when free, otherwise suffixes", () => {
		expect(uniqueNotePath(() => false, "Inbox", "Idea")).toBe("Inbox/Idea.md");
		const taken = new Set(["Inbox/Idea.md", "Inbox/Idea-2.md"]);
		expect(uniqueNotePath((p) => taken.has(p), "Inbox", "Idea")).toBe("Inbox/Idea-3.md");
	});
});

describe("appendWithSeparation", () => {
	it("ensures exactly one blank line between old and new content", () => {
		expect(appendWithSeparation("# Day\n- a\n\n\n", "- b")).toBe("# Day\n- a\n\n- b\n");
		expect(appendWithSeparation("", "- first")).toBe("- first\n");
	});
});

/** Minimal vault mock for the write tools. */
function makeApp(existingPaths: string[] = []) {
	const files = new Map<string, TFile>(
		existingPaths.map((p) => [p, Object.assign(new TFile(), { path: p })])
	);
	const created: Array<{ path: string; data: string }> = [];
	const processed: Array<{ path: string; result: string }> = [];
	const contents = new Map<string, string>();

	const app = {
		vault: {
			getAbstractFileByPath: (p: string) => files.get(p) ?? null,
			create: vi.fn(async (path: string, data: string) => {
				created.push({ path, data });
				const f = Object.assign(new TFile(), { path });
				files.set(path, f);
				return f;
			}),
			createFolder: vi.fn(async (path: string) => {
				files.set(path, Object.assign(new TFile(), { path })); // good enough for exists checks
			}),
			process: vi.fn(async (file: TFile, fn: (d: string) => string) => {
				const result = fn(contents.get(file.path) ?? "old content\n");
				processed.push({ path: file.path, result });
				return result;
			}),
			adapter: {
				read: vi.fn(async () => '{"folder": "Daily Notes"}'),
			},
			configDir: ".obsidian",
		},
	} as unknown as App;
	return { app, created, processed, contents, files };
}

describe("create_note", () => {
	it("asks for confirmation with the final path and writes on approval", async () => {
		const { app, created } = makeApp();
		const confirms: WriteRequest[] = [];
		const tools = buildWriteTools(app, {
			inboxFolder: "Lantern Inbox",
			confirm: async (req) => {
				confirms.push(req);
				return true;
			},
		});

		const out = await tools.create_note.execute({ title: "Tire shop", content: "Call them at 9." });

		expect(confirms[0]).toEqual({
			action: "create",
			path: "Lantern Inbox/Tire shop.md",
			preview: "Call them at 9.",
		});
		expect(created[0]).toEqual({ path: "Lantern Inbox/Tire shop.md", data: "Call them at 9.\n" });
		expect(out).toContain("[[Lantern Inbox/Tire shop.md]]");
	});

	it("writes NOTHING when the user declines", async () => {
		const { app, created } = makeApp();
		const tools = buildWriteTools(app, { inboxFolder: "Inbox", confirm: async () => false });

		const out = await tools.create_note.execute({ title: "X", content: "Y" });

		expect(out).toMatch(/declined/i);
		expect(created).toHaveLength(0);
	});

	it("uniquifies colliding titles", async () => {
		const { app, created } = makeApp(["Inbox/Idea.md"]);
		const tools = buildWriteTools(app, { inboxFolder: "Inbox", confirm: async () => true });
		await tools.create_note.execute({ title: "Idea", content: "more" });
		expect(created[0].path).toBe("Inbox/Idea-2.md");
	});
});

describe("append_to_daily_note", () => {
	it("appends to an existing daily note via vault.process", async () => {
		const now = new Date();
		const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
		const path = `Daily Notes/${today}.md`;
		const { app, processed, contents } = makeApp([path]);
		contents.set(path, "# Log\n- earlier\n");
		const tools = buildWriteTools(app, { inboxFolder: "Inbox", confirm: async () => true });

		const out = await tools.append_to_daily_note.execute({ text: "- bought tires" });

		expect(processed[0].path).toBe(path);
		expect(processed[0].result).toBe("# Log\n- earlier\n\n- bought tires\n");
		expect(out).toContain(`[[${path}]]`);
	});

	it("creates the daily note when missing (after approval)", async () => {
		const { app, created } = makeApp();
		const tools = buildWriteTools(app, { inboxFolder: "Inbox", confirm: async () => true });

		const out = await tools.append_to_daily_note.execute({ text: "- new entry", date: "2026-01-05" });

		expect(created[0].path).toBe("Daily Notes/2026-01-05.md");
		expect(created[0].data).toBe("- new entry\n");
		expect(out).toContain("Created");
	});

	it("rejects invalid dates without confirming anything", async () => {
		const { app } = makeApp();
		const confirm = vi.fn(async () => true);
		const tools = buildWriteTools(app, { inboxFolder: "Inbox", confirm });
		const out = await tools.append_to_daily_note.execute({ text: "x", date: "someday" });
		expect(out).toMatch(/invalid date/i);
		expect(confirm).not.toHaveBeenCalled();
	});
});
