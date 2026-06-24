import { describe, it, expect } from "vitest";
import type { App, CachedMetadata } from "obsidian";
import {
	noteTags,
	tagMatches,
	scopeCandidates,
	parseScopeTokens,
	describeScope,
	scopedFetchLimit,
	parseWhere,
	frontmatterMatches,
} from "../../src/search/scope";

type FileSpec = {
	path: string;
	tags?: string[];
	fmTags?: unknown;
	frontmatter?: Record<string, unknown>;
	mtime?: number;
};

function makeApp(specs: FileSpec[]): App {
	const files = specs.map((s) => ({ path: s.path, stat: { mtime: s.mtime ?? 0 } }));
	const cacheByPath = new Map<string, CachedMetadata>(
		specs.map((s) => [
			s.path,
			{
				tags: (s.tags ?? []).map((t) => ({ tag: `#${t}` })),
				frontmatter:
					s.frontmatter ?? (s.fmTags !== undefined ? { tags: s.fmTags } : undefined),
			} as unknown as CachedMetadata,
		])
	);
	return {
		vault: { getMarkdownFiles: () => files },
		metadataCache: { getFileCache: (f: { path: string }) => cacheByPath.get(f.path) ?? null },
	} as unknown as App;
}

describe("tagMatches", () => {
	it("matches exact and nested tags, case-insensitively", () => {
		expect(tagMatches("project", "project")).toBe(true);
		expect(tagMatches("project/active", "project")).toBe(true);
		expect(tagMatches("Project/Active", "project")).toBe(true);
		expect(tagMatches("projects", "project")).toBe(false);
	});
});

describe("noteTags", () => {
	it("merges inline and frontmatter tags, deduped and sorted", () => {
		const cache = {
			tags: [{ tag: "#b" }, { tag: "#a" }],
			frontmatter: { tags: ["a", "c"] },
		} as unknown as CachedMetadata;
		expect(noteTags(cache)).toEqual(["#a", "#b", "#c"]);
	});
});

describe("scopeCandidates", () => {
	const app = makeApp([
		{ path: "Projects/Alpha.md", tags: ["project"] },
		{ path: "Projects/Beta.md", tags: ["project/active"] },
		{ path: "Journal/2026-06-01.md", tags: ["journal"] },
		{ path: "Projects/Notes/Misc.md", fmTags: "project, idea" },
		{ path: "Inbox/Loose.md" },
	]);

	it("returns null when no scope is given", () => {
		expect(scopeCandidates(app, {})).toBeNull();
		expect(scopeCandidates(app, { tag: " ", folder: "" })).toBeNull();
	});

	it("scopes by tag (inline, nested, and frontmatter)", () => {
		const set = scopeCandidates(app, { tag: "project" })!;
		expect([...set].sort()).toEqual([
			"Projects/Alpha.md",
			"Projects/Beta.md",
			"Projects/Notes/Misc.md",
		]);
	});

	it("scopes by folder prefix (whole segments, trailing slash optional)", () => {
		const set = scopeCandidates(app, { folder: "Projects" })!;
		expect(set.has("Projects/Alpha.md")).toBe(true);
		expect(set.has("Journal/2026-06-01.md")).toBe(false);
		expect(scopeCandidates(app, { folder: "/Projects/" })!.size).toBe(3);
	});

	it("intersects tag and folder", () => {
		const set = scopeCandidates(app, { tag: "project", folder: "Projects/Notes" })!;
		expect([...set]).toEqual(["Projects/Notes/Misc.md"]);
	});

	it("returns an empty set when nothing matches", () => {
		expect(scopeCandidates(app, { tag: "nope" })!.size).toBe(0);
	});

	it("accepts the tag with a leading '#'", () => {
		expect(scopeCandidates(app, { tag: "#journal" })!.size).toBe(1);
	});
});

describe("parseScopeTokens (tag tokens)", () => {
	it("extracts tags and leaves the rest of the query", () => {
		const p = parseScopeTokens("#meeting standup notes");
		expect(p.scope.tags).toEqual(["meeting"]);
		expect(p.rest).toBe("standup notes");
	});

	it("supports multiple and nested tags", () => {
		const p = parseScopeTokens("#a/b plan #c");
		expect(p.scope.tags).toEqual(["a/b", "c"]);
		expect(p.rest).toBe("plan");
	});

	it("ignores mid-word hashes", () => {
		const p = parseScopeTokens("C#9 features");
		expect(p.scope.tags).toBeUndefined();
		expect(p.hasScope).toBe(false);
		expect(p.rest).toBe("C#9 features");
	});

	it("returns empty rest for a tag-only query", () => {
		const p = parseScopeTokens("#journal");
		expect(p.scope.tags).toEqual(["journal"]);
		expect(p.rest).toBe("");
	});

	it("supports unicode tag characters", () => {
		const p = parseScopeTokens("#notatki dom");
		expect(p.scope.tags).toEqual(["notatki"]);
		expect(p.rest).toBe("dom");
	});
});

describe("scopedFetchLimit", () => {
	it("over-fetches with sane bounds", () => {
		expect(scopedFetchLimit(6)).toBe(24);
		expect(scopedFetchLimit(10)).toBe(40);
		expect(scopedFetchLimit(50)).toBe(60);
	});
});

describe("parseWhere", () => {
	it("parses comma-separated key=value pairs", () => {
		expect(parseWhere("status=active, type=project")).toEqual([
			{ key: "status", value: "active" },
			{ key: "type", value: "project" },
		]);
	});
	it("drops malformed segments", () => {
		expect(parseWhere("nope, =x, key=, a=b")).toEqual([{ key: "a", value: "b" }]);
	});
});

describe("frontmatterMatches", () => {
	it("matches scalars case-insensitively (incl. numbers/booleans)", () => {
		expect(frontmatterMatches({ Status: "Active" }, { key: "status", value: "active" })).toBe(true);
		expect(frontmatterMatches({ done: true }, { key: "done", value: "true" })).toBe(true);
		expect(frontmatterMatches({ priority: 2 }, { key: "priority", value: "2" })).toBe(true);
		expect(frontmatterMatches({ status: "paused" }, { key: "status", value: "active" })).toBe(false);
	});
	it("matches array-contains and missing keys/frontmatter as false", () => {
		expect(frontmatterMatches({ people: ["Ann", "Bo"] }, { key: "people", value: "bo" })).toBe(true);
		expect(frontmatterMatches({}, { key: "x", value: "y" })).toBe(false);
		expect(frontmatterMatches(undefined, { key: "x", value: "y" })).toBe(false);
	});
});

describe("scopeCandidates — where and withinDays", () => {
	const DAY = 86_400_000;
	const now = 1000 * DAY;
	const app = makeApp([
		{ path: "P/active.md", frontmatter: { status: "active" }, mtime: now - 2 * DAY },
		{ path: "P/paused.md", frontmatter: { status: "paused" }, mtime: now - 2 * DAY },
		{ path: "P/old-active.md", frontmatter: { status: "active" }, mtime: now - 90 * DAY },
	]);

	it("filters by frontmatter clauses (AND)", () => {
		const set = scopeCandidates(app, { where: parseWhere("status=active") })!;
		expect([...set].sort()).toEqual(["P/active.md", "P/old-active.md"]);
	});

	it("filters by withinDays and composes with where", () => {
		const set = scopeCandidates(app, { where: parseWhere("status=active"), withinDays: 7, now })!;
		expect([...set]).toEqual(["P/active.md"]);
	});

	it("withinDays alone is a valid scope", () => {
		const set = scopeCandidates(app, { withinDays: 7, now })!;
		expect(set.size).toBe(2);
	});
});

describe("scopeCandidates multi-tag (AND)", () => {
	const app = makeApp([
		{ path: "A.md", tags: ["project", "active"] },
		{ path: "B.md", tags: ["project"] },
		{ path: "C.md", tags: ["active"] },
	]);

	it("requires ALL tags to match", () => {
		expect([...scopeCandidates(app, { tags: ["project", "active"] })!]).toEqual(["A.md"]);
	});

	it("combines the single `tag` and `tags` (AND)", () => {
		expect([...scopeCandidates(app, { tag: "project", tags: ["active"] })!]).toEqual(["A.md"]);
	});
});

describe("parseScopeTokens", () => {
	it("returns no scope for plain text", () => {
		const p = parseScopeTokens("subscription pricing ideas");
		expect(p.hasScope).toBe(false);
		expect(p.rest).toBe("subscription pricing ideas");
		expect(p.scope).toEqual({});
	});

	it("extracts repeated #tags (AND) and leaves the rest", () => {
		const p = parseScopeTokens("#project #active roadmap slip");
		expect(p.scope.tags).toEqual(["project", "active"]);
		expect(p.rest).toBe("roadmap slip");
		expect(p.hasScope).toBe(true);
	});

	it("extracts folder:, within:Nd, and key=value (frontmatter)", () => {
		const p = parseScopeTokens("folder:Projects/ within:14d status=active pricing");
		expect(p.scope.folder).toBe("Projects/");
		expect(p.scope.withinDays).toBe(14);
		expect(p.scope.where).toEqual([{ key: "status", value: "active" }]);
		expect(p.rest).toBe("pricing");
	});

	it("supports quoted values with spaces", () => {
		const p = parseScopeTokens('folder:"1. Project/" status="in progress" notes');
		expect(p.scope.folder).toBe("1. Project/");
		expect(p.scope.where).toEqual([{ key: "status", value: "in progress" }]);
		expect(p.rest).toBe("notes");
	});

	it("accepts within: without the trailing d", () => {
		expect(parseScopeTokens("within:7 log").scope.withinDays).toBe(7);
	});
});

describe("describeScope", () => {
	it("renders a compact human-readable label", () => {
		expect(
			describeScope({
				tags: ["meeting"],
				folder: "Projects/",
				withinDays: 7,
				where: [{ key: "status", value: "active" }],
			})
		).toBe("#meeting folder:Projects/ within:7d status=active");
	});
});
