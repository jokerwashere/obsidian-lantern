import { describe, it, expect, vi, beforeEach } from "vitest";

// tools.ts uses `instanceof TFile`, so TFile must be a runtime class here;
// everything else (moment, normalizePath) passes through from the mock module.
vi.mock("obsidian", async () => {
	const real = await vi.importActual<Record<string, unknown>>("obsidian");
	class TFile {
		path = "";
	}
	class App {}
	return { ...real, TFile, App };
});

import { TFile } from "obsidian";
import { buildTools, formatSearchResults, formatFile, truncateUtf8, cleanPathArg, fieldValue } from "../../src/agent/tools";
import type { App } from "obsidian";
import type { QmdService } from "../../src/qmd/QmdService";

function qmdResult(over: Partial<{ path: string; line: number; title: string; score: number; snippet: string; collection: string }> = {}) {
	return { path: "Notes/A.md", line: 3, title: "A", score: 0.9, snippet: "hello world", collection: "vault", docid: "#1", context: null, ...over };
}

/** A TFile-like mock with the fields the graph tools touch. */
function mkFile(path: string, basename: string, mtime = 0): TFile {
	const f = new TFile();
	f.path = path;
	(f as unknown as { basename: string }).basename = basename;
	(f as unknown as { stat: { mtime: number } }).stat = { mtime };
	return f;
}

const noQmd = {} as unknown as QmdService;

describe("formatSearchResults", () => {
	it("returns JSON with an empty results array for no hits", () => {
		expect(JSON.parse(formatSearchResults("x", []))).toEqual({ query: "x", results: [] });
	});
	it("returns JSON hits with path/line/score/title/snippet", () => {
		const parsed = JSON.parse(formatSearchResults("q", [qmdResult()]));
		expect(parsed.results[0]).toEqual({
			path: "Notes/A.md",
			line: 3,
			score: 0.9,
			title: "A",
			snippet: "hello world",
			link: "[[Notes/A.md]]", // ready-to-paste, no construction by the model
		});
	});
});

describe("formatSearchResults — JSON structure (path/title conflation)", () => {
	it("keeps multi-part titles intact and tidies frontmatter-window snippets", () => {
		const parsed = JSON.parse(
			formatSearchResults("global/it team", [
				qmdResult({
					path: "3. Resources/People/Internal/Alex Rivera.md",
					line: 3,
					title: "Alex Rivera - CIO - Internal",
					score: 0.91,
					snippet: "---\ntags:\n  - global/it\ntitle: CIO\n---",
				}),
			])
		);
		const hit = parsed.results[0];
		expect(hit.path).toBe("3. Resources/People/Internal/Alex Rivera.md");
		expect(hit.title).toBe("Alex Rivera - CIO - Internal");
		expect(hit.line).toBe(3);
		expect(hit.score).toBe(0.91);
		expect(hit.snippet).toBe("tags: global/it title: CIO");
	});

	it("preserves quotes and tricky characters LOSSLESSLY (JSON escaping)", () => {
		const parsed = JSON.parse(formatSearchResults("q", [qmdResult({ title: 'The "Big" Plan\nv2' })]));
		expect(parsed.results[0].title).toBe('The "Big" Plan\nv2');
	});
});

describe("formatFile", () => {
	const content = "line one\nline two\nline three";
	it("numbers lines and reports the count", () => {
		const out = formatFile("A.md", content, undefined, undefined, 10000);
		expect(out).toContain('path="A.md" (3 lines)');
		expect(out).toContain("1: line one");
		expect(out).toContain("3: line three");
	});
	it("reads a line range", () => {
		const out = formatFile("A.md", content, 2, 1, 10000);
		expect(out).toContain("lines 2–2 of 3");
		expect(out).toContain("2: line two");
		expect(out).not.toContain("line one");
	});
	it("truncates beyond maxBytes", () => {
		const out = formatFile("A.md", "x".repeat(500), undefined, undefined, 50);
		expect(out).toContain("[truncated");
	});
});

describe("fieldValue — tricky-character escaping", () => {
	it("degrades double quotes to apostrophes (never field-breaking)", () => {
		expect(fieldValue('He said "do it"')).toBe("\"He said 'do it'\"");
	});
	it("flattens newlines, tabs, and control characters to single spaces", () => {
		expect(fieldValue("line1\nline2\tend\u0007bell")).toBe('"line1 line2 end bell"');
	});
	it("passes apostrophes and unicode through unchanged", () => {
		expect(fieldValue("Zażółć 'gęślą' jaźń — ok")).toBe("\"Zażółć 'gęślą' jaźń — ok\"");
	});
	it("trims and collapses runs of whitespace", () => {
		expect(fieldValue("  a   b  ")).toBe('"a b"');
	});
});

describe("cleanPathArg", () => {
	it("unwraps quotes and wikilink brackets that models echo back", () => {
		expect(cleanPathArg('"3. Resources/People/X.md"')).toBe("3. Resources/People/X.md");
		expect(cleanPathArg("'A/B.md'")).toBe("A/B.md");
		expect(cleanPathArg("[[A/B.md]]")).toBe("A/B.md");
		expect(cleanPathArg(' "[[A/B.md]]" ')).toBe("A/B.md"); // nested wrapping
		expect(cleanPathArg("A/B.md")).toBe("A/B.md");
	});
});

describe("truncateUtf8", () => {
	it("measures real bytes, not UTF-16 units", () => {
		// "ż" is 2 bytes in UTF-8 — 10 chars = 20 bytes.
		const text = "ż".repeat(10);
		const { text: cut, truncated } = truncateUtf8(text, 10);
		expect(truncated).toBe(true);
		expect(cut).toBe("ż".repeat(5));
	});

	it("never splits a code point", () => {
		const { text: cut } = truncateUtf8("aż", 2); // would split ż at byte 2
		expect(cut).toBe("a");
	});

	it("passes short content through", () => {
		expect(truncateUtf8("abc", 10)).toEqual({ text: "abc", truncated: false });
	});
});

describe("buildTools", () => {
	let search: ReturnType<typeof vi.fn>;
	let getAbstractFileByPath: ReturnType<typeof vi.fn>;
	let cachedRead: ReturnType<typeof vi.fn>;
	let app: App;
	let qmd: QmdService;

	beforeEach(() => {
		search = vi.fn().mockResolvedValue([qmdResult()]);
		getAbstractFileByPath = vi.fn();
		cachedRead = vi.fn();
		app = {
			vault: { getAbstractFileByPath, cachedRead, getMarkdownFiles: () => [] },
		} as unknown as App;
		qmd = { search, collectionName: "vault" } as unknown as QmdService;
	});

	it("search_vault calls qmd.search scoped to the VAULT collection only", async () => {
		const tools = buildTools(app, qmd);
		const out = await tools.search_vault.execute({ query: "webhooks", mode: "text", limit: 3, intent: "git" });

		expect(search).toHaveBeenCalledWith("webhooks", {
			mode: "text",
			limit: 3,
			intent: "git",
			collections: ["vault"], // externals are search_references' job
		});
		const parsed = JSON.parse(out as string);
		expect(parsed.results[0].path).toBe("Notes/A.md");
		expect(parsed.results[0].line).toBe(3);
	});

	it("search_vault rejects an empty query", async () => {
		const tools = buildTools(app, qmd);
		expect(await tools.search_vault.execute({ query: "  " })).toMatch(/non-empty/);
		expect(search).not.toHaveBeenCalled();
	});

	it("search_vault forwards a hyde passage", async () => {
		const tools = buildTools(app, qmd);
		await tools.search_vault.execute({ query: "rate limits", hyde: "The limiter uses a token bucket." });
		expect(search.mock.calls[0][1].hyde).toBe("The limiter uses a token bucket.");
	});

	it("search_vault forwards `keywords` as a distinct lex query and the configured agent minScore", async () => {
		const tools = buildTools(app, qmd, { searchMinScore: 0.4 });
		await tools.search_vault.execute({ query: "how leadership decides", keywords: "OKR cockpit" });
		const call = search.mock.calls[0][1];
		expect(call.lex).toBe("OKR cockpit");
		expect(call.minScore).toBe(0.4);
	});

	it("search_vault omits lex when keywords is blank/absent", async () => {
		const tools = buildTools(app, qmd);
		await tools.search_vault.execute({ query: "webhooks", keywords: "   " });
		expect(search.mock.calls[0][1].lex).toBeUndefined();
	});

	it("search_vault forwards any_of alternatives (OR), dropping non-strings/blanks", async () => {
		const tools = buildTools(app, qmd);
		await tools.search_vault.execute({
			query: "IT people",
			any_of: ["IT director", "engineer", "", 42, "developer"],
		});
		expect(search.mock.calls[0][1].anyOf).toEqual(["IT director", "engineer", "developer"]);
	});

	/** App whose vault has tagged notes (for scope tests). */
	function scopedApp(): App {
		const files = [mkFile("Projects/Alpha.md", "Alpha"), mkFile("Journal/Day.md", "Day")];
		const tagsByPath: Record<string, string[]> = {
			"Projects/Alpha.md": ["project"],
			"Journal/Day.md": ["journal"],
		};
		return {
			vault: {
				getAbstractFileByPath: (p: string) => files.find((f) => f.path === p) ?? null,
				getMarkdownFiles: () => files,
				cachedRead,
			},
			metadataCache: {
				getFileCache: (f: TFile) => ({
					tags: (tagsByPath[f.path] ?? []).map((t) => ({ tag: `#${t}` })),
				}),
				resolvedLinks: {},
			},
		} as unknown as App;
	}

	it("search_vault scoped by tag over-fetches and keeps only in-scope notes", async () => {
		search.mockResolvedValue([
			qmdResult({ path: "Journal/Day.md", title: "Day" }),
			qmdResult({ path: "Projects/Alpha.md", title: "Alpha" }),
		]);
		const tools = buildTools(scopedApp(), qmd, { searchLimit: 6 });

		const out = await tools.search_vault.execute({ query: "plan", tag: "#project" });

		expect(search.mock.calls[0][1].limit).toBe(24); // over-fetched (6 → 24)
		const scoped = JSON.parse(out as string);
		expect(scoped.scope).toBe("#project");
		expect(scoped.results.map((r: { path: string }) => r.path)).toEqual(["Projects/Alpha.md"]);
	});

	it("search_vault falls back (with a note) when nothing is in scope", async () => {
		search.mockResolvedValue([qmdResult({ path: "Journal/Day.md", title: "Day" })]);
		const tools = buildTools(scopedApp(), qmd);

		const out = await tools.search_vault.execute({ query: "plan", tag: "project", folder: "Archive/" });

		const fallback = JSON.parse(out as string);
		expect(fallback.note).toMatch(/no notes match|none of the top results/i);
		expect(fallback.results.map((r: { path: string }) => r.path)).toContain("Journal/Day.md");
	});

	it("search_vault scopes by frontmatter where + within_days", async () => {
		const now = Date.now();
		const file = mkFile("P/active.md", "active", now - 1000);
		const appWhere = {
			vault: {
				getAbstractFileByPath: (p: string) => (p === "P/active.md" ? file : null),
				getMarkdownFiles: () => [file],
				cachedRead,
			},
			metadataCache: {
				getFileCache: () => ({ frontmatter: { status: "active" } }),
				resolvedLinks: {},
			},
		} as unknown as App;
		search.mockResolvedValue([qmdResult({ path: "P/active.md", title: "Active" })]);
		const tools = buildTools(appWhere, qmd);

		const out = await tools.search_vault.execute({
			query: "plan",
			where: "status=active",
			within_days: 7,
		});
		const whereOut = JSON.parse(out as string);
		expect(whereOut.scope).toBe("status=active, last 7 day(s)");
		expect(whereOut.results[0].path).toBe("P/active.md");
	});

	it("find_tasks lists open tasks with line numbers, newest note first", async () => {
		const a = mkFile("Work/Meeting.md", "Meeting", 2000);
		const b = mkFile("Home/List.md", "List", 1000);
		const caches: Record<string, unknown> = {
			"Work/Meeting.md": {
				listItems: [
					{ task: " ", position: { start: { line: 2 } } },
					{ task: "x", position: { start: { line: 3 } } },
				],
			},
			"Home/List.md": {
				listItems: [{ task: " ", position: { start: { line: 0 } } }],
			},
		};
		const bodies: Record<string, string> = {
			"Work/Meeting.md": "# M\nnotes\n- [ ] send the deck to Ann\n- [x] book the room",
			"Home/List.md": "- [ ] buy milk",
		};
		const appTasks = {
			vault: {
				getMarkdownFiles: () => [a, b],
				getAbstractFileByPath: () => null,
				cachedRead: async (f: TFile) => bodies[f.path],
			},
			metadataCache: {
				getFileCache: (f: TFile) => caches[f.path] ?? null,
				resolvedLinks: {},
			},
		} as unknown as App;

		const tools = buildTools(appTasks, noQmd);
		const out = await tools.find_tasks.execute({});

		const parsed = JSON.parse(out as string);
		expect(parsed.total).toBe(2);
		expect(parsed.status).toBe("open");
		expect(parsed.notes.map((n: { path: string }) => n.path)).toEqual(["Work/Meeting.md", "Home/List.md"]); // newest first
		expect(parsed.notes[0].tasks[0]).toEqual({ line: 3, status: "open", text: "send the deck to Ann" });
		expect(out).not.toContain("book the room"); // done task excluded by default

		const done = JSON.parse((await tools.find_tasks.execute({ status: "done" })) as string);
		expect(done.notes[0].tasks[0].text).toBe("book the room");
	});

	describe("reference tools", () => {
		const refOpts = (enabled: string[], over: Record<string, unknown> = {}) => ({
			references: {
				configured: ["pmbokguide", "apple-docs"],
				getEnabled: () => enabled,
				getRoots: () => ({ pmbokguide: "/refs/pmbok" }),
				readFile: async (p: string) => {
					if (p === "/refs/pmbok/scope/control.md") return "# Control Scope\nDetails here";
					throw new Error("missing");
				},
				...over,
			},
		});

		it("search_references searches only the enabled collections, labeled output", async () => {
			search.mockResolvedValue([
				qmdResult({ path: "scope/control.md", title: "Control Scope", collection: "pmbokguide" }),
			]);
			const tools = buildTools(app, qmd, refOpts(["pmbokguide"]));

			const out = await tools.search_references.execute({ query: "scope creep" });

			expect(search.mock.calls[0][1].collections).toEqual(["pmbokguide"]);
			const parsed = JSON.parse(out as string);
			expect(parsed.collections).toEqual(["pmbokguide"]);
			expect(parsed.results[0]).toMatchObject({
				collection: "pmbokguide",
				path: "scope/control.md",
				line: 3,
				title: "Control Scope",
			});
		});

		it("search_references forwards the full query craft + recall minScore (parity with search_vault)", async () => {
			search.mockResolvedValue([qmdResult({ path: "p.md", collection: "pmbokguide" })]);
			const tools = buildTools(app, qmd, { ...refOpts(["pmbokguide"]), searchMinScore: 0.4 });
			await tools.search_references.execute({
				query: "annual subscription pricing",
				keywords: "subscription_tier pro_yearly",
				hyde: "Pro costs $14.99/year or $2.99/month.",
				intent: "pricing, not the schema enum",
				any_of: ["yearly", "annual", "per year"],
			});
			const call = search.mock.calls[0][1];
			expect(call.lex).toBe("subscription_tier pro_yearly");
			expect(call.hyde).toBe("Pro costs $14.99/year or $2.99/month.");
			expect(call.intent).toBe("pricing, not the schema enum");
			expect(call.anyOf).toEqual(["yearly", "annual", "per year"]);
			expect(call.minScore).toBe(0.4);
			expect(call.collections).toEqual(["pmbokguide"]);
		});

		it("search_references reports when everything is disabled, without querying", async () => {
			const tools = buildTools(app, qmd, refOpts([]));
			const out = await tools.search_references.execute({ query: "x" });
			expect(out).toMatch(/No reference collections are enabled/i);
			expect(search).not.toHaveBeenCalled();
		});

		it("search_references rejects unknown and disabled collection args", async () => {
			const tools = buildTools(app, qmd, refOpts(["pmbokguide"]));
			expect(await tools.search_references.execute({ query: "x", collection: "nope" })).toMatch(/Unknown reference collection/);
			expect(await tools.search_references.execute({ query: "x", collection: "apple-docs" })).toMatch(/disabled for this chat/);
			expect(search).not.toHaveBeenCalled();
		});

		it("read_reference reads from the collection root with line numbers", async () => {
			const tools = buildTools(app, qmd, refOpts(["pmbokguide"]));
			const out = await tools.read_reference.execute({ collection: "pmbokguide", path: "scope/control.md" });
			expect(out).toContain('File: path="pmbokguide/scope/control.md" (2 lines)');
			expect(out).toContain("1: # Control Scope");
		});

		it("read_reference blocks traversal, unknown collections, and missing roots", async () => {
			const tools = buildTools(app, qmd, refOpts(["pmbokguide", "apple-docs"]));
			expect(await tools.read_reference.execute({ collection: "pmbokguide", path: "../../etc/passwd" })).toMatch(/may not contain/);
			expect(await tools.read_reference.execute({ collection: "evil", path: "x.md" })).toMatch(/not a configured/);
			expect(await tools.read_reference.execute({ collection: "apple-docs", path: "x.md" })).toMatch(/root folder .* unknown/);
		});

		it("read_reference surfaces unreadable paths gracefully", async () => {
			const tools = buildTools(app, qmd, refOpts(["pmbokguide"]));
			const out = await tools.read_reference.execute({ collection: "pmbokguide", path: "ghost.md" });
			expect(out).toMatch(/could not read/);
		});

		it("reference tools are absent when no collections are configured", () => {
			const tools = buildTools(app, qmd);
			expect(tools.search_references).toBeUndefined();
			expect(tools.read_reference).toBeUndefined();
		});
	});

	it("read_daily_notes reads a range, marking missing days", async () => {
		const now = new Date();
		const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
		const todayFile = mkFile(`Daily Notes/${today}.md`, today, 0);
		const appDaily = {
			vault: {
				getMarkdownFiles: () => [todayFile],
				getAbstractFileByPath: (p: string) => (p === todayFile.path ? todayFile : null),
				cachedRead: async () => "- did things\n- met people",
				adapter: { read: async () => '{"folder": "Daily Notes"}' },
				configDir: ".obsidian",
			},
			metadataCache: { getFileCache: () => null, resolvedLinks: {} },
		} as unknown as App;

		const tools = buildTools(appDaily, noQmd);
		const out = await tools.read_daily_notes.execute({ days: 2 });

		expect(out).toContain(`## date=${today} path="Daily Notes/${today}.md"`);
		expect(out).toContain("did things");
		expect(out).toContain("(no daily note)"); // yesterday missing
	});

	it("read_file returns live note content", async () => {
		const file = new TFile();
		getAbstractFileByPath.mockReturnValue(file);
		cachedRead.mockResolvedValue("alpha\nbeta");
		const tools = buildTools(app, qmd);

		const out = await tools.read_file.execute({ path: "Notes/A.md" });
		expect(cachedRead).toHaveBeenCalledWith(file);
		expect(out).toContain("Notes/A.md");
		expect(out).toContain("1: alpha");
	});

	it("read_file errors when the file is missing", async () => {
		getAbstractFileByPath.mockReturnValue(null);
		const tools = buildTools(app, qmd);
		expect(await tools.read_file.execute({ path: "missing.md" })).toMatch(/no file found/);
	});

	it("read_file self-heals a model-mangled folder path via basename (live-vault regression)", async () => {
		const real = "3. Resources/People/Internal/Alex Rivera.md";
		const file = mkFile(real, "Alex Rivera");
		getAbstractFileByPath.mockImplementation((p: string) => (p === real ? file : null));
		cachedRead.mockResolvedValue("# Alex Rivera\nHead of Global IT");
		(app.vault as unknown as { getMarkdownFiles: () => TFile[] }).getMarkdownFiles = () => [file];
		const tools = buildTools(app, qmd);

		const out = await tools.read_file.execute({ path: "Resources/People/Internal/Alex Rivera.md" });

		expect(out).toContain(`resolved to "${real}"`);
		expect(out).toContain(`cite [[${real}]]`);
		expect(out).toContain("Head of Global IT");
		expect(out).toContain(`File: path="${real}"`);
	});

	it("read_file lists did-you-mean candidates on ambiguous basenames", async () => {
		const a = mkFile("A/Standup.md", "Standup");
		const b = mkFile("B/Standup.md", "Standup");
		getAbstractFileByPath.mockReturnValue(null);
		(app.vault as unknown as { getMarkdownFiles: () => TFile[] }).getMarkdownFiles = () => [a, b];
		const tools = buildTools(app, qmd);

		const out = await tools.read_file.execute({ path: "Wrong/Standup.md" });
		expect(out).toMatch(/Did you mean: \[\[A\/Standup\.md\]\], \[\[B\/Standup\.md\]\]/);
	});
});

describe("get_note_info", () => {
	it("renders frontmatter, tags, headings, outgoing links and backlinks", async () => {
		const note = mkFile("Projects/Foo.md", "Foo");
		const app = {
			vault: { getAbstractFileByPath: () => note, getMarkdownFiles: () => [] },
			metadataCache: {
				getFileCache: () => ({
					frontmatter: {
						status: "active",
						tags: ["project"],
						description: 'He said "hi"\nsecond line',
					},
					headings: [{ heading: "Goals", level: 2 }],
					tags: [{ tag: "#wip" }],
				}),
				resolvedLinks: {
					"Projects/Foo.md": { "People/Alice.md": 1, "Areas/Health.md": 2 },
					"Index.md": { "Projects/Foo.md": 1 },
				},
			},
		} as unknown as App;

		const out = await buildTools(app, noQmd).get_note_info.execute({ path: "Projects/Foo.md" });
		const info = JSON.parse(out as string);
		expect(info.path).toBe("Projects/Foo.md");
		expect(info.link).toBe("[[Projects/Foo.md]]"); // ready-to-paste note link
		expect(info.properties.status).toBe("active");
		// JSON escaping is LOSSLESS — the multiline quoted value survives exactly
		expect(info.properties.description).toBe('He said "hi"\nsecond line');
		expect(info.tags).toContain("#project"); // frontmatter tag
		expect(info.tags).toContain("#wip"); // inline tag
		expect(info.headings.list).toEqual(["## Goals"]);
		// link-graph entries carry ready links too, so the model never builds them
		expect(info.links_out).toEqual({
			total: 2,
			notes: [
				{ path: "People/Alice.md", link: "[[People/Alice.md]]" },
				{ path: "Areas/Health.md", link: "[[Areas/Health.md]]" },
			],
		});
		expect(info.backlinks).toEqual({ total: 1, notes: [{ path: "Index.md", link: "[[Index.md]]" }] });
	});

	it("errors when the note is missing", async () => {
		const app = {
			vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
			metadataCache: { getFileCache: () => null, resolvedLinks: {} },
		} as unknown as App;
		expect(await buildTools(app, noQmd).get_note_info.execute({ path: "x.md" })).toMatch(/no file found/);
	});
});

describe("find_notes_by_tag", () => {
	it("matches inline and frontmatter tags, including nested", async () => {
		const a = mkFile("A.md", "A"), b = mkFile("B.md", "B"), c = mkFile("C.md", "C");
		const caches: Record<string, unknown> = {
			"A.md": { tags: [{ tag: "#project" }] },
			"B.md": { frontmatter: { tags: ["project/active"] } },
			"C.md": { tags: [{ tag: "#other" }] },
		};
		const app = {
			vault: { getMarkdownFiles: () => [a, b, c] },
			metadataCache: { getFileCache: (f: TFile) => caches[f.path] ?? null, resolvedLinks: {} },
		} as unknown as App;

		const out = await buildTools(app, noQmd).find_notes_by_tag.execute({ tag: "#project" });
		const parsed = JSON.parse(out as string);
		expect(parsed).toMatchObject({ tag: "#project", total: 2 });
		expect(parsed.notes).toEqual([
			{ path: "A.md", title: "A", link: "[[A.md]]" },
			{ path: "B.md", title: "B", link: "[[B.md]]" }, // nested project/active
		]);
	});

	it("reports when nothing matches", async () => {
		const app = {
			vault: { getMarkdownFiles: () => [] },
			metadataCache: { getFileCache: () => null, resolvedLinks: {} },
		} as unknown as App;
		const parsed = JSON.parse((await buildTools(app, noQmd).find_notes_by_tag.execute({ tag: "nope" })) as string);
		expect(parsed).toEqual({ tag: "#nope", total: 0, notes: [] });
	});
});

describe("list_recent_notes", () => {
	const day = 86_400_000;

	it("lists newest-first and respects within_days", async () => {
		const now = Date.now();
		const recent = mkFile("Recent.md", "Recent", now - day);
		const old = mkFile("Old.md", "Old", now - 30 * day);
		const app = {
			vault: { getMarkdownFiles: () => [old, recent] },
			metadataCache: { getFileCache: () => null, resolvedLinks: {} },
		} as unknown as App;

		const all = await buildTools(app, noQmd).list_recent_notes.execute({});
		expect(all.indexOf("Recent.md")).toBeLessThan(all.indexOf("Old.md")); // newest first

		const within = await buildTools(app, noQmd).list_recent_notes.execute({ within_days: 7 });
		expect(within).toContain("Recent.md");
		expect(within).not.toContain("Old.md");
	});
});
