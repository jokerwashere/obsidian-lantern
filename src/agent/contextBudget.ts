/**
 * Context-window-aware budgets.
 *
 * Local LLMs run with a fixed context (llama-server `-c`). We detect it
 * (LlmClient.getContextSize) and size the agent's per-run tool-result budget
 * and the between-turn history compaction to fit — instead of fixed constants
 * that overflow small contexts and waste large ones.
 *
 * Budgets are in CHARACTERS (the codebase measures text in chars, not tokens);
 * we convert the token context with a deliberately LOW chars-per-token ratio so
 * we under-fill rather than overflow.
 */

/** Conservative chars-per-token (English/markdown/paths run ~3.5–4; low = safe). */
export const CHARS_PER_TOKEN = 3.5;

/** Used when the server's context can't be detected and no override is set. */
export const FALLBACK_CONTEXT_TOKENS = 8192;

export interface CompactBudget {
	/** Per-tool-result cap in the most recent (kept) turn. */
	maxToolChars: number;
	/** Total message-count cap (oldest whole turns dropped first). */
	maxMessages: number;
	/** Total character cap for carried history (oldest whole turns dropped first). */
	maxHistoryChars: number;
}

export interface ContextBudget {
	/** Context size used (detected, override, or fallback), in tokens. */
	ctxTokens: number;
	/** Characters we may put into one request's prompt (everything we send). */
	promptChars: number;
	/** Between-turn compaction budget. */
	compact: CompactBudget;
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, n));
}

/**
 * Derive character budgets from a token context size. Pure.
 *
 * Reserves room for the model's reply (incl. thinking), converts the remaining
 * token budget to characters, then carves the compaction allowances from it.
 */
export function deriveContextBudget(ctxTokens: number, charsPerToken: number = CHARS_PER_TOKEN): ContextBudget {
	const ctx = Number.isFinite(ctxTokens) && ctxTokens > 0 ? Math.floor(ctxTokens) : FALLBACK_CONTEXT_TOKENS;
	const ratio = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : CHARS_PER_TOKEN;
	// Reserve for the answer/thinking, but never let it eat more than ~60% of a
	// tiny context (so prompt budget stays usable on 2–4k-context models).
	const outputReserve = clamp(Math.round(ctx * 0.2), 1024, 8192);
	const promptTokens = Math.max(ctx - outputReserve, Math.floor(ctx * 0.4));
	const promptChars = Math.round(promptTokens * ratio);

	return {
		ctxTokens: ctx,
		promptChars,
		compact: {
			maxToolChars: clamp(Math.round(promptChars / 30), 700, 4000),
			maxMessages: clamp(Math.round(promptChars / 1500), 12, 120),
			maxHistoryChars: Math.round(promptChars * 0.5),
		},
	};
}

/** Minimal structural view of a chat message for size estimation (no import cycle). */
interface MessageLike {
	content?: string | null;
	reasoning_content?: string;
	tool_calls?: unknown;
	name?: string;
}

/** Rough character footprint of one message as sent (content + reasoning + tool calls + envelope). */
export function estimateMessageChars(msg: MessageLike): number {
	let n = 16; // role + JSON envelope overhead
	if (typeof msg.content === "string") n += msg.content.length;
	if (msg.reasoning_content) n += msg.reasoning_content.length;
	if (msg.tool_calls) n += JSON.stringify(msg.tool_calls).length;
	if (msg.name) n += msg.name.length;
	return n;
}

/** Sum {@link estimateMessageChars} over a message list. */
export function estimateMessagesChars(messages: MessageLike[]): number {
	return messages.reduce((sum, m) => sum + estimateMessageChars(m), 0);
}
