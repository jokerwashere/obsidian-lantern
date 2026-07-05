import { describe, it, expect, vi } from "vitest";

// InputSuggest imports setIcon + extends Component at module load; the rest of
// the class is DOM-only and not exercised here (we test the pure functions).
vi.mock("obsidian", () => ({ setIcon: () => {}, Component: class {}, TFolder: class {} }));

import {
	detectToken,
	applyCompletion,
	selectFileSuggestions,
	selectTagSuggestions,
	selectFolderSuggestions,
	selectWithinSuggestions,
	selectFmValueSuggestions,
	flattenFmValue,
	type FileEntry,
	type TagEntry,
	type FolderEntry,
	type FmValueEntry,
} from "../../src/ui/InputSuggest";

function fileEntry(name: string, path: string, mtime: number): FileEntry {
	return {
		file: { basename: name, path, parent: { path: path.split("/").slice(0, -1).join("/") || "/" } } as never,
		lname: name.toLowerCase(),
		lpath: path.toLowerCase(),
	};
}
const tagEntry = (tag: string, count: number): TagEntry => ({ tag, lname: tag.slice(1).toLowerCase(), count });

describe("detectToken", () => {
	it("detects a [[ link token and its query", () => {
		const v = "summarize [[Proj";
		expect(detectToken(v, v.length)).toEqual({ kind: "link", start: 10, end: 16, query: "Proj" });
	});

	it("detects an empty [[ token (just opened)", () => {
		const v = "see [[";
		expect(detectToken(v, v.length)).toMatchObject({ kind: "link", query: "" });
	});

	it("does not treat a closed/invalid link as a token", () => {
		expect(detectToken("[[Done]] and now", 16)).toBeNull(); // ]] before caret
		expect(detectToken("[[a|b", 5)).toBeNull(); // alias pipe
		expect(detectToken("[[a#h", 5)).toBeNull(); // heading ref
	});

	it("detects a #tag at start or after whitespace", () => {
		expect(detectToken("#proj", 5)).toMatchObject({ kind: "tag", query: "proj", start: 0 });
		expect(detectToken("notes #wo", 9)).toMatchObject({ kind: "tag", query: "wo", start: 6 });
	});

	it("supports nested tags and ignores # mid-word", () => {
		expect(detectToken("#area/health", 12)).toMatchObject({ kind: "tag", query: "area/health" });
		expect(detectToken("C# rocks", 2)).toBeNull(); // # not after whitespace/start
	});

	it("returns null when the caret is not in a token", () => {
		expect(detectToken("plain query", 11)).toBeNull();
	});

	it("uses the caret position, not the end of the string", () => {
		const v = "[[Foo]] then #ba";
		expect(detectToken(v, 16)).toMatchObject({ kind: "tag", query: "ba" }); // caret at end
		expect(detectToken(v, 5)).toMatchObject({ kind: "link", query: "Foo" }); // caret inside [[Foo
	});

	it("detects folder:, within:, and key=value scope tokens", () => {
		expect(detectToken("pricing folder:Proj", 19)).toMatchObject({ kind: "folder", query: "Proj", start: 8 });
		expect(detectToken("log within:1", 12)).toMatchObject({ kind: "within", query: "1" });
		expect(detectToken("notes status=act", 16)).toMatchObject({ kind: "fmValue", key: "status", query: "act" });
	});

	it("captures a quoted folder value (spaces allowed)", () => {
		const v = 'folder:"1. Pro';
		expect(detectToken(v, v.length)).toMatchObject({ kind: "folder", query: "1. Pro" });
	});

	it("does not treat free text after a completed scope token as a scope", () => {
		const v = "folder:Projects/ pricing"; // caret in the free-text "pricing"
		expect(detectToken(v, v.length)).toBeNull();
	});
});

describe("applyCompletion", () => {
	it("splices a link completion in place of the token and positions the caret", () => {
		const value = "see [[Fo and more";
		const token = { kind: "link" as const, start: 4, end: 8, query: "Fo" };
		const r = applyCompletion(value, token, "[[Foo]]");
		expect(r.value).toBe("see [[Foo]] and more");
		expect(r.caret).toBe("see [[Foo]]".length);
	});
	it("splices a tag completion", () => {
		const value = "notes #wo";
		const token = { kind: "tag" as const, start: 6, end: 9, query: "wo" };
		const r = applyCompletion(value, token, "#work ");
		expect(r.value).toBe("notes #work ");
		expect(r.caret).toBe(value.length + 3); // "#work " replaced "#wo"
	});
});

describe("selectFileSuggestions", () => {
	const entries = [
		fileEntry("Recent Note", "A/Recent Note.md", 30),
		fileEntry("Project Plan", "B/Project Plan.md", 20),
		fileEntry("Old Project", "C/Old Project.md", 10),
	];

	it("returns most-recent first for an empty query", () => {
		const out = selectFileSuggestions(entries, "", 8);
		expect(out.map((i) => i.label)).toEqual(["Recent Note", "Project Plan", "Old Project"]);
		expect(out[0].insert).toBe("[[Recent Note]]");
	});
	it("ranks prefix matches above substring matches, keeping recency within each", () => {
		const out = selectFileSuggestions(entries, "project", 8).map((i) => i.label);
		expect(out).toEqual(["Project Plan", "Old Project"]); // 'Project Plan' prefix-matches first
	});
	it("matches on path too, and caps to max", () => {
		expect(selectFileSuggestions(entries, "c/", 8).map((i) => i.label)).toEqual(["Old Project"]);
		expect(selectFileSuggestions(entries, "", 2)).toHaveLength(2);
	});
});

describe("selectTagSuggestions", () => {
	// Pre-sorted by count desc, as the class guarantees before calling this.
	const entries = [tagEntry("#project", 9), tagEntry("#work", 5), tagEntry("#projector", 2)];

	it("returns most-used first for an empty query", () => {
		expect(selectTagSuggestions(entries, "", 8).map((i) => i.label)).toEqual(["#project", "#work", "#projector"]);
	});
	it("prefix-matches first, then substring, and formats insert with trailing space", () => {
		const out = selectTagSuggestions(entries, "proj", 8);
		expect(out.map((i) => i.label)).toEqual(["#project", "#projector"]);
		expect(out[0].insert).toBe("#project ");
	});
});

describe("selectFolderSuggestions", () => {
	const entries: FolderEntry[] = [
		{ path: "Projects", lpath: "projects" },
		{ path: "Projects/Active", lpath: "projects/active" },
		{ path: "1. Project", lpath: "1. project" },
	];
	it("prefix-matches and inserts a trailing-slash folder token", () => {
		const out = selectFolderSuggestions(entries, "projects", 8);
		expect(out.map((i) => i.label)).toEqual(["Projects", "Projects/Active"]);
		expect(out[0].insert).toBe("folder:Projects/ ");
	});
	it("quotes a folder path with spaces", () => {
		expect(selectFolderSuggestions(entries, "1.", 8)[0].insert).toBe('folder:"1. Project/" ');
	});
});

describe("selectWithinSuggestions", () => {
	it("offers day presets, filtered by digits typed", () => {
		expect(selectWithinSuggestions("").map((i) => i.label)).toContain("within:7d");
		expect(selectWithinSuggestions("9").map((i) => i.label)).toEqual(["within:90d"]);
		expect(selectWithinSuggestions("1").map((i) => i.label)).toEqual(["within:14d"]);
	});
	it("inserts a complete within token with trailing space", () => {
		expect(selectWithinSuggestions("7")[0].insert).toBe("within:7d ");
	});
});

describe("selectFmValueSuggestions", () => {
	// Pre-sorted by count desc, as the class guarantees before calling this.
	const entries: FmValueEntry[] = [
		{ value: "done", lvalue: "done", count: 9 },
		{ value: "active", lvalue: "active", count: 5 },
		{ value: "archived", lvalue: "archived", count: 2 },
	];
	it("ranks by query and inserts key=value with trailing space", () => {
		const out = selectFmValueSuggestions(entries, "status", "a");
		expect(out.map((i) => i.label)).toEqual(["status=active", "status=archived"]);
		expect(out[0].insert).toBe("status=active ");
	});
	it("empty query → most-used first", () => {
		expect(selectFmValueSuggestions(entries, "status", "")[0].label).toBe("status=done");
	});
});

describe("flattenFmValue", () => {
	it("flattens scalars and arrays, dropping objects/null", () => {
		expect(flattenFmValue("active")).toEqual(["active"]);
		expect(flattenFmValue(3)).toEqual(["3"]);
		expect(flattenFmValue(["a", "b"])).toEqual(["a", "b"]);
		expect(flattenFmValue(null)).toEqual([]);
		expect(flattenFmValue({ x: 1 })).toEqual([]);
	});
});
