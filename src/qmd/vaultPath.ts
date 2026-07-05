/**
 * Map qmd result paths back to real vault file paths.
 *
 * Newer qmd returns literal (percent-encoded) paths, which QmdClient decodes —
 * those hit the exact-match fast path. Results indexed by older qmd are slugs
 * (spaces and " - " became "-", special characters stripped), which fail exact
 * lookup; those are resolved by comparing a separator-insensitive signature of
 * the slug against every vault markdown file's path — in ONE vault pass for a
 * whole batch of results, with per-path signatures memoized across calls
 * (signatures depend only on the path string, so the memo never goes stale;
 * renamed files simply produce new keys).
 */

import { App, TFile } from "obsidian";

/** Reduce a path to its alphanumeric tokens (separator-insensitive). */
export function pathSignature(path: string): string {
	return path
		.toLowerCase()
		.replace(/\.md$/, "")
		.replace(/[^a-z0-9]+/gi, " ")
		.trim();
}

/** Memo of vault-file path → signature (bounded by vault size; never stale). */
const signatureMemo = new Map<string, string>();

function memoizedSignature(path: string): string {
	let sig = signatureMemo.get(path);
	if (sig === undefined) {
		sig = pathSignature(path);
		signatureMemo.set(path, sig);
	}
	return sig;
}

/** Test hook: clear the signature memo. */
export function clearSignatureMemo(): void {
	signatureMemo.clear();
}

/**
 * Resolve a batch of qmd result paths to real vault file paths in a single
 * vault pass. Returns a map of input path → vault path (or null when no vault
 * file matches).
 */
export function resolveVaultPaths(app: App, qmdPaths: string[]): Map<string, string | null> {
	const out = new Map<string, string | null>();
	/** signature → qmd paths still waiting for a match */
	const pending = new Map<string, string[]>();

	for (const qmdPath of qmdPaths) {
		if (out.has(qmdPath)) continue;
		// Fast path: exact match (literal paths round-trip).
		if (app.vault.getAbstractFileByPath(qmdPath) instanceof TFile) {
			out.set(qmdPath, qmdPath);
			continue;
		}
		const sig = pathSignature(qmdPath);
		if (!sig) {
			out.set(qmdPath, null);
			continue;
		}
		out.set(qmdPath, null); // default until matched
		const waiters = pending.get(sig);
		if (waiters) waiters.push(qmdPath);
		else pending.set(sig, [qmdPath]);
	}

	if (pending.size > 0) {
		// When several vault files share one signature (an ambiguous slug),
		// resolve to the lexicographically smallest path so the result is
		// deterministic rather than dependent on vault iteration order.
		const bestForSig = new Map<string, string>();
		for (const file of app.vault.getMarkdownFiles()) {
			const sig = memoizedSignature(file.path);
			if (!pending.has(sig)) continue;
			const prev = bestForSig.get(sig);
			if (prev === undefined || file.path < prev) bestForSig.set(sig, file.path);
		}
		for (const [sig, waiters] of pending) {
			const best = bestForSig.get(sig);
			if (best !== undefined) for (const qmdPath of waiters) out.set(qmdPath, best);
		}
	}

	return out;
}

/**
 * Resolve a single qmd result path (possibly a slug) to a real vault file
 * path, or null if no vault file matches.
 */
export function resolveVaultPath(app: App, qmdPath: string): string | null {
	return resolveVaultPaths(app, [qmdPath]).get(qmdPath) ?? null;
}

export interface LooseResolution {
	/** Resolved vault path, or null when nothing (unambiguous) matched. */
	path: string | null;
	/** True when the resolved path differs from what was asked for. */
	corrected: boolean;
	/** Near-matches (by basename) when resolution was ambiguous or failed. */
	candidates: string[];
}

/**
 * Forgiving note-path resolution for MODEL-supplied paths. Small local models
 * routinely mangle folder segments — most commonly dropping PARA-style
 * numbered prefixes ("3. Resources/…" → "Resources/…"), which full-path
 * signatures cannot absorb (digits are signature tokens). The basename is
 * almost always reproduced faithfully, so after the exact/signature pass
 * fails we fall back to basename matching: a unique hit resolves (flagged as
 * corrected), multiple hits become "did you mean" candidates.
 */
export function resolveNotePathLoose(app: App, inputPath: string): LooseResolution {
	const direct = resolveVaultPath(app, inputPath);
	if (direct) return { path: direct, corrected: direct !== inputPath, candidates: [] };

	const base = (inputPath.split("/").pop() ?? inputPath).replace(/\.md$/i, "");
	const wantLower = base.toLowerCase();
	const wantSig = pathSignature(base);
	if (!wantLower) return { path: null, corrected: false, candidates: [] };

	const exact: string[] = [];
	const fuzzy: string[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		const name = file.basename.toLowerCase();
		if (name === wantLower) exact.push(file.path);
		else if (wantSig && pathSignature(file.basename) === wantSig) fuzzy.push(file.path);
	}
	const pool = exact.length > 0 ? exact : fuzzy;
	if (pool.length === 1) return { path: pool[0], corrected: true, candidates: [] };
	if (pool.length > 1) return { path: null, corrected: false, candidates: pool.slice(0, 5) };
	return { path: null, corrected: false, candidates: [] };
}
