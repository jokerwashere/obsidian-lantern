/**
 * Read collection roots from qmd's YAML config (read-only).
 *
 * `qmd collection list` does not print filesystem roots; they live in
 * ~/.config/qmd/index.yml (XDG_CONFIG_HOME respected) as
 * `collections.<name>.path`. We need them only to open results from non-vault
 * collections, so a tiny targeted parser beats a YAML dependency (the plugin
 * has none): collection names are two-space-indented `name:` keys under
 * `collections:`, and the root is the four-space-indented `path:` underneath.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve, sep } from "path";

/** Path of qmd's YAML config file. */
export function qmdConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
		? env.XDG_CONFIG_HOME
		: join(home, ".config");
	return join(configHome, "qmd", "index.yml");
}

/** Strip matching single/double quotes around a YAML scalar. */
function unquote(value: string): string {
	const v = value.trim();
	if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
		return v.slice(1, -1);
	}
	return v;
}

/**
 * Parse `collection name → absolute root path` out of qmd's index.yml text.
 * Tolerant of unknown keys; ignores everything outside the `collections:` map.
 */
export function parseCollectionRoots(yamlText: string): Record<string, string> {
	const roots: Record<string, string> = {};
	let inCollections = false;
	let currentName: string | null = null;

	for (const rawLine of yamlText.split("\n")) {
		const line = rawLine.replace(/\t/g, "    ");
		if (/^collections:\s*$/.test(line)) {
			inCollections = true;
			currentName = null;
			continue;
		}
		if (!inCollections) continue;
		// A new top-level key ends the collections block.
		if (/^\S/.test(line) && line.trim().length > 0) {
			inCollections = false;
			continue;
		}
		const nameMatch = line.match(/^ {2}([^\s:][^:]*):\s*$/);
		if (nameMatch) {
			currentName = unquote(nameMatch[1]);
			continue;
		}
		const pathMatch = line.match(/^ {4}path:\s*(.+)$/);
		if (pathMatch && currentName) {
			roots[currentName] = unquote(pathMatch[1]);
		}
	}
	return roots;
}

/**
 * Collection roots from qmd's config, or {} when the file is missing or
 * unreadable. Synchronous and cheap (the file is small); callers invoke it
 * on demand (opening an external result), not in hot paths.
 */
export function readCollectionRoots(): Record<string, string> {
	try {
		return parseCollectionRoots(readFileSync(qmdConfigPath(), "utf-8"));
	} catch {
		return {};
	}
}

/**
 * Resolve a caller-supplied relative path against a collection root, refusing
 * anything that escapes the root. The `relPath` is UNTRUSTED — it originates
 * from LLM-authored citation links / tool args derived from note/web content,
 * so a poisoned source could try `../../etc/hosts` (or a backslash variant on
 * Windows). Normalises separators, rejects `..` segments, then canonicalises
 * and asserts the result stays within the root. Returns the absolute path, or
 * null when it would escape.
 */
export function resolveWithinRoot(root: string, relPath: string): string | null {
	const clean = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
	if (clean.split("/").some((seg) => seg === "..")) return null;
	const rootAbs = resolve(root);
	const abs = resolve(rootAbs, clean);
	if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null;
	return abs;
}
