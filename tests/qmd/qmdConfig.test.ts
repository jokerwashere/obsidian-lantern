import { describe, it, expect } from "vitest";
import {
	parseCollectionRoots,
	qmdConfigPath,
	resolveWithinRoot,
	qmdEmbedLockPath,
	embedLockHolder,
} from "../../src/qmd/qmdConfig";

/** Mirrors the real ~/.config/qmd/index.yml shape (verified on-machine). */
const SAMPLE_YAML = `collections:
  unity-docs:
    path: /Users/me/Projects/Unity/Docs
    pattern: "**/*.md"
  apple-docs:
    path: /Users/me/Projects/Docs/apple/markdown
    pattern: "**/*.md"
    context:
      "": Official Apple developer documentation, scraped to Markdown.
  my-vault:
    path: "/Users/me/Vaults/My Vault"
    pattern: "**/*.md"
    ignore:
      - "Sessions/**"
models:
  embed: hf:Qwen/Qwen3-Embedding-4B
`;

describe("parseCollectionRoots", () => {
	it("maps each collection to its root path", () => {
		const roots = parseCollectionRoots(SAMPLE_YAML);
		expect(roots["unity-docs"]).toBe("/Users/me/Projects/Unity/Docs");
		expect(roots["apple-docs"]).toBe("/Users/me/Projects/Docs/apple/markdown");
	});

	it("unquotes quoted paths", () => {
		const roots = parseCollectionRoots(SAMPLE_YAML);
		expect(roots["my-vault"]).toBe("/Users/me/Vaults/My Vault");
	});

	it("stops at the next top-level key", () => {
		const roots = parseCollectionRoots(SAMPLE_YAML);
		expect(Object.keys(roots)).toEqual(["unity-docs", "apple-docs", "my-vault"]);
	});

	it("returns {} for unrelated content", () => {
		expect(parseCollectionRoots("models:\n  embed: x\n")).toEqual({});
	});
});

describe("qmdConfigPath", () => {
	it("defaults to ~/.config/qmd/index.yml", () => {
		expect(qmdConfigPath({}, "/Users/me")).toBe("/Users/me/.config/qmd/index.yml");
	});

	it("respects XDG_CONFIG_HOME", () => {
		expect(qmdConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/Users/me")).toBe("/xdg/qmd/index.yml");
	});

	it("prefers QMD_CONFIG_DIR over XDG_CONFIG_HOME (qmd's own precedence)", () => {
		expect(qmdConfigPath({ QMD_CONFIG_DIR: "/cfg", XDG_CONFIG_HOME: "/xdg" }, "/Users/me")).toBe("/cfg/index.yml");
	});
});

describe("resolveWithinRoot", () => {
	const root = "/refs/pmbok";

	it("resolves a normal relative path under the root", () => {
		expect(resolveWithinRoot(root, "scope/control.md")).toBe("/refs/pmbok/scope/control.md");
		expect(resolveWithinRoot(root, "/scope/control.md")).toBe("/refs/pmbok/scope/control.md");
	});

	it("rejects `..` traversal (forward slash)", () => {
		expect(resolveWithinRoot(root, "../../etc/passwd")).toBeNull();
		expect(resolveWithinRoot(root, "a/../../etc/passwd")).toBeNull();
	});

	it("rejects backslash-separated traversal (Windows-style input)", () => {
		expect(resolveWithinRoot(root, "..\\..\\etc\\passwd")).toBeNull();
	});

	it("rejects a path that canonicalises outside the root without a literal `..` segment", () => {
		// A sibling directory sharing the root's prefix must not pass the guard.
		expect(resolveWithinRoot("/refs/pmbok", "../pmbok-secret/x.md")).toBeNull();
	});

	it("allows the root itself and a dotfile inside it", () => {
		expect(resolveWithinRoot(root, ".hidden.md")).toBe("/refs/pmbok/.hidden.md");
	});
});

describe("qmd embed lock", () => {
	it("sits next to qmd's index DB (INDEX_PATH > XDG_CACHE_HOME > ~/.cache)", () => {
		expect(qmdEmbedLockPath({}, "/Users/me")).toBe("/Users/me/.cache/qmd/.qmd-embed.lock");
		expect(qmdEmbedLockPath({ XDG_CACHE_HOME: "/xc" }, "/Users/me")).toBe("/xc/qmd/.qmd-embed.lock");
		expect(qmdEmbedLockPath({ INDEX_PATH: "/db/i.sqlite", XDG_CACHE_HOME: "/xc" }, "/Users/me")).toBe("/db/.qmd-embed.lock");
	});

	it("returns the holder PID only for a live process", () => {
		expect(embedLockHolder("/l", () => "4242\n", () => true)).toBe(4242);
		expect(embedLockHolder("/l", () => "4242\n", () => false)).toBeNull(); // stale lock
		expect(embedLockHolder("/l", () => "garbage", () => true)).toBeNull();
		expect(
			embedLockHolder(
				"/l",
				() => {
					throw new Error("ENOENT");
				},
				() => true
			)
		).toBeNull();
	});
});
