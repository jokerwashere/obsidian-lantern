/**
 * Read collection roots from qmd's YAML config (read-only).
 *
 * `qmd collection list` does not print filesystem roots; they live in
 * ~/.config/qmd/index.yml (QMD_CONFIG_DIR / XDG_CONFIG_HOME respected) as
 * `collections.<name>.path`. We need them only to open results from non-vault
 * collections, so a tiny targeted parser beats a YAML dependency (the plugin
 * has none): collection names are two-space-indented `name:` keys under
 * `collections:`, and the root is the four-space-indented `path:` underneath.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve, sep } from "path";

/** Path of qmd's YAML config file. */
export function qmdConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	// qmd's own precedence (collections.ts getConfigDir): QMD_CONFIG_DIR, then
	// XDG_CONFIG_HOME/qmd, then ~/.config/qmd.
	if (env.QMD_CONFIG_DIR && env.QMD_CONFIG_DIR.length > 0) return join(env.QMD_CONFIG_DIR, "index.yml");
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

/**
 * qmd's embed lock file (qmd ≥2.8): `.qmd-embed.lock` next to the index DB,
 * holding the PID of the running `qmd embed`. Mirrors qmd's getDefaultDbPath:
 * INDEX_PATH, else `$XDG_CACHE_HOME/qmd/index.sqlite`, else `~/.cache/qmd/index.sqlite`.
 */
export function qmdEmbedLockPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	if (env.INDEX_PATH && env.INDEX_PATH.length > 0) return join(dirname(env.INDEX_PATH), ".qmd-embed.lock");
	const cacheHome = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0 ? env.XDG_CACHE_HOME : join(home, ".cache");
	return join(cacheHome, "qmd", ".qmd-embed.lock");
}

/**
 * PID holding qmd's embed lock, or null when the lock is absent, unreadable,
 * or stale (its process is gone — qmd recovers those on the next embed).
 * `isAlive` is injectable for tests (default: signal 0).
 */
export function embedLockHolder(
	lockPath: string = qmdEmbedLockPath(),
	read: (path: string) => string = (p) => readFileSync(p, "utf-8"),
	isAlive: (pid: number) => boolean = processAlive
): number | null {
	let pid: number;
	try {
		pid = parseInt(read(lockPath).trim(), 10);
	} catch {
		return null;
	}
	if (!Number.isInteger(pid) || pid <= 0) return null;
	return isAlive(pid) ? pid : null;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM = exists but owned by another user; still alive.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
