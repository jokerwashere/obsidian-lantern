/**
 * Wire-format seam.
 *
 * `LlmClient` owns everything that does NOT vary between providers — the Node
 * `http` streaming core, abort, connect/idle watchdogs, `agent:false`, the
 * `requestUrl` fallback, model/context memoization, chars-per-token calibration.
 * A WireFormat owns everything that does: URL, auth headers, request body,
 * response parsing, stream accumulation, model listing, error shape.
 *
 * The canonical conversation stays `ChatMessage[]` (chat-completions-shaped) and
 * is translated at the HTTP boundary. That holds even for Anthropic, where tool
 * results live in a *user* message rather than a role of their own — no shared
 * message schema survives that, so ours stays ours and each format maps it.
 *
 * This interface is shaped by two real formats (chat completions + Anthropic
 * Messages) rather than invented up front; OpenAI's Responses API is the third
 * and fits the same slots.
 */

import type {
	ChatMessage,
	ChatResult,
	ChatUsage,
	ModelLoadState,
	OpaqueReasoning,
	ReasoningEffort,
	ToolDef,
	TransportId,
} from "../LlmClient";
import type { StreamDelta } from "../stream";

export type { ChatUsage, OpaqueReasoning };

/** One chat call, in Lantern's terms. A WireFormat turns this into a provider body. */
export interface WireRequest {
	model: string;
	/** Canonical history, system message included (formats that want it separate lift it out). */
	messages: ChatMessage[];
	tools?: ToolDef[];
	/** Lantern's reasoning setting; each format spells it differently. */
	effort?: ReasoningEffort;
	/** Hard ceiling on generated tokens. Optional for OpenAI, REQUIRED by Anthropic. */
	maxTokens: number;
	temperature?: number;
}

/**
 * Feeds raw SSE `data:` payloads in, gives deltas out, assembles the result.
 * `ChatStreamAccumulator` already has this shape; Anthropic's block-indexed
 * events implement the same two methods.
 */
export interface StreamAccumulator {
	/** Consume one decoded payload. Returns what it contributed (may be empty). */
	push(payload: unknown): StreamDelta;
	/** The finished turn, once the stream ends. */
	result(): ChatResult;
}

/** What a provider's model list tells us. `state` is "unknown" where none is reported. */
export interface ModelCatalog {
	served: Array<{ id: string; state: ModelLoadState }>;
	/** Ids the server says are loaded RIGHT NOW (llama-server router); empty elsewhere. */
	resident: string[];
}

/**
 * An error the server sent INSIDE a 200 stream — Anthropic does this for
 * `overloaded_error` where a non-streaming call would have returned HTTP 529.
 * The streaming loop must rethrow this rather than swallow it as a malformed
 * line, so it's a distinct class.
 */
export class WireStreamError extends Error {
	constructor(public kind: string, message: string) {
		super(message);
		this.name = "WireStreamError";
	}
}

export interface WireFormat {
	readonly id: TransportId;
	/** POST target for a chat call, from the configured base URL. */
	endpoint(baseUrl: string): string;
	/** GET target for the model list. */
	modelsEndpoint(baseUrl: string): string;
	/** Auth and protocol headers (Bearer vs x-api-key + anthropic-version). */
	headers(apiKey?: string): Record<string, string>;
	/** Canonical request → provider body (without `stream`, which the caller sets). */
	buildBody(req: WireRequest): Record<string, unknown>;
	/**
	 * Extra body fields that apply only to a STREAMING request. OpenAI needs
	 * `stream_options: {include_usage: true}` to report usage at all; Anthropic
	 * rejects it as an unknown field, which used to look like "this server can't
	 * stream" and silently downgraded the whole session to non-streaming.
	 */
	readonly streamParams?: Record<string, unknown>;
	/** Non-streaming provider response → canonical result. */
	parseResult(json: unknown): ChatResult;
	/** A fresh accumulator for one streamed call. */
	accumulator(): StreamAccumulator;
	/** Provider model list → catalog. */
	parseModels(json: unknown): ModelCatalog;
	/**
	 * Whether this format's errors identify the offending body param, which is
	 * what the drop/rename/set learning layer reads. OpenAI puts it in
	 * `error.param`; Anthropic has no such field but names the key in the message
	 * prose (verified live: "`temperature` is deprecated for this model."), which
	 * is equally actionable. False only for a format whose errors say nothing
	 * identifiable — guessing which key to delete is worse than surfacing.
	 */
	readonly namesRejectedParams: boolean;
	/**
	 * Params this format REQUIRES, which the learning layer must never drop even
	 * when a 400 names them (Anthropic's `max_tokens` has no valid absence — a
	 * "fix" that removes it just produces a different, more confusing 400).
	 */
	readonly requiredParams?: ReadonlySet<string>;
	/** Context assumed when the endpoint reports none. */
	fallbackContextTokens(): number;
}
