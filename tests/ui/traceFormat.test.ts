import { describe, it, expect } from "vitest";
import {
	toolIconName,
	friendlyToolLabel,
	toolOutcome,
	baseName,
	prettyJson,
	shorten,
	parseToolResult,
	parseQmdHref,
	externalRefFromPath,
} from "../../src/ui/traceFormat";

describe("toolIconName", () => {
	it("maps known tools and falls back to wrench", () => {
		expect(toolIconName("search_vault")).toBe("search");
		expect(toolIconName("read_file")).toBe("file-text");
		expect(toolIconName("web_search")).toBe("globe");
		expect(toolIconName("whatever")).toBe("wrench");
	});
});

describe("friendlyToolLabel", () => {
	it("describes a search with its query", () => {
		expect(friendlyToolLabel("search_vault", '{"query":"rust ownership"}')).toBe(
			"Searching your notes for “rust ownership”"
		);
	});

	it("appends tag/folder scope when present", () => {
		expect(
			friendlyToolLabel("search_vault", '{"query":"plan","tag":"#project","folder":"Work/"}')
		).toBe("Searching your notes for “plan” (in #project, Work/)");
	});

	it("uses the basename for file reads", () => {
		expect(friendlyToolLabel("read_file", '{"path":"Projects/Foo.md"}')).toBe("Reading Foo.md");
	});

	it("survives malformed JSON args", () => {
		expect(friendlyToolLabel("search_vault", "{broken")).toBe("Searching your notes");
	});

	it("labels the reference tools", () => {
		expect(friendlyToolLabel("search_references", '{"query":"scope creep","collection":"pmbokguide"}')).toBe(
			"Consulting pmbokguide for “scope creep”"
		);
		expect(friendlyToolLabel("read_reference", '{"collection":"pmbokguide","path":"a/b.md"}')).toBe(
			"Reading b.md (pmbokguide)"
		);
	});

	it("labels the task / daily / write tools", () => {
		expect(friendlyToolLabel("find_tasks", '{"tag":"work"}')).toBe("Finding open tasks (in #work)");
		expect(friendlyToolLabel("find_tasks", '{"status":"done"}')).toBe("Finding done tasks");
		expect(friendlyToolLabel("read_daily_notes", '{"days":7}')).toBe("Reading daily notes (7 days)");
		expect(friendlyToolLabel("create_note", '{"title":"Tire shop"}')).toBe("Creating note “Tire shop”");
		expect(friendlyToolLabel("append_to_daily_note", "{}")).toBe("Adding to the daily note");
	});

	it("labels web search", () => {
		expect(friendlyToolLabel("web_search", '{"query":"llm news"}')).toBe("Searching the web for “llm news”");
	});

	it("humanizes unknown tools", () => {
		expect(friendlyToolLabel("future_tool", "{}")).toBe("Running future tool");
	});
});

describe("toolOutcome", () => {
	it("counts JSON search results", () => {
		expect(toolOutcome("search_vault", '{"query":"x","results":[{},{},{}]}')).toBe("3 notes");
		expect(toolOutcome("search_vault", '{"query":"x","scope":"#p","results":[{}]}')).toBe("1 note");
		expect(toolOutcome("search_vault", '{"query":"x","results":[]}')).toBe("no matches");
		expect(toolOutcome("web_search", '{"query":"x","results":[{},{}]}')).toBe("2 results");
		expect(toolOutcome("web_search", '{"query":"x","results":[]}')).toBe("no results");
	});

	it("flags errors", () => {
		expect(toolOutcome("read_file", "Error: no file found")).toBe("error");
	});

	it("summarizes reads, links, tags and recents", () => {
		expect(toolOutcome("read_file", 'File: path="a.md" (12 lines)\n1: x')).toBe("12 lines");
		expect(toolOutcome("get_note_info", '{"path":"a.md","links_out":{"total":2,"paths":[]},"backlinks":{"total":5,"paths":[]}}')).toBe("2 out · 5 back");
		expect(toolOutcome("find_notes_by_tag", '{"tag":"#x","total":4,"notes":[]}')).toBe("4 notes");
		expect(toolOutcome("find_notes_by_tag", '{"tag":"#x","total":0,"notes":[]}')).toBe("none");
		expect(toolOutcome("list_recent_notes", '{"notes":[{"path":"a"},{"path":"b"}]}')).toBe("2 notes");
	});

	it("summarizes reference outcomes", () => {
		expect(toolOutcome("search_references", '{"query":"x","collections":["pmbokguide"],"results":[{},{}]}')).toBe("2 hits");
		expect(toolOutcome("search_references", '{"query":"x","collections":["pmbokguide"],"results":[]}')).toBe("no matches");
		expect(toolOutcome("search_references", "No reference collections are enabled for this chat …")).toBe("disabled");
		expect(toolOutcome("read_reference", 'File: path="pmbokguide/a.md" (40 lines)\n1: x')).toBe("40 lines");
	});

	it("summarizes tasks, daily notes, and write outcomes", () => {
		expect(toolOutcome("find_tasks", '{"status":"open","total":3,"notes":[]}')).toBe("3 tasks");
		expect(toolOutcome("find_tasks", '{"status":"open","total":0,"notes":[]}')).toBe("none");
		expect(toolOutcome("read_daily_notes", '## date=2026-06-12 path="a.md"\nx\n\n## date=2026-06-11 (no daily note)')).toBe("2 days");
		expect(toolOutcome("create_note", "Created [[Inbox/X.md]].")).toBe("created");
		expect(toolOutcome("append_to_daily_note", 'User declined appending to "D/x.md".')).toBe("declined");
	});
});

describe("small helpers", () => {
	it("baseName returns the last segment", () => {
		expect(baseName("a/b/C.md")).toBe("C.md");
		expect(baseName("C.md")).toBe("C.md");
	});
	it("prettyJson formats valid JSON and passes through junk", () => {
		expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
		expect(prettyJson("junk")).toBe("junk");
	});
	it("shorten collapses whitespace and ellipsizes", () => {
		expect(shorten("a   b", 10)).toBe("a b");
		expect(shorten("abcdef", 3)).toBe("abc…");
	});
});

describe("parseToolResult", () => {
	it("parses search results incl. scope/note and reference collections", () => {
		const vault = parseToolResult(
			"search_vault",
			'{"query":"q","scope":"#p","note":"fallback","results":[{"path":"A.md","line":3,"score":0.91,"title":"A","snippet":"s"}]}'
		);
		expect(vault).toEqual({
			kind: "search",
			scope: "#p",
			note: "fallback",
			hits: [{ collection: undefined, path: "A.md", line: 3, score: 0.91, title: "A", snippet: "s" }],
		});
		const refs = parseToolResult(
			"search_references",
			'{"query":"q","collections":["pmbok"],"results":[{"collection":"pmbok","path":"x.md","line":1,"score":0.8,"title":"X"}]}'
		);
		expect(refs?.kind).toBe("search");
		expect((refs as { hits: Array<{ collection?: string }> }).hits[0].collection).toBe("pmbok");
	});

	it("parses note lists, tasks, and note info", () => {
		expect(
			parseToolResult("find_notes_by_tag", '{"tag":"#x","total":1,"notes":[{"path":"A.md","title":"A"}]}')
		).toMatchObject({ kind: "notes", total: 1, notes: [{ path: "A.md", title: "A" }] });

		expect(
			parseToolResult(
				"find_tasks",
				'{"status":"open","total":1,"notes":[{"path":"W.md","modified":"2026-06-12","tasks":[{"line":3,"status":"open","text":"do it"}]}]}'
			)
		).toMatchObject({ kind: "tasks", total: 1, notes: [{ path: "W.md", tasks: [{ line: 3, text: "do it" }] }] });

		expect(
			parseToolResult(
				"get_note_info",
				'{"path":"P.md","link":"[[P.md]]","properties":{"status":"active"},"tags":["#a"],"links_out":{"total":1,"notes":[{"path":"B.md","link":"[[B.md]]"}]},"backlinks":{"total":0,"notes":[]}}'
			)
		).toMatchObject({ kind: "noteInfo", path: "P.md", tags: ["#a"], linksOut: { total: 1, paths: ["B.md"] } });
	});

	it("returns null for content tools, prose, and malformed JSON", () => {
		expect(parseToolResult("read_file", 'File: path="a.md" (3 lines)')).toBeNull();
		expect(parseToolResult("search_vault", "Error: nope")).toBeNull();
		expect(parseToolResult("search_vault", "{broken")).toBeNull();
		expect(parseToolResult("create_note", "Created [[x]].")).toBeNull();
	});

	it("drops malformed entries instead of failing", () => {
		const out = parseToolResult("search_vault", '{"results":[{"nopath":true},{"path":"ok.md"}]}');
		expect((out as { hits: unknown[] }).hits).toHaveLength(1);
	});
});

describe("reference link parsing (chat citations → external open)", () => {
	it("parses qmd:// reference hrefs, decoding %20 and stripping #anchors", () => {
		expect(parseQmdHref("qmd://pmbokguide/scope/control.md")).toEqual({
			collection: "pmbokguide",
			path: "scope/control.md",
		});
		expect(parseQmdHref("qmd://apple-docs/SwiftUI/View%20Basics.md#Overview")).toEqual({
			collection: "apple-docs",
			path: "SwiftUI/View Basics.md",
		});
	});

	it("returns null for non-qmd hrefs and scheme-only/no-path", () => {
		expect(parseQmdHref("Projects/Foo.md")).toBeNull();
		expect(parseQmdHref("https://example.com")).toBeNull();
		expect(parseQmdHref("qmd://pmbokguide")).toBeNull(); // no path segment
	});

	it("routes a bare path ONLY when its first segment is a configured collection", () => {
		const cols = ["pmbokguide", "apple-docs"];
		expect(externalRefFromPath("pmbokguide/scope/control.md", cols)).toEqual({
			collection: "pmbokguide",
			path: "scope/control.md",
		});
		// A real vault path (folder not a reference collection) is left alone.
		expect(externalRefFromPath("Projects/Foo.md", cols)).toBeNull();
		// Top-level note (no folder) is not a reference.
		expect(externalRefFromPath("Foo.md", cols)).toBeNull();
	});
});
