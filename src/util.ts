/**
 * Tiny shared helpers used across modules (kept dependency-free so any layer
 * can import them without cycles).
 */

/** Truncate `str` to `max` characters, appending an ellipsis when it was cut. */
export function truncate(str: string, max: number): string {
	return str.length > max ? str.slice(0, max) + "…" : str;
}

/** Human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** decodeURIComponent that returns the input unchanged on malformed escapes. */
export function decodeUriSafe(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** Normalise a tag value: trim and drop a single leading `#`. */
export function normalizeTag(value: string): string {
	return value.trim().replace(/^#/, "");
}
