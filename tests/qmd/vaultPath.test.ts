import { describe, it, expect, vi } from "vitest";

vi.mock("obsidian", () => {
	class TFile {
		path = "";
	}
	return { TFile };
});

import { TFile } from "obsidian";
import type { App } from "obsidian";
import {
	pathSignature,
	resolveVaultPath,
	resolveVaultPaths,
	resolveNotePathLoose,
	clearSignatureMemo,
} from "../../src/qmd/vaultPath";

function tfile(path: string): TFile {
	return Object.assign(new TFile(), { path });
}

function makeApp(vaultFiles: string[], exact: string[] = []): App {
	const files = vaultFiles.map((p) => {
		const f = tfile(p);
		const name = p.split("/").pop() ?? p;
		(f as unknown as { basename: string }).basename = name.replace(/\.md$/, "");
		return f;
	});
	const exactSet = new Set(exact);
	return {
		vault: {
			getAbstractFileByPath: (p: string) => (exactSet.has(p) ? tfile(p) : null),
			getMarkdownFiles: () => files,
		},
	} as unknown as App;
}

describe("pathSignature", () => {
	it("is separator-insensitive (spaces, dashes, ' - ' all collapse)", () => {
		const real = "Projects/Planning 2025/Acme Corp - Senior Account Manager - Finance.md";
		const slug = "Projects/Planning-2025/Acme-Corp-Senior-Account-Manager-Finance.md";
		expect(pathSignature(real)).toBe(pathSignature(slug));
	});

	it("drops the .md extension", () => {
		expect(pathSignature("a/b.md")).toBe("a b");
	});
});

describe("resolveVaultPath", () => {
	const realPath = "Projects/Planning 2025/Acme Corp - Senior Account Manager - Finance.md";
	const slug = "Projects/Planning-2025/Acme-Corp-Senior-Account-Manager-Finance.md";

	it("returns the path directly when it exists exactly", () => {
		const app = makeApp(["Notes/Simple.md"], ["Notes/Simple.md"]);
		expect(resolveVaultPath(app, "Notes/Simple.md")).toBe("Notes/Simple.md");
	});

	it("resolves an ambiguous signature to the lexicographically smallest path", () => {
		clearSignatureMemo();
		// Both files reduce to the same signature ("a foo bar"); the smallest path
		// must win regardless of vault iteration order (here the larger is first).
		const app = makeApp(["a/Foo-Bar.md", "a/Foo Bar.md"]);
		expect(resolveVaultPath(app, "a/foo-bar.md")).toBe("a/Foo Bar.md");
	});

	it("resolves a qmd slug back to the real spaced path", () => {
		const app = makeApp([realPath]); // not an exact match for the slug
		expect(resolveVaultPath(app, slug)).toBe(realPath);
	});

	it("returns null when nothing matches", () => {
		const app = makeApp(["Notes/Other.md"]);
		expect(resolveVaultPath(app, "Missing/Thing.md")).toBeNull();
	});
});

describe("resolveVaultPaths (batch)", () => {
	const realPath = "Projects/Planning 2025/Acme Corp - Senior Account Manager - Finance.md";
	const slug = "Projects/Planning-2025/Acme-Corp-Senior-Account-Manager-Finance.md";

	it("resolves a mixed batch in one vault pass", () => {
		clearSignatureMemo();
		const files = [realPath, "Notes/Simple.md", "Notes/Other Note.md"];
		const app = makeApp(files, ["Notes/Simple.md"]);
		const spy = vi.spyOn(app.vault, "getMarkdownFiles");

		const out = resolveVaultPaths(app, [
			"Notes/Simple.md", // exact
			slug, // slugged
			"notes/other-note.md", // slugged, different case
			"Missing/Nope.md", // no match
		]);

		expect(out.get("Notes/Simple.md")).toBe("Notes/Simple.md");
		expect(out.get(slug)).toBe(realPath);
		expect(out.get("notes/other-note.md")).toBe("Notes/Other Note.md");
		expect(out.get("Missing/Nope.md")).toBeNull();
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("skips the vault pass entirely when all inputs match exactly", () => {
		const app = makeApp(["A.md", "B.md"], ["A.md", "B.md"]);
		const spy = vi.spyOn(app.vault, "getMarkdownFiles");
		const out = resolveVaultPaths(app, ["A.md", "B.md"]);
		expect(out.get("A.md")).toBe("A.md");
		expect(spy).not.toHaveBeenCalled();
	});

	it("handles duplicate input paths", () => {
		const app = makeApp([realPath]);
		const out = resolveVaultPaths(app, [slug, slug]);
		expect(out.size).toBe(1);
		expect(out.get(slug)).toBe(realPath);
	});
});

describe("resolveNotePathLoose", () => {
	// A live-vault regression: the model dropped the "3. " PARA prefix, which
	// full-path signatures cannot absorb (digits are signature tokens).
	const real = "3. Resources/People/Internal/Alex Rivera.md";

	it("recovers a dropped numbered-folder prefix via unique basename", () => {
		const app = makeApp([real, "1. Projects/Plan.md"]);
		const out = resolveNotePathLoose(app, "Resources/People/Internal/Alex Rivera.md");
		expect(out.path).toBe(real);
		expect(out.corrected).toBe(true);
	});

	it("passes exact paths through uncorrected", () => {
		const app = makeApp([real], [real]);
		const out = resolveNotePathLoose(app, real);
		expect(out).toEqual({ path: real, corrected: false, candidates: [] });
	});

	it("matches basenames case-insensitively and via signature (dashes)", () => {
		const app = makeApp([real]);
		expect(resolveNotePathLoose(app, "people/alex rivera.md").path).toBe(real);
		expect(resolveNotePathLoose(app, "x/Alex-Rivera.md").path).toBe(real);
	});

	it("returns candidates instead of guessing when the basename is ambiguous", () => {
		const app = makeApp(["A/Notes.md", "B/Notes.md", "C/Notes.md"]);
		const out = resolveNotePathLoose(app, "Wrong/Notes.md");
		expect(out.path).toBeNull();
		expect(out.candidates).toEqual(["A/Notes.md", "B/Notes.md", "C/Notes.md"]);
	});

	it("returns empty-handed for a genuinely unknown note", () => {
		const app = makeApp([real]);
		expect(resolveNotePathLoose(app, "Nope/Unknown Person.md")).toEqual({
			path: null,
			corrected: false,
			candidates: [],
		});
	});
});
