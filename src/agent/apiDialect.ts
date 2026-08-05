/**
 * API dialect — what an OpenAI-compatible endpoint actually accepts.
 *
 * Lantern was built against llama.cpp / LM Studio, whose servers IGNORE body
 * params they don't know, so the client could send llama.cpp-only reasoning
 * controls (`chat_template_kwargs`, `thinking_budget_tokens`,
 * `reasoning_control`) unconditionally. OpenAI's own API validates the body and
 * 400s on the first unknown key:
 *
 *   {"error":{"message":"Unknown parameter: 'chat_template_kwargs'.",
 *             "type":"invalid_request_error","param":"chat_template_kwargs",
 *             "code":"unknown_parameter"}}
 *
 * Two layers keep both working:
 *  1. `detectDialect` — api.openai.com / Azure OpenAI are known-strict, so the
 *     very first request is already clean (params dropped, `max_tokens` sent as
 *     `max_completion_tokens`, no `reasoning_content` echoed back).
 *  2. `parseParamRejection` — every other endpoint teaches us on a 400: the
 *     error names the param, the client drops or renames it and retries. The
 *     lesson sticks for the endpoint, so it costs one round trip, once.
 */

/** "openai" = strict validator (OpenAI proper); "compatible" = permissive (llama.cpp, LM Studio, …). */
export type ApiDialect = "compatible" | "openai";

/** Body params only llama.cpp-style servers understand. Stripped for strict endpoints. */
export const LOCAL_ONLY_PARAMS = ["chat_template_kwargs", "thinking_budget_tokens", "reasoning_control"] as const;

/**
 * Params the learning layer must never touch. Two reasons, both represented:
 *
 *  - Dropping them can't turn a 400 into a valid request — they ARE the payload
 *    (`messages`/`input`/`system`/`instructions` across the three wire formats).
 *  - Dropping them would silently change behavior in a way the user didn't ask
 *    for. `store: false` is the sharp one: "fixing" a 400 by deleting it flips
 *    OpenAI's Responses API back to its default of retaining the request — i.e.
 *    vault excerpts kept server-side for 30 days — which is precisely the
 *    promise the README makes about a local-first plugin.
 */
export const ESSENTIAL_PARAMS: ReadonlySet<string> = new Set([
	"model",
	"messages",
	"tools",
	"tool_choice",
	"stream",
	"stream_options",
	// Reserved for the other wire formats, so the guard predates their arrival.
	"input", // Responses: the conversation
	"instructions", // Responses: the system prompt
	"system", // Messages: the system prompt
	"store", // Responses: never let a 400 re-enable server-side retention
]);

/** Message fields Lantern adds that a strict server may reject; everything else is load-bearing. */
export const DROPPABLE_MESSAGE_FIELDS: ReadonlySet<string> = new Set(["reasoning_content", "name"]);

/**
 * Names a server may use in an error for a param we send under a different key
 * — OpenAI's "max_tokens is too large" fires even when the request said
 * `max_completion_tokens`. Maps their name → ours.
 */
export const PARAM_ALIASES: ReadonlyMap<string, string> = new Map([["max_tokens", "max_completion_tokens"]]);

/**
 * Context assumed for a hosted endpoint that reports no context size (OpenAI has
 * no /props and no ctx metadata in /v1/models). Every current OpenAI chat model
 * is ≥128k; older/smaller ones need the Context size setting.
 */
export const REMOTE_CONTEXT_TOKENS = 128_000;

/**
 * Context window for an OpenAI model id. The API exposes no context length
 * anywhere — `/v1/models` returns id/created/owned_by and nothing else — so this
 * is the only way to be more accurate than one blanket assumption.
 *
 * It deliberately encodes ONLY the legacy small-window models. Those ids are
 * frozen: gpt-4 and gpt-3.5-turbo will never grow a bigger context, so this
 * table cannot rot. Everything current falls through to the 128k assumption,
 * which is conservative for the models that exceed it (gpt-5 takes 400k, gpt-4.1
 * a million) and therefore safe: under-reporting makes Lantern compact sooner
 * than needed, while over-reporting would let the prompt grow until the server
 * rejects it. The Context size setting overrides either way.
 */
export function openAiContextTokens(model: string): number {
	const id = model.trim().toLowerCase();
	if (/^gpt-3\.5/.test(id)) return 16_385;
	if (/^gpt-4-32k/.test(id)) return 32_768;
	// Original gpt-4 only: `gpt-4`, `gpt-4-0613`, `gpt-4-0314`. NOT gpt-4o,
	// gpt-4.1 or gpt-4-turbo, which are all 128k.
	if (/^gpt-4(-\d{4})?$/.test(id)) return 8_192;
	return REMOTE_CONTEXT_TOKENS;
}

/**
 * Completion cap for the OpenAI dialect — the gpt-4o family rejects anything
 * larger. Reasoning models (o-series, gpt-5) allow ≥100k and need the room for
 * reasoning tokens, which count against this cap, so they aren't clamped.
 */
export const OPENAI_MAX_COMPLETION_TOKENS = 16_384;

/**
 * Which dialect an endpoint speaks, from its host. Only OpenAI's own hosts are
 * listed: other gateways vary, and the 400-driven learning path handles them
 * without a table to keep current.
 */
export function detectDialect(baseUrl: string): ApiDialect {
	let host: string;
	try {
		host = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return "compatible";
	}
	return host === "api.openai.com" || host.endsWith(".openai.com") || host.endsWith(".openai.azure.com")
		? "openai"
		: "compatible";
}

/**
 * OpenAI reasoning models (o-series, gpt-5) reject a non-default temperature
 * ("Only the default (1) is supported") and take `reasoning_effort` instead.
 */
export function isOpenAiReasoningModel(model: string): boolean {
	return /^(o[1-9]|gpt-5)/i.test(model.trim());
}

/**
 * Rewrite a request body for OpenAI's validator. Mutates `body` (never the
 * caller's messages). `effort` is Lantern's setting, needed because "off" never
 * reaches the body as a param — locally it's only `chat_template_kwargs`.
 */
export function applyOpenAiDialect(body: Record<string, unknown>, effort?: string): void {
	for (const param of LOCAL_ONLY_PARAMS) delete body[param];

	const reasoningModel = typeof body.model === "string" && isOpenAiReasoningModel(body.model);
	// `max_tokens` is rejected outright by reasoning models ("Use
	// 'max_completion_tokens' instead"); the new name works on every chat model.
	if (typeof body.max_tokens === "number") {
		body.max_completion_tokens = reasoningModel
			? body.max_tokens
			: Math.min(body.max_tokens, OPENAI_MAX_COMPLETION_TOKENS);
		delete body.max_tokens;
	}
	if (reasoningModel) delete body.temperature; // they only accept the default (1)
	// "off" reaches the wire only as chat_template_kwargs (stripped above). OpenAI
	// spells it `reasoning_effort: "none"`, worth sending on a reasoning model:
	// gpt-5.1+ REQUIRES it to allow function tools at all in /v1/chat/completions
	// ("Function tools with reasoning_effort are not supported for <model>"), and
	// the agent always sends tools. Noise on a gpt-4o, so skip it there; a model
	// that rejects "none" teaches us to drop it on the first 400.
	if (effort === "off" && reasoningModel) body.reasoning_effort = "none";
	// OpenAI neither returns nor accepts reasoning_content — echoing it back is
	// dead weight at best, a 400 at worst.
	body.messages = stripMessageFields(body.messages, new Set(["reasoning_content"]));
}

/** Return `messages` with `fields` removed, or the input untouched when nothing matches. */
export function stripMessageFields(messages: unknown, fields: ReadonlySet<string>): unknown {
	if (!Array.isArray(messages) || fields.size === 0) return messages;
	const list = messages as unknown[];
	const names = [...fields];
	const hit = (m: unknown): boolean =>
		typeof m === "object" && m !== null && names.some((f) => f in (m as Record<string, unknown>));
	if (!list.some(hit)) return messages;
	return list.map((m) => {
		if (!hit(m)) return m;
		const copy = { ...(m as Record<string, unknown>) };
		for (const f of names) delete copy[f];
		return copy;
	});
}

/** A param the server told us it won't accept, and what it wants done about it. */
export interface ParamRejection {
	/** Top-level body key (scope "body") or message field (scope "message"). */
	param: string;
	/** Where it lives: the request body, or an object inside `messages`. */
	scope: "body" | "message";
	/** Rename, from "Use 'x' instead". */
	replacement?: string;
	/**
	 * Value the server explicitly asked for, from "set reasoning_effort to
	 * 'none'". Unlike a drop, this can ADD a param we never sent — the server is
	 * prescribing a setting, not rejecting one we chose.
	 */
	value?: string | number | boolean;
}

/**
 * Message phrasings that blame a param, for servers that fill in neither
 * `error.param` nor a known `error.code` (vLLM, gateways). When `error.param`
 * IS set we trust it instead — chasing OpenAI's prose is a losing game (it
 * writes "not supported for gpt-5.6-luna", "not supported with this model",
 * "does not support", …, and every phrasing we don't predict is a dead chat).
 */
const REJECTION_MESSAGE =
	/unknown parameter|unsupported parameter|unrecognized request argument|unsupported value|extra inputs are not permitted|not supported|does not support|is too large|is deprecated|set \w+ to/i;

/**
 * Pull the param name out of the message when the server didn't put it in
 * `error.param`. The last three patterns are Anthropic's, which carries no
 * `param` field at all and instead names the key in the message itself —
 * verified against live 400s:
 *   `temperature` is deprecated for this model.
 *   "thinking.type.disabled" is not supported for this model. …
 *   chat_template_kwargs: Extra inputs are not permitted
 */
function paramFromMessage(message: string): string {
	const set = /set (?:the )?[`'"]?([A-Za-z_][\w]*)[`'"]? to/i.exec(message);
	if (set) return set[1];
	const named = /(?:parameter|argument(?: supplied)?|value)[:\s]+'?([A-Za-z_][\w]*)'?/i.exec(message);
	if (named) return named[1];
	const quotedLead = /^[`'"]([A-Za-z_][\w.]*)[`'"]\s+(?:is|are)\s+(?:deprecated|not supported|unsupported)/i.exec(
		message.trim()
	);
	if (quotedLead) return quotedLead[1];
	const bareLead = /^([A-Za-z_][\w.]*):\s+extra inputs are not permitted/i.exec(message.trim());
	return bareLead ? bareLead[1] : "";
}

/** Identifiers in an error path like `messages[3].reasoning_content` → ["messages", "reasoning_content"]. */
function identifiers(path: string): string[] {
	return path.match(/[A-Za-z_][\w]*/g) ?? [];
}

/** JSON-ish literal from an error message: 'none' → "none", '1' → 1, 'false' → false. */
function literal(raw: string): string | number | boolean {
	if (raw === "true") return true;
	if (raw === "false") return false;
	const n = Number(raw);
	return raw !== "" && Number.isFinite(n) ? n : raw;
}

/**
 * Read a 400 as "this param is the problem, here's the fix". Structural first:
 * a 400 that names `error.param` IS about that param, whatever the prose says.
 * Returns null only when nothing identifies a param (auth failures, gateway
 * HTML, plain-text errors) — those must surface rather than trigger a retry.
 * Deciding which params are actually fixable is the caller's job (see
 * ESSENTIAL_PARAMS / DROPPABLE_MESSAGE_FIELDS).
 */
export function parseParamRejection(responseBody: string): ParamRejection | null {
	let error: Record<string, unknown>;
	try {
		const json = JSON.parse(responseBody) as Record<string, unknown>;
		if (!json || typeof json !== "object") return null;
		// Some gateways nest under `error`, some return the fields flat.
		error = (typeof json.error === "object" && json.error !== null ? json.error : json) as Record<string, unknown>;
	} catch {
		return null;
	}

	const message = typeof error.message === "string" ? error.message : "";
	const named = typeof error.param === "string" ? error.param : "";
	const path = named || (REJECTION_MESSAGE.test(message) ? paramFromMessage(message) : "");
	const parts = identifiers(path);
	if (parts.length === 0) return null;

	const scope = parts[0] === "messages" ? "message" : "body";
	// A body param is fixed at its top level (`chat_template_kwargs`, not
	// `.enable_thinking`); a message field is the leaf of `messages[i].field`.
	const param = scope === "message" ? parts[parts.length - 1] : parts[0];
	if (scope === "message" && parts.length < 2) return null;

	// "…or set reasoning_effort to 'none'." — an instruction, not a complaint.
	//
	// The value must be a LITERAL: quoted, numeric, or a boolean. English prose
	// ("set max_tokens to a value less than…", "…to at most 4096") would
	// otherwise yield garbage like "a", and a coerced value sticks to the
	// endpoint for the session — a far worse outcome than not learning at all.
	const set =
		/set (?:the )?[`'"]?([A-Za-z_][\w]*)[`'"]? to (?:[`'"]([\w.+-]+)[`'"]|(-?\d+(?:\.\d+)?)\b|(true|false)\b)/i.exec(
			message
		);
	if (set && set[1] === param) {
		const raw = set[2] ?? set[3] ?? set[4];
		if (raw !== undefined) return { param, scope, value: literal(raw) };
	}

	const suggested = /use [`'"]([A-Za-z_][\w]*)[`'"] instead/i.exec(message);
	return {
		param,
		scope,
		...(suggested && suggested[1] !== param ? { replacement: suggested[1] } : {}),
	};
}

/** What an endpoint has taught us about its dialect (accumulated across 400s). */
export interface LearnedFixes {
	/** Body params to remove. */
	dropped: ReadonlySet<string>;
	/** Body params to rename (old → new). */
	renamed: ReadonlyMap<string, string>;
	/** Body params the server prescribed a value for (set even if we'd omit them). */
	coerced: ReadonlyMap<string, string | number | boolean>;
	/** Fields to remove from every message. */
	messageFields: ReadonlySet<string>;
}

/**
 * Apply learned fixes to a request body, in the order they compose: rename
 * first (so a renamed-then-rejected key drops by its new name), then drop, then
 * set the prescribed values (which outrank a drop — the server asked for them).
 */
export function applyLearnedFixes(body: Record<string, unknown>, fixes: LearnedFixes): void {
	for (const [from, to] of fixes.renamed) {
		if (from in body) {
			body[to] = body[from];
			delete body[from];
		}
	}
	for (const param of fixes.dropped) delete body[param];
	for (const [param, value] of fixes.coerced) body[param] = value;
	if (fixes.messageFields.size > 0) body.messages = stripMessageFields(body.messages, fixes.messageFields);
}
