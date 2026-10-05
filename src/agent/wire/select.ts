/**
 * Which wire format an endpoint speaks, from its host.
 *
 * Deliberately conservative: only Anthropic's own host is routed away from chat
 * completions. Everything else — every local server, every OpenAI-compatible
 * gateway, OpenAI itself — stays on the path that has always worked. A wrong
 * guess here would break local hosting, so the rule is an allowlist of one.
 *
 * OpenAI's Responses API is NOT auto-selected even on api.openai.com: chat
 * completions works there, and switching transports silently is the failure
 * mode this codebase already learned to avoid.
 */

import type { TransportId } from "../LlmClient";

export function detectTransport(baseUrl: string): TransportId {
	let host: string;
	try {
		host = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return "chat-completions";
	}
	return host === "api.anthropic.com" ? "messages" : "chat-completions";
}
