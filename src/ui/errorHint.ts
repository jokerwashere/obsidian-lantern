/**
 * Pure error-message helpers for the chat pane (no Obsidian imports, so they are
 * unit-testable — the view itself is verified manually in Obsidian).
 */

import { HttpStatusError } from "../agent/LlmClient";
import { WireStreamError } from "../agent/wire/types";

/**
 * The "— is the LLM server running at …?" tail, or "" when the question would
 * mislead.
 *
 * It only helps when NOTHING answered. Both carve-outs are errors the server
 * itself produced, so asking whether it is running sends the user to check
 * connectivity while burying what the server actually said:
 *  - `HttpStatusError` — a non-200, e.g. a 400 naming the parameter it rejected.
 *  - `WireStreamError` — an error event delivered INSIDE a 200 stream, which is
 *    how Anthropic reports overload where a non-streaming call would be a 529.
 *    The connection was made and the server replied; it is plainly running.
 *
 * Everything else — connection refused, DNS failure, TLS error, a stalled
 * stream, an abort — keeps the hint, because those are the cases where a dead or
 * wrongly addressed server really is the likely cause.
 */
export function reachabilityHint(error: unknown, baseUrl: string): string {
	if (error instanceof HttpStatusError || error instanceof WireStreamError) return "";
	return ` — is the LLM server running at ${baseUrl}?`;
}
