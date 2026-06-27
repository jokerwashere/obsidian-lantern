/**
 * Chat-history compaction between turns.
 *
 * Local models have small context windows; carrying every tool result forward
 * (an 8 KB read_file × several per turn) overflows them after a few
 * follow-ups, and the server then rejects the request outright. Compaction
 * keeps follow-ups cheap while preserving what matters:
 *
 *  - The most recent turn keeps its tool traffic, with each tool result
 *    truncated to `maxToolChars` (the model may still want to refer to it).
 *  - Older turns are reduced to their user question + final assistant answer;
 *    assistant tool_calls and tool messages are dropped *together*, so the
 *    OpenAI-style pairing (assistant.tool_calls ↔ tool.tool_call_id) stays
 *    valid for strict servers.
 *  - The total is capped at `maxMessages` by dropping the oldest turns whole.
 */

import type { ChatMessage } from "./LlmClient";
import { estimateMessagesChars } from "./contextBudget";

export interface CompactOptions {
	/** Per-tool-result character cap in the most recent turn. */
	maxToolChars: number;
	/** Total message cap (oldest whole turns dropped first). */
	maxMessages: number;
	/** Total character cap (oldest whole turns dropped first); omitted = no char cap. */
	maxHistoryChars?: number;
}

export const DEFAULT_COMPACT: CompactOptions = { maxToolChars: 700, maxMessages: 24 };

/** Split a (system-free) transcript into turns, each starting at a user message. */
function splitTurns(messages: ChatMessage[]): ChatMessage[][] {
	const turns: ChatMessage[][] = [];
	let current: ChatMessage[] = [];
	for (const msg of messages) {
		if (msg.role === "user" && current.length > 0) {
			turns.push(current);
			current = [];
		}
		current.push(msg);
	}
	if (current.length > 0) turns.push(current);
	return turns;
}

// Distinct from util.ts `truncate`: this appends a visible "[truncated]" marker
// so the model knows a tool result was cut, rather than a bare ellipsis.
function truncateForModel(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

/**
 * Reasoning is passed back WITHIN a run (templates need it across tool
 * round-trips), but a fresh question starts a fresh reasoning chain — and
 * stored thinking would bloat small contexts fast.
 */
function stripReasoning(msg: ChatMessage): ChatMessage {
	if (msg.reasoning_content === undefined) return msg;
	const rest = { ...msg };
	delete rest.reasoning_content;
	return rest;
}

/**
 * Compact a system-free message history (what the view carries between turns).
 * Pure; returns new message objects where content changes.
 */
export function compactHistory(
	messages: ChatMessage[],
	options: Partial<CompactOptions> = {}
): ChatMessage[] {
	const opts = { ...DEFAULT_COMPACT, ...options };
	const turns = splitTurns(messages);
	if (turns.length === 0) return [];

	const compacted: ChatMessage[][] = turns.map((turn, i) => {
		const isLatest = i === turns.length - 1;
		if (isLatest) {
			return turn.map((msg) => {
				const slim = stripReasoning(msg);
				return slim.role === "tool" && typeof slim.content === "string"
					? { ...slim, content: truncateForModel(slim.content, opts.maxToolChars) }
					: slim;
			});
		}
		// Older turn: keep the question and plain assistant answers only.
		return turn
			.filter(
				(msg) =>
					msg.role === "user" ||
					(msg.role === "assistant" && (!msg.tool_calls || msg.tool_calls.length === 0))
			)
			.map(stripReasoning);
	});

	// Cap total size by dropping oldest turns whole (always keep the latest) —
	// by message count, and by character count when a budget is provided.
	const charCap = opts.maxHistoryChars ?? Infinity;
	const tooBig = (r: ChatMessage[][]): boolean =>
		r.reduce((n, t) => n + t.length, 0) > opts.maxMessages ||
		r.reduce((n, t) => n + estimateMessagesChars(t), 0) > charCap;
	let result = compacted;
	while (result.length > 1 && tooBig(result)) {
		result = result.slice(1);
	}
	return result.flat();
}
