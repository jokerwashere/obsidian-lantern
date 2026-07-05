/**
 * Client-side recency boost for search results ("Recent" chip).
 *
 * qmd ranks purely by relevance; in meeting-note-heavy vaults the recent hit
 * usually matters more than a slightly better match from years ago. The
 * boost multiplies the qmd score by a gentle recency factor and re-sorts —
 * the DISPLAYED score stays the raw qmd score.
 */

/**
 * 0.5 + 0.5·e^(−ageDays/30): 1.0 today, ≈0.84 after a month, asymptote 0.5 —
 * a strong old match can lose to a good recent one but is never buried.
 */
export function recencyFactor(ageDays: number): number {
	const age = Math.max(0, ageDays);
	return 0.5 + 0.5 * Math.exp(-age / 30);
}

export interface Rankable {
	score: number;
}

/**
 * Re-sort results by score × recency. `mtimeOf` returns a result's mtime in
 * ms, or null for results without recency semantics (non-vault collections,
 * unresolved paths) — those keep factor 1.0.
 */
export function applyRecencyBoost<T extends Rankable>(
	results: T[],
	mtimeOf: (result: T) => number | null,
	now: number = Date.now()
): T[] {
	const adjusted = results.map((r) => {
		const mtime = mtimeOf(r);
		const factor = mtime === null ? 1 : recencyFactor((now - mtime) / 86_400_000);
		return { r, value: r.score * factor };
	});
	adjusted.sort((a, b) => b.value - a.value);
	return adjusted.map((a) => a.r);
}

/** Over-fetch factor while recency-boosting (re-ranking needs material). */
export function recencyFetchLimit(limit: number): number {
	return Math.min(limit * 2, 50);
}
