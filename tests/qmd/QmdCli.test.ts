import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "child_process";
import { QmdCli, parseCollectionNames, parseUpdateOutput, hasChanges } from "../../src/qmd/QmdCli";

const mockExecFile = vi.mocked(execFile);

type ExecError = (Error & { code?: string | number }) | null;

/** Make execFile invoke its callback with the given result. */
function mockExec(err: ExecError, stdout = "", stderr = "") {
	mockExecFile.mockImplementation(((_file: string, _args: string[], _opts: unknown, cb: (e: ExecError, o: string, s: string) => void) => {
		cb(err, stdout, stderr);
		return {} as never;
	}) as never);
}

const SAMPLE_LIST = `Collections (3):

unity-docs (qmd://unity-docs/)
  Pattern:  **/*.md
  Files:    44750

my-vault (qmd://my-vault/)
  Pattern:  **/*.md

project-docs (qmd://project-docs/)
  Files:    102
`;

describe("parseCollectionNames", () => {
	it("extracts collection names from list output", () => {
		expect(parseCollectionNames(SAMPLE_LIST)).toEqual([
			"unity-docs",
			"my-vault",
			"project-docs",
		]);
	});

	it("returns [] for empty/no-collection output", () => {
		expect(parseCollectionNames("No collections.")).toEqual([]);
	});
});

describe("parseUpdateOutput", () => {
	const SAMPLE_UPDATE = `Updating 3 collection(s)...

[1/3] my-vault (**/*.md)
Collection: /abs/vault (**/*.md)

Indexed: 2 new, 1 updated, 730 unchanged, 0 removed
Cleaned up 1 orphaned content hash(es)

[2/3] unity-docs (**/*.md)
    Running update command: ./refresh.sh
    Indexed something irrelevant from the custom command
Collection: /docs (**/*.md)

Indexed: 0 new, 0 updated, 44879 unchanged, 0 removed

[3/3] notes (**/*.md)
Collection: /notes (**/*.md)

Indexed: 0 new, 0 updated, 12 unchanged, 3 removed

✓ All collections updated.
Run 'qmd embed' to update embeddings (4 unique hashes need vectors)
`;

	it("associates Indexed counts with the right collection", () => {
		const parsed = parseUpdateOutput(SAMPLE_UPDATE);
		expect(parsed["my-vault"]).toEqual({ added: 2, updated: 1, unchanged: 730, removed: 0 });
		expect(parsed["unity-docs"]).toEqual({ added: 0, updated: 0, unchanged: 44879, removed: 0 });
		expect(parsed["notes"]).toEqual({ added: 0, updated: 0, unchanged: 12, removed: 3 });
	});

	it("ignores indented custom-update-command output", () => {
		const parsed = parseUpdateOutput(SAMPLE_UPDATE);
		expect(Object.keys(parsed)).toHaveLength(3);
	});

	it("returns {} for unexpected output", () => {
		expect(parseUpdateOutput("No collections found.")).toEqual({});
	});

	it("hasChanges is true for added/updated/removed, false otherwise", () => {
		expect(hasChanges({ added: 1, updated: 0, unchanged: 5, removed: 0 })).toBe(true);
		expect(hasChanges({ added: 0, updated: 1, unchanged: 5, removed: 0 })).toBe(true);
		expect(hasChanges({ added: 0, updated: 0, unchanged: 5, removed: 2 })).toBe(true);
		expect(hasChanges({ added: 0, updated: 0, unchanged: 5, removed: 0 })).toBe(false);
		expect(hasChanges(undefined)).toBe(false);
	});
});

describe("QmdCli", () => {
	const cli = new QmdCli({ binaryPath: "qmd" });

	beforeEach(() => vi.clearAllMocks());

	it("addCollection passes path, --name and --mask", async () => {
		mockExec(null, "Collection created", "");
		const res = await cli.addCollection("/vault", "my-vault", "**/*.md");

		expect(res.code).toBe(0);
		const args = mockExecFile.mock.calls[0][1];
		expect(args).toEqual([
			"collection",
			"add",
			"/vault",
			"--name",
			"my-vault",
			"--mask",
			"**/*.md",
		]);
	});

	it("embed limits to a collection and supports force", async () => {
		mockExec(null, "", "");
		await cli.embed("my-vault", true);
		expect(mockExecFile.mock.calls[0][1]).toEqual(["embed", "-f", "-c", "my-vault"]);
	});

	it("embed without collection embeds everything", async () => {
		mockExec(null, "", "");
		await cli.embed();
		expect(mockExecFile.mock.calls[0][1]).toEqual(["embed"]);
	});

	it("update re-indexes all collections", async () => {
		mockExec(null, "", "");
		await cli.update();
		expect(mockExecFile.mock.calls[0][1]).toEqual(["update"]);
	});

	it("setContext adds context on the collection root via a qmd:// path (text passed literally)", async () => {
		mockExec(null, "✓ Added context", "");
		await cli.setContext("my-vault", 'Personal notes: "projects" & journal');
		expect(mockExecFile.mock.calls[0][1]).toEqual([
			"context",
			"add",
			"qmd://my-vault/",
			'Personal notes: "projects" & journal',
		]);
	});

	it("removeContext clears the collection-root context", async () => {
		mockExec(null, "✓ Removed", "");
		await cli.removeContext("my-vault");
		expect(mockExecFile.mock.calls[0][1]).toEqual(["context", "rm", "qmd://my-vault/"]);
	});

	it("hasCollection reflects the collection list", async () => {
		mockExec(null, SAMPLE_LIST, "");
		expect(await cli.hasCollection("my-vault")).toBe(true);

		mockExec(null, SAMPLE_LIST, "");
		expect(await cli.hasCollection("absent")).toBe(false);
	});

	it("rejects with a helpful message when the binary is missing", async () => {
		mockExec(Object.assign(new Error("spawn qmd ENOENT"), { code: "ENOENT" }));
		await expect(cli.update()).rejects.toThrow(/binary not found/i);
	});

	it("resolves with the exit code on a non-zero (non-ENOENT) failure", async () => {
		mockExec(Object.assign(new Error("exited"), { code: 1 }), "", "Collection 'x' already exists.");
		const res = await cli.addCollection("/v", "x");
		expect(res.code).toBe(1);
		expect(res.stderr).toContain("already exists");
	});

	it("listCollectionNames throws when the CLI fails", async () => {
		mockExec(Object.assign(new Error("exited"), { code: 2 }), "", "config corrupted");
		await expect(cli.listCollectionNames()).rejects.toThrow(/collection list failed: config corrupted/);
	});

	it("version runs qmd --version", async () => {
		mockExec(null, "qmd 2.5.3 (6366024)", "");
		const res = await cli.version();
		expect(res.code).toBe(0);
		expect(mockExecFile.mock.calls[0][1]).toEqual(["--version"]);
	});
});
