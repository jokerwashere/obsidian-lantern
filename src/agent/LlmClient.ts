/**
 * LlmClient — minimal OpenAI-compatible chat client.
 *
 * Targets a locally-run server (llama.cpp `llama-server`, LM Studio, …) or a
 * hosted OpenAI-compatible API over the standard `/chat/completions` endpoint.
 * Requests STREAM by default via Node's http module (the plugin is desktop-only;
 * Obsidian's `requestUrl` cannot stream or abort — verified against its
 * typings): the UI gets live deltas, a Stop button works (AbortSignal), and
 * connect/idle timeouts stop a hung server from wedging the chat forever.
 *
 * Fallback: if the server answers a streaming request with an HTTP error but
 * then accepts the same request without `stream` (some older llama-server
 * builds rejected stream+tools), non-streaming mode sticks until the config
 * changes. Network-level failures are surfaced, not retried.
 *
 * Dialect: local servers ignore body params they don't know, strict ones (OpenAI)
 * 400 on them. `apiDialect.ts` handles both — see there.
 *
 * Note: llama-server needs `--jinja` for tool/function calling to work.
 */

import { requestUrl } from "obsidian";
import * as http from "http";
import * as https from "https";
import { SseDecoder, ChatStreamAccumulator, type StreamDelta } from "./stream";
import { FALLBACK_CONTEXT_TOKENS, CHARS_PER_TOKEN } from "./contextBudget";
import {
	type ApiDialect,
	applyLearnedFixes,
	applyOpenAiDialect,
	detectDialect,
	parseParamRejection,
	DROPPABLE_MESSAGE_FIELDS,
	ESSENTIAL_PARAMS,
	openAiContextTokens,
	stripMessageFields,
	PARAM_ALIASES,
} from "./apiDialect";
import { MESSAGES_WIRE } from "./wire/messages";
import { detectTransport } from "./wire/select";
import { WireStreamError, type ModelCatalog, type WireFormat, type WireRequest } from "./wire/types";
import { truncate } from "../util";

export type ChatRole = "system" | "user" | "assistant" | "tool";

/**
 * Wire formats Lantern can speak. The canonical in-memory conversation is
 * chat-completions-SHAPED but transport-neutral; each id names a translation at
 * the HTTP boundary, not a different conversation model.
 *
 * Only "chat-completions" is implemented today. The other two are declared
 * because they change what the canonical model must be able to CARRY, and that
 * is the expensive thing to retrofit:
 *  - "responses"  (OpenAI /v1/responses): reasoning returns as an opaque
 *    encrypted item that must be replayed to keep reasoning across tool calls.
 *  - "messages"   (Anthropic /v1/messages): reasoning returns as a `thinking`
 *    block carrying a `signature` that must come back byte-identical.
 */
export type TransportId = "chat-completions" | "responses" | "messages";

/**
 * Provider-opaque reasoning state for ONE assistant turn, replayed verbatim on
 * later requests within the same run. Tagged with the transport that produced
 * it: an encrypted OpenAI reasoning item is meaningless to Anthropic (and vice
 * versa), so a transport must ignore blocks that aren't its own rather than
 * forward something the server will reject.
 */
export interface OpaqueReasoning {
	transport: TransportId;
	/** The provider's item/block, untouched. Never parsed, never edited. */
	data: unknown;
}

export interface ToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface ChatMessage {
	role: ChatRole;
	/** Assistant messages that only carry tool_calls may have null content. */
	content: string | null;
	/** Present on assistant turns that call tools. */
	tool_calls?: ToolCall[];
	/** Present on `tool` messages — the id of the call being answered. */
	tool_call_id?: string;
	/** Tool name (helps some servers / debugging). */
	name?: string;
	/**
	 * The turn's extracted reasoning as TEXT, passed BACK to the server on
	 * subsequent calls within a run — llama.cpp's own webui does this by default
	 * (chat.service.ts), and Qwen-style interleaved-thinking templates need
	 * prior-turn reasoning to render the think-block state consistently.
	 */
	reasoning_content?: string;
	/**
	 * The same turn's reasoning in the provider's own opaque form, when it has
	 * one. Text round-trips on chat completions; OpenAI's Responses API and
	 * Anthropic's Messages API instead hand back a blob (encrypted item /
	 * signed thinking block) that must be replayed unmodified or reasoning
	 * breaks across tool calls. Run-scoped only — `compactHistory` drops these,
	 * so they never reach `threads.json`.
	 */
	reasoning_blocks?: OpaqueReasoning[];
}

/** OpenAI-style function/tool definition. */
export interface ToolDef {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface ChatUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** Best estimate of context occupancy (llama.cpp `timings`, else total). */
	contextTokens: number;
	/**
	 * Generation speed (tokens/sec). Reported directly by llama.cpp
	 * (`timings.predicted_per_second`); hosted APIs report nothing, so the client
	 * measures it across the stream instead — see `tokensPerSecondEstimated`.
	 */
	tokensPerSecond?: number;
	/**
	 * True when `tokensPerSecond` was measured client-side (first visible token →
	 * last, so connection setup and prompt processing are excluded) rather than
	 * reported by the server. Shown as "~N tok/s" so a measurement is never
	 * mistaken for the server's own number.
	 */
	tokensPerSecondEstimated?: boolean;
	/** Prompt tokens served from the KV cache (`usage.prompt_tokens_details.cached_tokens`, else `timings.cache_n`); absent if unreported. */
	cachedTokens?: number;
	/**
	 * Output tokens spent on reasoning rather than the visible answer. OpenAI
	 * reports `completion_tokens_details.reasoning_tokens`, Anthropic
	 * `output_tokens_details.thinking_tokens`; llama.cpp reports neither (its
	 * reasoning is inline in the completion). Absent when unreported.
	 */
	reasoningTokens?: number;
}

export interface ChatResult {
	content: string | null;
	toolCalls: ToolCall[];
	/** Extracted reasoning (servers that separate it, e.g. llama-server). */
	reasoning?: string | null;
	/**
	 * The same reasoning in the provider's opaque, replay-required form, when it
	 * has one (Anthropic signed `thinking` blocks, OpenAI encrypted reasoning
	 * items). Goes onto the assistant turn as `reasoning_blocks`.
	 */
	reasoningBlocks?: OpaqueReasoning[];
	/** Token usage when the server reports it (OpenAI `usage` / llama.cpp `timings`). */
	usage?: ChatUsage;
	/** Why generation stopped: "stop" | "length" | "tool_calls" | … (server-dependent). */
	finishReason?: string | null;
}

/** Live-stream hooks for one chat call. */
export interface ChatCallbacks {
	/** Called per streamed fragment (content and/or reasoning). */
	onDelta?: (delta: StreamDelta) => void;
	/** Abort the request (Stop button). */
	signal?: AbortSignal;
	/**
	 * Fired once, while the model is still reasoning, when the server supports
	 * ending that reasoning early (llama-server `reasoning_control`). `end()`
	 * POSTs the control request and resolves true if the server accepted it.
	 * The same stream then continues into the answer.
	 */
	onReasoningControl?: (control: { end: () => Promise<boolean> }) => void;
	/**
	 * Per-call reasoning override. Used to retry with thinking disabled when
	 * a model answers INSIDE its (template-pre-opened) think block and never
	 * closes it — the server then returns empty content with the real answer
	 * filed under reasoning.
	 */
	reasoningEffort?: ReasoningEffort;
}

/** Reasoning/thinking strength for models that support it. */
export type ReasoningEffort = "off" | "low" | "medium" | "high";

/** One change a 400 asked for. Planned first, applied only if we act on it. */
type ParamFix =
	| { kind: "drop"; param: string }
	| { kind: "rename"; param: string; replacement: string }
	| { kind: "coerce"; param: string; value: string | number | boolean }
	| { kind: "dropMessageField"; param: string };

/**
 * Per-effort thinking-token budgets — all FINITE. NEVER -1: llama-server maps
 * -1 to INT_MAX (unlimited thinking), which can run forever / exhaust the KV
 * cache (the observed budget=2147483647). A finite budget force-closes the
 * think block at the cap. buildBody's max_tokens is a second, total-generation
 * backstop.
 */
const THINKING_BUDGET: Record<Exclude<ReasoningEffort, "off">, number> = {
	low: 2048,
	medium: 8192,
	high: 16384,
};

/**
 * Hard cap on generated tokens (reasoning + answer), sized to the context.
 * ~60% of context, kept above the high thinking budget (16384) so a deep
 * think still leaves room for the answer; clamped to a sane range.
 */
export function maxTokensForContext(ctxTokens: number): number {
	const ctx = Number.isFinite(ctxTokens) && ctxTokens > 0 ? ctxTokens : FALLBACK_CONTEXT_TOKENS;
	return Math.min(24576, Math.max(2048, Math.round(ctx * 0.6)));
}

/**
 * How many times one chat call may be rebuilt after the server rejected a body
 * param. Each pass drops/renames exactly one param, so this bounds the learning
 * to a handful of round trips (OpenAI reports one bad param per response).
 */
const MAX_PARAM_RETRIES = 4;

/** TCP connect watchdog — localhost connects are instant; a hang means a dead host. */
const CONNECT_TIMEOUT_MS = 10_000;
/** No bytes (not even reasoning deltas) for this long = treat the server as hung. */
const IDLE_TIMEOUT_MS = 300_000;

export interface LlmClientConfig {
	/** Base URL including the OpenAI path, e.g. http://localhost:8080/v1 or https://api.openai.com/v1 */
	baseUrl: string;
	/** API key (local servers usually ignore it; hosted APIs require it). */
	apiKey?: string;
	/** Model name; llama-server ignores it, LM Studio and hosted APIs use it. */
	model?: string;
	temperature?: number;
	/** Reasoning strength (default: off = no thinking). */
	reasoningEffort?: ReasoningEffort;
	/**
	 * Force a wire format instead of deriving it from the host. "auto" (default)
	 * routes api.anthropic.com to Messages and everything else — every local
	 * server included — to chat completions. Set it for a gateway that speaks a
	 * format its hostname doesn't advertise.
	 */
	transport?: TransportId | "auto";
	/** Test hooks; production uses the module defaults. */
	connectTimeoutMs?: number;
	idleTimeoutMs?: number;
}

/** Normalize a base URL: strip trailing slash; tolerate it being given with or without /v1. */
export function chatCompletionsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/** OpenAI-compatible model-list endpoint (used for a cheap reachability probe). */
export function modelsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/models`;
}

/** llama-server realtime reasoning control: POST /v1/chat/completions/control. */
export function reasoningControlUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/chat/completions/control`;
}

/** llama.cpp /props lives at the server ROOT, not under /v1. */
export function propsUrl(baseUrl: string): string {
	const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
	return `${root}/props`;
}

/** A /v1/models entry as llama-server's router reports it (extra fields ignored). */
export interface ModelEntry {
	id?: string;
	status?: { args?: string[]; preset?: string; value?: string; progress?: number };
}

/**
 * Load state of a served model (llama-server router `status.value`). "unknown"
 * = the server doesn't report one (single-model llama-server, LM Studio) — there
 * the model is resident whenever the server is up, so treat unknown as ready.
 */
export type ModelLoadState = "loaded" | "loading" | "sleeping" | "unloaded" | "downloading" | "unknown";

export function normalizeLoadState(value: string | undefined): ModelLoadState {
	switch ((value ?? "").toLowerCase()) {
		case "loaded":
			return "loaded";
		case "loading":
			return "loading";
		case "sleeping":
			return "sleeping";
		case "unloaded":
			return "unloaded";
		case "downloading":
			return "downloading";
		default:
			return "unknown";
	}
}

/** A cold state means the next chat call will block while the model loads/wakes. */
export function isColdState(s: ModelLoadState): boolean {
	return s === "loading" || s === "sleeping" || s === "unloaded" || s === "downloading";
}

/** Read `--ctx-size`/`-c` and `--parallel`/`-np` (token counts) from a llama-server arg list. */
export function parseCtxFromArgs(args: string[]): { ctx?: number; parallel?: number } {
	const valueAfter = (flags: string[]): number | undefined => {
		for (let i = 0; i < args.length - 1; i++) {
			if (flags.includes(args[i])) {
				const v = parseInt(args[i + 1], 10);
				if (Number.isFinite(v) && v > 0) return v;
			}
		}
		return undefined;
	};
	return { ctx: valueAfter(["--ctx-size", "-c"]), parallel: valueAfter(["--parallel", "-np"]) };
}

/** Read `ctx-size = N` from a llama-server router preset block. */
export function parseCtxFromPreset(preset: string): number | undefined {
	const m = /(?:^|\n)\s*ctx-size\s*=\s*(\d+)/.exec(preset);
	return m ? parseInt(m[1], 10) : undefined;
}

/** Per-slot context (tokens) from one router model entry, or null if absent. */
export function ctxFromModelEntry(entry: ModelEntry): number | null {
	const fromArgs = parseCtxFromArgs(entry?.status?.args ?? []);
	const ctx = fromArgs.ctx ?? (entry?.status?.preset ? parseCtxFromPreset(entry.status.preset) : undefined);
	if (!ctx) return null;
	const parallel = fromArgs.parallel && fromArgs.parallel > 0 ? fromArgs.parallel : 1;
	return Math.floor(ctx / parallel);
}

/** Per-slot context from a router /v1/models data[]: prefer the target model, else any. */
export function contextFromModels(data: ModelEntry[], preferId?: string): number | null {
	if (preferId) {
		const match = data.find((m) => m.id === preferId);
		const c = match ? ctxFromModelEntry(match) : null;
		if (c) return c;
	}
	for (const entry of data) {
		const c = ctxFromModelEntry(entry);
		if (c) return c;
	}
	return null;
}

/** Error carrying a non-200 HTTP status (server reachable, request rejected). */
export class HttpStatusError extends Error {
	constructor(public status: number, public body: string) {
		super(`LLM request failed (HTTP ${status}): ${truncate(body, 300)}`);
		this.name = "HttpStatusError";
	}
}

/**
 * A rejection about WHO is asking, not about how the request was shaped: a bad
 * or revoked key (401), or one without access to the model/region (403). No
 * retry — plain, restructured, or otherwise — can change the answer.
 */
export function isAuthFailure(status: number): boolean {
	return status === 401 || status === 403;
}

/**
 * Sample-quality floors for a client-measured rate.
 *
 * Deliberately NOT based on chunk count: providers batch very differently —
 * OpenAI sent 118 content deltas for 121 tokens (~1 token each), while Anthropic
 * delivers a whole thinking paragraph in one `thinking_delta`. A chunk-count
 * floor rejects the second provider for streaming efficiently, which is absurd.
 *
 * What actually protects the number: enough TOKENS to rate, and a window long
 * enough to divide by. A server that buffers the whole answer and flushes it at
 * once collapses the window and is rejected by the time floor; two chunks spread
 * across real generation time are a fine sample however few they are.
 */
const MIN_SPEED_SAMPLE_MS = 100;
const MIN_SPEED_SAMPLE_TOKENS = 20;

/** What the stream loop observed while tokens were arriving. */
export interface SpeedSample {
	firstAt: number | null;
	lastAt: number | null;
	/** Number of deltas that carried visible content or reasoning. */
	chunks: number;
	/**
	 * Whether any reasoning was actually STREAMED. Anthropic streams thinking, so
	 * its thinking tokens fall inside the window; OpenAI generates reasoning
	 * before the first visible token and never streams it, so those tokens are
	 * billed but happened outside the window and must not be divided by it.
	 */
	sawReasoning: boolean;
}

/**
 * Attach a client-measured generation speed when the server didn't report one.
 *
 * llama.cpp gives `timings.predicted_per_second` directly; OpenAI and Anthropic
 * report nothing, so the only honest number available is the one we time
 * ourselves. Measured from the FIRST visible token to the last, which excludes
 * connection setup, queueing and prompt processing — it answers "how fast did
 * the text arrive", not "how fast did the request complete". Flagged as
 * estimated so the UI can mark it rather than pass it off as the server's own
 * figure, and omitted entirely when the sample is too thin to mean anything.
 */
export function withMeasuredSpeed(result: ChatResult, sample: SpeedSample): ChatResult {
	const usage = result.usage;
	if (!usage || usage.tokensPerSecond || !sample.firstAt || !sample.lastAt) return result;
	const elapsedMs = sample.lastAt - sample.firstAt;
	// Only tokens generated INSIDE the window belong over it. Reasoning that was
	// never streamed (OpenAI thinks before emitting anything visible) is billed
	// in completionTokens but happened before the window opened — dividing it by
	// the window inflates the rate, sometimes several-fold on a short answer.
	const outside = sample.sawReasoning ? 0 : usage.reasoningTokens ?? 0;
	const measured = usage.completionTokens - outside;
	if (elapsedMs < MIN_SPEED_SAMPLE_MS || measured < MIN_SPEED_SAMPLE_TOKENS || sample.chunks < 2) {
		return result;
	}
	return {
		...result,
		usage: {
			...usage,
			tokensPerSecond: measured / (elapsedMs / 1000),
			tokensPerSecondEstimated: true,
		},
	};
}

export function abortError(): Error {
	const err = new Error("The operation was aborted");
	err.name = "AbortError";
	return err;
}

export function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

export class LlmClient {
	private config: LlmClientConfig;
	/** Set once streaming is proven broken while plain requests work. */
	private streamDisabled = false;
	/** Auto-resolved model id when none is configured (null = not yet tried). */
	private resolvedModel: string | null = null;
	/** Detected per-slot context size (tokens); null = unknown/undetectable. */
	private contextTokens: number | null = null;
	/** Whether detection has run (so a null result isn't re-probed every call). */
	private contextTried = false;
	/** Chars-per-token learned from server usage (null = use the default). */
	private learnedCharsPerToken: number | null = null;
	/** Context tokens last resolved (incl. settings override); sizes max_tokens. */
	private budgetContextTokens: number | null = null;
	/** Body-param validation style of the endpoint (from its host). */
	private apiDialect: ApiDialect;
	/**
	 * Wire format in use. Only "chat-completions" is implemented — every local
	 * server speaks it and nothing else (llama.cpp has no /v1/responses), so it
	 * stays the default and the only path a local endpoint can ever take.
	 * Declared as state so transport-specific behavior is gated by it from day
	 * one rather than assumed globally.
	 */
	private transport: TransportId = "chat-completions";
	/** The format that owns URL/headers/body/parsing/streaming for this endpoint. */
	private wire: WireFormat = CHAT_COMPLETIONS_WIRE;
	/** Body params this endpoint 400'd on → omitted from later requests. */
	private droppedParams = new Set<string>();
	/** Message fields this endpoint 400'd on (e.g. reasoning_content). */
	private droppedMessageFields = new Set<string>();
	/** Renames the endpoint asked for ("Use 'max_completion_tokens' instead"). */
	private renamedParams = new Map<string, string>();
	/** Values the endpoint prescribed ("set reasoning_effort to 'none'"). */
	private coercedParams = new Map<string, string | number | boolean>();

	constructor(config: LlmClientConfig) {
		this.config = config;
		this.apiDialect = detectDialect(config.baseUrl);
		this.selectWire();
	}

	/** Pick the wire format: the explicit setting if given, else host-based detection. */
	private selectWire(): void {
		const forced = this.config.transport;
		this.transport = forced && forced !== "auto" ? forced : detectTransport(this.config.baseUrl);
		this.wire = wireFor(this.transport);
	}

	updateConfig(config: Partial<LlmClientConfig>): void {
		this.config = { ...this.config, ...config };
		this.streamDisabled = false; // a different server may support streaming
		this.resolvedModel = null;
		this.contextTokens = null;
		this.contextTried = false;
		this.learnedCharsPerToken = null;
		this.budgetContextTokens = null;
		this.apiDialect = detectDialect(this.config.baseUrl);
		this.selectWire();
		// Everything learned applies to the OLD endpoint/model.
		this.droppedParams.clear();
		this.droppedMessageFields.clear();
		this.renamedParams.clear();
		this.coercedParams.clear();
	}

	/**
	 * Context assumed when the endpoint reports none. Hosted OpenAI models are
	 * ≥128k; a local server that doesn't answer /props is usually small.
	 */
	private fallbackContextTokens(): number {
		// The format's own default (200k for Claude, 8k for a local server that
		// doesn't answer /props). On OpenAI the model id is the only available
		// signal, and it still beats one blanket number for the legacy 8k/16k ids.
		return this.apiDialect === "openai"
			? openAiContextTokens(this.config.model ?? "")
			: this.wire.fallbackContextTokens();
	}

	/**
	 * Model id to send. llama-server in single-model mode ignores it, but in
	 * ROUTER mode (multiple GGUFs served) an unknown id is 400-rejected and a
	 * blind pick can silently trigger a multi-minute model load (both
	 * verified live). Resolution when no model is configured:
	 *  - the resident model when the server reports one (zero swap cost);
	 *  - a single served id → use it (single-model server / LM Studio);
	 *  - multiple ids, no resident → FAIL FAST with a pick-one-in-settings
	 *    error rather than wedging the chat on a cold model load;
	 *  - /models unreachable or empty → legacy placeholder.
	 * Memoized until settings change.
	 */
	private async modelForRequest(): Promise<string> {
		if (this.config.model) return this.config.model;
		if (this.resolvedModel === null) {
			try {
				const { served, resident } = await this.fetchModelInfo();
				if (resident[0]) {
					this.resolvedModel = resident[0];
				} else if (served.length === 1) {
					this.resolvedModel = served[0];
				} else if (served.length > 1) {
					const sample = served.slice(0, 4).join(", ");
					throw new Error(
						`The LLM server serves ${served.length} models (${sample}…) — ` +
						"pick one in Lantern settings (Model → list button)."
					);
				} else {
					this.resolvedModel = "";
				}
			} catch (error) {
				if (error instanceof Error && /pick one in Lantern settings/.test(error.message)) {
					throw error; // configuration guidance, not a fallback case
				}
				this.resolvedModel = "";
			}
		}
		return this.resolvedModel || "local-model";
	}

	/**
	 * Lightweight reachability probe: GET /models. Confirms the server is up
	 * without loading or running the model (unlike `chat`). Returns the served
	 * model ids; throws on a non-200 or unreachable server.
	 */
	async listModels(): Promise<string[]> {
		return (await this.fetchModelInfo()).served;
	}

	/**
	 * llama-server's /v1/models carries TWO lists (verified live): the OpenAI
	 * `data[]` with every SERVED id, and an ollama-style `models[]` naming the
	 * RESIDENT (loaded) model(s) — empty when nothing is loaded.
	 */
	private async fetchModelInfo(): Promise<{ served: string[]; resident: string[] }> {
		const catalog = await this.fetchCatalog();
		return { served: catalog.served.map((m) => m.id), resident: catalog.resident };
	}

	/** The endpoint's model list, read through the active format. Throws on a non-200. */
	private async fetchCatalog(): Promise<ModelCatalog> {
		const res = await requestUrl({
			url: this.wire.modelsEndpoint(this.config.baseUrl),
			method: "GET",
			headers: this.wire.headers(this.config.apiKey),
			throw: false,
		});
		if (res.status !== 200) {
			throw new Error(`HTTP ${res.status}`);
		}
		return this.wire.parseModels(res.json);
	}

	/**
	 * Per-model load state. Empty when unreachable; each `state` is "unknown" on
	 * providers that don't report one (Anthropic, LM Studio, single-model
	 * llama-server). Used by the settings model picker.
	 */
	async listModelStatuses(): Promise<Array<{ id: string; state: ModelLoadState }>> {
		return (await this.fetchCatalog()).served;
	}

	/**
	 * Load state of the model the next chat request would hit ("unknown" when the
	 * server doesn't report one). Best-effort: any error → "unknown". Lets the
	 * agent loop warn when the first response will block on a cold model load.
	 */
	async modelLoadState(): Promise<ModelLoadState> {
		try {
			const id = await this.modelForRequest();
			const served = (await this.fetchCatalog()).served;
			const entry = served.find((m) => m.id === id) ?? (served.length === 1 ? served[0] : undefined);
			return entry?.state ?? "unknown";
		} catch {
			return "unknown";
		}
	}

	/**
	 * Detected per-slot context size (tokens), or null when the server doesn't
	 * report one (e.g. LM Studio). Memoized. Sources, in order:
	 *  1. GET /props → default_generation_settings.n_ctx (a single loaded model).
	 *  2. Router mode (/props reports n_ctx 0): parse --ctx-size/-c (÷ --parallel)
	 *     from the target model's status.args/preset in /v1/models — works even
	 *     while the model is unloaded (verified live).
	 */
	async getContextSize(): Promise<number | null> {
		if (this.contextTried) return this.contextTokens;
		this.contextTried = true;
		this.contextTokens = await this.detectContextSize();
		return this.contextTokens;
	}

	/** Context tokens to budget against: the override if > 0, else detected, else fallback. */
	async resolveContextTokens(override?: number): Promise<number> {
		const tokens = override && override > 0 ? override : (await this.getContextSize()) ?? this.fallbackContextTokens();
		this.budgetContextTokens = tokens; // so buildBody can size max_tokens to the same context
		return tokens;
	}

	/** Chars-per-token to budget with: learned from usage if available, else the default. */
	charsPerToken(): number {
		return this.learnedCharsPerToken ?? CHARS_PER_TOKEN;
	}

	/** Update the learned chars-per-token (clamped EMA) from an observed sample. */
	recordCharsPerToken(observed: number): void {
		if (!Number.isFinite(observed) || observed <= 0) return;
		const clamped = Math.min(8, Math.max(2, observed));
		this.learnedCharsPerToken =
			this.learnedCharsPerToken === null ? clamped : this.learnedCharsPerToken * 0.7 + clamped * 0.3;
	}

	private async detectContextSize(): Promise<number | null> {
		// Both probes are llama.cpp-shaped. OpenAI has no /props and no ctx
		// metadata in /v1/models; Anthropic has neither and a fixed 200k window.
		// Don't waste round trips — the fallback (or the setting) covers them.
		if (this.apiDialect === "openai" || this.transport !== "chat-completions") return null;

		const headers: Record<string, string> = this.wire.headers(this.config.apiKey);

		// 1) /props: a loaded single model reports its per-slot n_ctx directly.
		try {
			const res = await requestUrl({ url: propsUrl(this.config.baseUrl), method: "GET", headers, throw: false });
			if (res.status === 200) {
				const n = (res.json as { default_generation_settings?: { n_ctx?: number } })
					?.default_generation_settings?.n_ctx;
				if (typeof n === "number" && n > 0) return n;
			}
		} catch {
			/* fall through to the router path */
		}

		// 2) Router mode: read the configured ctx-size from /v1/models metadata.
		try {
			const res = await requestUrl({ url: modelsUrl(this.config.baseUrl), method: "GET", headers, throw: false });
			if (res.status === 200) {
				const data = (res.json as { data?: ModelEntry[] })?.data ?? [];
				return contextFromModels(data, this.config.model);
			}
		} catch {
			/* undetectable */
		}
		return null;
	}

	/**
	 * One chat turn. Pass `tools` to allow tool calls; pass callbacks for live
	 * deltas and aborting. Calls that want deltas or abortability stream via
	 * Node http (unless the server proved it can't); plain calls (e.g. the
	 * settings-tab connectivity test) use a simple requestUrl POST.
	 */
	async chat(
		messages: ChatMessage[],
		tools?: ToolDef[],
		callbacks?: ChatCallbacks
	): Promise<ChatResult> {
		const model = await this.modelForRequest();
		const wantsStream = Boolean(callbacks?.onDelta || callbacks?.signal);

		// A strict endpoint (OpenAI) 400s one unknown param at a time. Each pass
		// rebuilds the body with what the last rejection taught us; the lesson is
		// remembered, so this costs a round trip once per endpoint, not per call.
		for (let attempt = 0; ; attempt++) {
			const body = this.buildBody(messages, tools, model, callbacks?.reasoningEffort);
			try {
				return await this.send(body, wantsStream, callbacks);
			} catch (error) {
				if (attempt < MAX_PARAM_RETRIES && error instanceof HttpStatusError) {
					const fix = this.planFix(error, body);
					if (fix) {
						this.applyFix(fix);
						continue;
					}
				}
				throw error;
			}
		}
	}

	/** One attempt: stream when the caller wants deltas/abort, else a plain POST. */
	private async send(
		body: Record<string, unknown>,
		wantsStream: boolean,
		callbacks?: ChatCallbacks
	): Promise<ChatResult> {
		if (wantsStream && !this.streamDisabled) {
			try {
				return await this.chatStream(
					{ ...body, stream: true, ...(this.wire.streamParams ?? {}) },
					callbacks
				);
			} catch (error) {
				if (isAbortError(error) || !(error instanceof HttpStatusError)) {
					throw error; // user abort or network-level problem — surface it
				}
				// Credentials, not transport: the identical request without `stream`
				// fails identically, so don't spend a second rejected request (and a
				// second rate-limit hit, and a second audit-log entry) proving it.
				if (isAuthFailure(error.status)) throw error;
				// A rejected body param isn't a streaming problem — hand it back so
				// chat() can fix the body instead of blaming the transport. Ask for
				// the SAME decision chat() will make: a rejection we can't act on
				// (an essential or required param) must still get the plain retry,
				// or a 400 that non-streaming would have survived kills the chat.
				if (this.planFix(error, body)) throw error;
				// Server rejected the *streaming* request. Retry plain; only if
				// that succeeds is streaming itself the problem → stick to plain.
				const result = await this.chatPlain(body, callbacks?.signal);
				this.streamDisabled = true;
				console.warn(
					`[Lantern] LLM server rejected streaming (HTTP ${error.status}); ` +
					"using non-streaming requests until settings change."
				);
				return result;
			}
		}
		return this.chatPlain(body, callbacks?.signal);
	}

	/**
	 * What a 400 says we should change, or null when nothing we can change would
	 * help. PURE — it reads state but never writes it, because two callers need
	 * the same answer: `chat()` applies the fix and retries, and `send()` must
	 * know whether a fix is coming before deciding to fall back to non-streaming.
	 * When those two disagreed, a rejection naming an untouchable param (`stream`,
	 * `messages`) skipped the fallback AND never got repaired — a recoverable 400
	 * turned into a dead chat.
	 */
	private planFix(error: HttpStatusError, sentBody: Record<string, unknown>): ParamFix | null {
		// Gated on the FORMAT, not the transport: chat completions and Responses
		// put the key in `error.param`, and Anthropic names it in the message
		// prose (`temperature` is deprecated…) — both are readable. A format that
		// says nothing identifiable must not be guessed at.
		if (!this.wire.namesRejectedParams) return null;
		if (error.status !== 400 && error.status !== 422) return null;
		const rejection = parseParamRejection(error.body);
		if (!rejection) return null;
		const { param, scope, replacement, value } = rejection;

		if (scope === "message") {
			if (!DROPPABLE_MESSAGE_FIELDS.has(param) || this.droppedMessageFields.has(param)) return null;
			return { kind: "dropMessageField", param };
		}
		// Never rewrite the payload itself (model/messages/system/tools), nor a
		// param this format REQUIRES — Anthropic's max_tokens has no valid absence.
		if (ESSENTIAL_PARAMS.has(param) || this.wire.requiredParams?.has(param)) return null;

		// A prescribed value ("set reasoning_effort to 'none'") is an instruction,
		// so it applies even to a param we deliberately omitted — which is exactly
		// the gpt-5.1+ case: function tools need an explicit effort of "none".
		if (value !== undefined) {
			if (this.coercedParams.get(param) === value) return null; // already applied
			return { kind: "coerce", param, value };
		}

		// The server may name a param by the key we already renamed away from
		// (it complains about "max_tokens" when we sent "max_completion_tokens").
		const key = param in sentBody ? param : this.renamedParams.get(param) ?? PARAM_ALIASES.get(param) ?? param;
		// Dropping something we never sent changes nothing — surface it instead.
		if (ESSENTIAL_PARAMS.has(key) || this.wire.requiredParams?.has(key) || !(key in sentBody)) return null;

		if (replacement && !(replacement in sentBody) && !this.renamedParams.has(key)) {
			return { kind: "rename", param: key, replacement };
		}
		if (this.droppedParams.has(key)) return null;
		return { kind: "drop", param: key };
	}

	/** Record a planned fix so the next `buildBody` differs. */
	private applyFix(fix: ParamFix): void {
		switch (fix.kind) {
			case "dropMessageField":
				this.droppedMessageFields.add(fix.param);
				console.warn(`[Lantern] LLM endpoint rejected message field '${fix.param}'; dropping it for this endpoint.`);
				return;
			case "coerce":
				this.coercedParams.set(fix.param, fix.value);
				this.droppedParams.delete(fix.param);
				console.warn(
					`[Lantern] LLM endpoint requires ${fix.param}=${JSON.stringify(fix.value)}; using that for this endpoint.`
				);
				return;
			case "rename":
				this.renamedParams.set(fix.param, fix.replacement);
				console.warn(`[Lantern] LLM endpoint wants '${fix.replacement}' instead of '${fix.param}'; renaming it.`);
				return;
			case "drop":
				this.droppedParams.add(fix.param);
				console.warn(`[Lantern] LLM endpoint rejected '${fix.param}'; dropping it for this endpoint.`);
				return;
		}
	}

	private buildBody(
		messages: ChatMessage[],
		tools: ToolDef[] | undefined,
		model: string,
		effortOverride?: ReasoningEffort
	): Record<string, unknown> {
		const effort = effortOverride ?? this.config.reasoningEffort;
		const body = this.wire.buildBody({
			model,
			messages,
			tools,
			effort,
			temperature: this.config.temperature,
			// Sized to the resolved context; REQUIRED by Anthropic, a runaway
			// backstop everywhere else.
			maxTokens: maxTokensForContext(
				this.budgetContextTokens ?? this.contextTokens ?? this.fallbackContextTokens()
			),
		});
		// OpenAI strictness is a property of the chat-completions body specifically.
		if (this.transport === "chat-completions" && this.apiDialect === "openai") {
			applyOpenAiDialect(body, effort);
		}
		// Learned fixes apply to any format whose errors name the offending param —
		// including Anthropic, where they're what keeps Opus 5 / Fable 5 working
		// (they reject `temperature` and `thinking.type.disabled` respectively).
		if (this.wire.namesRejectedParams) {
			applyLearnedFixes(body, {
				dropped: this.droppedParams,
				renamed: this.renamedParams,
				coerced: this.coercedParams,
				messageFields: this.droppedMessageFields,
			});
		}
		return body;
	}

	private headers(): Record<string, string> {
		return this.wire.headers(this.config.apiKey);
	}

	/**
	 * End the reasoning phase of an in-flight streaming completion early
	 * (llama-server `reasoning_control`). The same stream then proceeds into the
	 * answer. Returns false when the server rejects/lacks the endpoint, so the
	 * UI can say so; the stream is unaffected either way.
	 */
	async endReasoning(id: string, model: string): Promise<boolean> {
		try {
			const res = await requestUrl({
				url: reasoningControlUrl(this.config.baseUrl),
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify({ id, action: "reasoning_end", model }),
				throw: false,
			});
			return res.status === 200;
		} catch {
			return false;
		}
	}

	/** Non-streaming request via Obsidian's requestUrl (no abort support). */
	private async chatPlain(
		body: Record<string, unknown>,
		signal?: AbortSignal
	): Promise<ChatResult> {
		if (signal?.aborted) throw abortError();
		const res = await requestUrl({
			url: this.wire.endpoint(this.config.baseUrl),
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({ ...body, stream: false }),
			throw: false,
		});
		if (signal?.aborted) throw abortError();
		if (res.status !== 200) {
			throw new HttpStatusError(res.status, res.text ?? "");
		}
		return this.wire.parseResult(res.json);
	}

	/** Streaming request via Node http(s) with SSE parsing, abort, and timeouts. */
	private chatStream(
		body: Record<string, unknown>,
		callbacks?: ChatCallbacks
	): Promise<ChatResult> {
		const url = new URL(this.wire.endpoint(this.config.baseUrl));
		const lib = url.protocol === "https:" ? https : http;
		const payload = JSON.stringify(body);
		const connectTimeoutMs = this.config.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
		const idleTimeoutMs = this.config.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
		const signal = callbacks?.signal;
		// Realtime reasoning control: armed only when applyReasoning set it. The
		// control POST needs the completion id (from the stream) + the model name.
		const controlArmed = body.reasoning_control === true;
		const controlModel = typeof body.model === "string" ? body.model : "";
		let completionId: string | null = null;
		let controlOffered = false;
		// Generation-speed window (first visible token → last), used only when the
		// server reports no speed of its own.
		const speed: SpeedSample = { firstAt: null, lastAt: null, chunks: 0, sawReasoning: false };

		return new Promise<ChatResult>((resolve, reject) => {
			if (signal?.aborted) {
				reject(abortError());
				return;
			}

			let settled = false;
			let aborted = false;
			let connectTimer: number | null = null;
			let idleTimer: number | null = null;

			const cleanup = () => {
				if (connectTimer) window.clearTimeout(connectTimer);
				if (idleTimer) window.clearTimeout(idleTimer);
				connectTimer = null;
				idleTimer = null;
				if (signal) signal.removeEventListener("abort", onAbort);
			};
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const succeed = (result: ChatResult) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			};

			const req = lib.request(
				url,
				{
					method: "POST",
					headers: {
						...this.headers(),
						"Content-Length": Buffer.byteLength(payload),
						Accept: "text/event-stream",
					},
					// No keep-alive socket reuse: llama-server closes idle
					// connections and a reused socket then dies with "socket hang
					// up" on the SECOND request of an agent run (verified against
					// a live server; Node ≥19 pools by default). Fresh localhost
					// connections cost microseconds.
					agent: false,
				},
				(res) => {
					if (res.statusCode !== 200) {
						let errBody = "";
						res.setEncoding("utf8");
						res.on("data", (chunk: string) => {
							if (errBody.length < 4096) errBody += chunk;
						});
						res.on("end", () => fail(new HttpStatusError(res.statusCode ?? 0, errBody)));
						res.on("error", (err) => fail(err));
						return;
					}

					const decoder = new SseDecoder();
					// Per-format: chat completions merges flat deltas, Anthropic merges
					// block-indexed events. The decoder is shared — every format puts one
					// JSON payload per `data:` line and repeats its own `type` inside it.
					const acc = this.wire.accumulator();
					const resetIdle = () => {
						if (idleTimer) window.clearTimeout(idleTimer);
						idleTimer = window.setTimeout(() => {
							req.destroy(new Error(`LLM stream stalled (no data for ${idleTimeoutMs / 1000}s)`));
						}, idleTimeoutMs);
					};
					resetIdle();

					res.setEncoding("utf8");
					res.on("data", (chunk: string) => {
						resetIdle();
						for (const data of decoder.feed(chunk)) {
							try {
								const parsed: unknown = JSON.parse(data);
								const delta = acc.push(parsed);
								const id = (parsed as { id?: unknown })?.id;
								if (!completionId && typeof id === "string") completionId = id;
								if (delta.content || delta.reasoning) {
									// Generation-speed window: hosted APIs report no tok/s, so
									// time it from the first token that actually arrived.
									const now = Date.now();
									if (speed.firstAt === null) speed.firstAt = now;
									speed.lastAt = now;
									speed.chunks++;
									if (delta.reasoning) speed.sawReasoning = true;
									callbacks?.onDelta?.(delta);
								} else if (speed.firstAt !== null) {
									// Frames that carry no visible text still mean the server is
									// working — tool-call arguments stream this way, and those
									// tokens are billed in completionTokens. Without this the
									// window ends at the last word of prose while generation
									// continues, overstating the rate.
									speed.lastAt = Date.now();
								}
								// Offer "end reasoning" once thinking has actually started
								// and we have an id to target the control call at.
								if (
									controlArmed &&
									!controlOffered &&
									completionId &&
									delta.reasoning &&
									callbacks?.onReasoningControl
								) {
									controlOffered = true;
									const capturedId = completionId;
									callbacks.onReasoningControl({ end: () => this.endReasoning(capturedId, controlModel) });
								}
							} catch (error) {
								// An error the server sent INSIDE a 200 stream (Anthropic does
								// this for overloaded_error, where a non-streaming call would
								// have been HTTP 529). It is a real failure, not a malformed
								// keep-alive line — surface it instead of streaming silence.
								if (error instanceof WireStreamError) {
									req.destroy();
									fail(error);
									return;
								}
								/* tolerate malformed keep-alive/odd lines */
							}
						}
					});
					res.on("end", () => succeed(withMeasuredSpeed(acc.result(), speed)));
					res.on("error", (err) => fail(aborted ? abortError() : err));
				}
			);

			const onAbort = () => {
				aborted = true;
				req.destroy(abortError());
			};
			if (signal) signal.addEventListener("abort", onAbort, { once: true });

			// TCP-connect watchdog (cleared once the socket is up; response
			// latency afterwards is governed by the idle timeout).
			connectTimer = window.setTimeout(() => {
				req.destroy(new Error(`Could not connect to ${url.host} within ${connectTimeoutMs / 1000}s`));
			}, connectTimeoutMs);
			req.on("socket", (socket) => {
				if (!socket.connecting) {
					if (connectTimer) window.clearTimeout(connectTimer);
					connectTimer = null;
					return;
				}
				socket.once("connect", () => {
					if (connectTimer) window.clearTimeout(connectTimer);
					connectTimer = null;
				});
			});

			req.on("error", (err: Error) => fail(aborted || isAbortError(err) ? abortError() : err));
			req.end(payload);
		});
	}
}

/**
 * Apply reasoning controls to the request body. Sends both the llama-server
 * style (`chat_template_kwargs.enable_thinking` + `thinking_budget_tokens`) and
 * the OpenAI-style (`reasoning_effort`); permissive servers ignore what they
 * don't use, and `applyOpenAiDialect` strips the llama.cpp-only keys for strict
 * ones. (enable_thinking:false verified live to suppress reasoning on llama-server.)
 */
export function applyReasoning(body: Record<string, unknown>, effort: ReasoningEffort | undefined): void {
	if (!effort) return; // unspecified → leave the server/model default

	if (effort === "off") {
		body.chat_template_kwargs = { enable_thinking: false };
		return;
	}
	body.chat_template_kwargs = { enable_thinking: true };
	body.reasoning_effort = effort;
	body.thinking_budget_tokens = THINKING_BUDGET[effort];
	// Arm realtime reasoning control so the UI can end the think phase early via
	// /v1/chat/completions/control (llama-server; ignored by servers that don't
	// support it). Harmless on non-streaming calls — the endpoint is never hit.
	body.reasoning_control = true;
}

/**
 * Chat completions as a WireFormat — the format every local server speaks, and
 * the one every other format is measured against.
 *
 * It lives here rather than under `wire/` because its pieces already did; the
 * seam is the interface, not the file boundary. Moving it is cosmetic and can
 * happen whenever, without changing behavior.
 *
 * Note what is NOT in here: the OpenAI-strictness dialect and the learned
 * drop/rename/set fixes. Those are applied by the client afterwards, because
 * they depend on per-endpoint state the format itself doesn't own.
 */
export const CHAT_COMPLETIONS_WIRE: WireFormat = {
	id: "chat-completions",
	endpoint: chatCompletionsUrl,
	modelsEndpoint: modelsUrl,
	headers: (apiKey?: string) => ({
		"Content-Type": "application/json",
		...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
	}),
	buildBody: (req: WireRequest): Record<string, unknown> => {
		const body: Record<string, unknown> = {
			model: req.model,
			// `reasoning_blocks` is Lantern's internal carrier for ANOTHER provider's
			// opaque reasoning (Anthropic signed thinking, OpenAI encrypted items).
			// No chat-completions server understands it, and forwarding it would
			// hand one vendor a different vendor's chain of thought. `reasoning_content`
			// stays — llama.cpp templates genuinely need it back.
			messages: stripMessageFields(req.messages, new Set(["reasoning_blocks"])),
			temperature: req.temperature ?? 0.2,
			stream: false,
			// Hard cap on TOTAL generated tokens (reasoning + answer) → n_predict on
			// llama-server. Backstop against runaway generation even if a model
			// ignores thinking_budget_tokens.
			max_tokens: req.maxTokens,
		};
		if (req.tools && req.tools.length > 0) {
			body.tools = req.tools;
			body.tool_choice = "auto";
		}
		applyReasoning(body, req.effort);
		return body;
	},
	// Without this OpenAI-compatible servers report no usage on a streamed call.
	streamParams: { stream_options: { include_usage: true } },
	parseResult: (json: unknown) => parseChatResult(json),
	accumulator: () => new ChatStreamAccumulator(),
	/**
	 * llama-server's /v1/models carries TWO lists (verified live): the OpenAI
	 * `data[]` with every SERVED id (each optionally carrying a router `status`),
	 * and an ollama-style `models[]` naming the RESIDENT model(s).
	 */
	parseModels: (json: unknown): ModelCatalog => {
		const root = json as {
			data?: ModelEntry[];
			models?: Array<{ name?: string; model?: string }>;
		};
		return {
			served: (root?.data ?? [])
				.filter((m) => m.id)
				.map((m) => ({ id: m.id as string, state: normalizeLoadState(m.status?.value) })),
			resident: (root?.models ?? []).map((m) => m.name ?? m.model ?? "").filter(Boolean),
		};
	},
	namesRejectedParams: true,
	fallbackContextTokens: () => FALLBACK_CONTEXT_TOKENS,
};

/** The format for a transport id. */
export function wireFor(transport: TransportId): WireFormat {
	return transport === "messages" ? MESSAGES_WIRE : CHAT_COMPLETIONS_WIRE;
}

/** Extract content + tool calls from an OpenAI chat-completions response. */
export function parseChatResult(json: unknown): ChatResult {
	const root = json as {
		choices?: Array<{ message?: ChatMessage & { reasoning_content?: string }; finish_reason?: string }>;
	};
	const choice = root?.choices?.[0];
	const message = choice?.message;
	const usage = parseUsage(json);
	return {
		content: message?.content ?? null,
		toolCalls: Array.isArray(message?.tool_calls) ? message.tool_calls : [],
		reasoning: message?.reasoning_content ?? null,
		...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
		...(usage ? { usage } : {}),
	};
}

/**
 * Token usage from an OpenAI `usage` object and/or llama.cpp's `timings`
 * extension; undefined when neither is present. `contextTokens` prefers timings
 * (prompt_n + cache_n + predicted_n = true occupancy), else total_tokens.
 */
export function parseUsage(json: unknown): ChatUsage | undefined {
	const r = json as {
		usage?: {
			prompt_tokens?: number;
			completion_tokens?: number;
			total_tokens?: number;
			prompt_tokens_details?: { cached_tokens?: number };
			completion_tokens_details?: { reasoning_tokens?: number };
		};
		timings?: { prompt_n?: number; cache_n?: number; predicted_n?: number; predicted_per_second?: number };
	};
	const u = r?.usage;
	const t = r?.timings;
	const hasUsage = !!u && (typeof u.prompt_tokens === "number" || typeof u.total_tokens === "number");
	const hasTimings = !!t && [t.prompt_n, t.cache_n, t.predicted_n].some((x) => typeof x === "number");
	if (!hasUsage && !hasTimings) return undefined;
	const prompt = u?.prompt_tokens ?? 0;
	const completion = u?.completion_tokens ?? 0;
	const total = u?.total_tokens ?? prompt + completion;
	const timingsCtx = hasTimings ? (t.prompt_n ?? 0) + (t.cache_n ?? 0) + (t.predicted_n ?? 0) : undefined;
	// Generation speed: llama.cpp reports it directly; other servers don't.
	const tps = typeof t?.predicted_per_second === "number" && t.predicted_per_second > 0 ? t.predicted_per_second : undefined;
	// Prompt-cache reuse: prefer the OpenAI `cached_tokens`, fall back to llama.cpp's `timings.cache_n`.
	const cachedRaw = u?.prompt_tokens_details?.cached_tokens ?? t?.cache_n;
	const cached = typeof cachedRaw === "number" && cachedRaw > 0 ? cachedRaw : undefined;
	// Reasoning models bill thinking inside completion_tokens; the breakdown says
	// how much of the output the user never saw. llama.cpp doesn't report it.
	const reasoningRaw = u?.completion_tokens_details?.reasoning_tokens;
	const reasoning = typeof reasoningRaw === "number" && reasoningRaw > 0 ? reasoningRaw : undefined;
	return {
		promptTokens: prompt,
		completionTokens: completion,
		totalTokens: total,
		contextTokens: timingsCtx ?? total,
		...(tps !== undefined ? { tokensPerSecond: tps } : {}),
		...(cached !== undefined ? { cachedTokens: cached } : {}),
		...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
	};
}