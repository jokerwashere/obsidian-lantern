/**
 * LlmClient — minimal OpenAI-compatible chat client.
 *
 * Targets a locally-run server (llama.cpp `llama-server`, LM Studio, …) over
 * the standard `/chat/completions` endpoint. Requests STREAM by default via
 * Node's http module (the plugin is desktop-only; Obsidian's `requestUrl`
 * cannot stream or abort — verified against its typings): the UI gets live
 * deltas, a Stop button works (AbortSignal), and connect/idle timeouts stop a
 * hung server from wedging the chat forever.
 *
 * Fallback: if the server answers a streaming request with an HTTP error but
 * then accepts the same request without `stream` (some older llama-server
 * builds rejected stream+tools), non-streaming mode sticks until the config
 * changes. Network-level failures are surfaced, not retried.
 *
 * Note: llama-server needs `--jinja` for tool/function calling to work.
 */

import { requestUrl } from "obsidian";
import * as http from "http";
import * as https from "https";
import { SseDecoder, ChatStreamAccumulator, type StreamDelta } from "./stream";
import { FALLBACK_CONTEXT_TOKENS, CHARS_PER_TOKEN } from "./contextBudget";
import { truncate } from "../util";

export type ChatRole = "system" | "user" | "assistant" | "tool";

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
	 * The turn's extracted reasoning, passed BACK to the server on subsequent
	 * calls within a run — llama.cpp's own webui does this by default
	 * (chat.service.ts), and Qwen-style interleaved-thinking templates need
	 * prior-turn reasoning to render the think-block state consistently.
	 */
	reasoning_content?: string;
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
	/** Generation speed (tokens/sec) from llama.cpp `timings.predicted_per_second`; absent if unreported. */
	tokensPerSecond?: number;
	/** Prompt tokens served from the KV cache (`usage.prompt_tokens_details.cached_tokens`, else `timings.cache_n`); absent if unreported. */
	cachedTokens?: number;
}

export interface ChatResult {
	content: string | null;
	toolCalls: ToolCall[];
	/** Extracted reasoning (servers that separate it, e.g. llama-server). */
	reasoning?: string | null;
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

/** TCP connect watchdog — localhost connects are instant; a hang means a dead host. */
const CONNECT_TIMEOUT_MS = 10_000;
/** No bytes (not even reasoning deltas) for this long = treat the server as hung. */
const IDLE_TIMEOUT_MS = 300_000;

export interface LlmClientConfig {
	/** Base URL including the OpenAI path, e.g. http://localhost:8080/v1 */
	baseUrl: string;
	/** Optional API key (local servers usually ignore it). */
	apiKey?: string;
	/** Model name; llama-server ignores it, LM Studio uses it. */
	model?: string;
	temperature?: number;
	/** Reasoning strength (default: off = no thinking). */
	reasoningEffort?: ReasoningEffort;
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

	constructor(config: LlmClientConfig) {
		this.config = config;
	}

	updateConfig(config: Partial<LlmClientConfig>): void {
		this.config = { ...this.config, ...config };
		this.streamDisabled = false; // a different server may support streaming
		this.resolvedModel = null;
		this.contextTokens = null;
		this.contextTried = false;
		this.learnedCharsPerToken = null;
		this.budgetContextTokens = null;
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
		const headers: Record<string, string> = {};
		if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;

		const res = await requestUrl({
			url: modelsUrl(this.config.baseUrl),
			method: "GET",
			headers,
			throw: false,
		});
		if (res.status !== 200) {
			throw new Error(`HTTP ${res.status}`);
		}
		const json = res.json as {
			data?: Array<{ id?: string }>;
			models?: Array<{ name?: string; model?: string }>;
		};
		const served = (json?.data ?? []).map((m) => m.id ?? "").filter(Boolean);
		const resident = (json?.models ?? []).map((m) => m.name ?? m.model ?? "").filter(Boolean);
		return { served, resident };
	}

	/** Raw /v1/models data[] (with per-model `status`); throws on a non-200/unreachable server. */
	private async fetchModelsData(): Promise<ModelEntry[]> {
		const headers: Record<string, string> = {};
		if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;
		const res = await requestUrl({ url: modelsUrl(this.config.baseUrl), method: "GET", headers, throw: false });
		if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
		return (res.json as { data?: ModelEntry[] })?.data ?? [];
	}

	/**
	 * Per-model load state from the router's /v1/models. Empty when unreachable;
	 * each `state` is "unknown" on servers that don't report one. Used by the
	 * settings model picker to show what's resident vs sleeping.
	 */
	async listModelStatuses(): Promise<Array<{ id: string; state: ModelLoadState }>> {
		const data = await this.fetchModelsData();
		return data
			.filter((m) => m.id)
			.map((m) => ({ id: m.id as string, state: normalizeLoadState(m.status?.value) }));
	}

	/**
	 * Load state of the model the next chat request would hit ("unknown" when the
	 * server doesn't report one). Best-effort: any error → "unknown". Lets the
	 * agent loop warn when the first response will block on a cold model load.
	 */
	async modelLoadState(): Promise<ModelLoadState> {
		try {
			const id = await this.modelForRequest();
			const data = await this.fetchModelsData();
			const entry = data.find((m) => m.id === id) ?? (data.length === 1 ? data[0] : undefined);
			return normalizeLoadState(entry?.status?.value);
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
		const tokens = override && override > 0 ? override : (await this.getContextSize()) ?? FALLBACK_CONTEXT_TOKENS;
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
		const headers: Record<string, string> = {};
		if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;

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
		const body = this.buildBody(messages, tools, await this.modelForRequest(), callbacks?.reasoningEffort);
		const wantsStream = Boolean(callbacks?.onDelta || callbacks?.signal);

		if (wantsStream && !this.streamDisabled) {
			try {
				return await this.chatStream(
					{ ...body, stream: true, stream_options: { include_usage: true } },
					callbacks
				);
			} catch (error) {
				if (isAbortError(error) || !(error instanceof HttpStatusError)) {
					throw error; // user abort or network-level problem — surface it
				}
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

	private buildBody(
		messages: ChatMessage[],
		tools: ToolDef[] | undefined,
		model: string,
		effortOverride?: ReasoningEffort
	): Record<string, unknown> {
		const body: Record<string, unknown> = {
			model,
			messages,
			temperature: this.config.temperature ?? 0.2,
			stream: false,
			// Hard cap on TOTAL generated tokens (reasoning + answer) → n_predict on
			// llama-server. Backstop against runaway generation even if a model
			// ignores thinking_budget_tokens; sized to the resolved context.
			max_tokens: maxTokensForContext(this.budgetContextTokens ?? this.contextTokens ?? FALLBACK_CONTEXT_TOKENS),
		};
		if (tools && tools.length > 0) {
			body.tools = tools;
			body.tool_choice = "auto";
		}
		applyReasoning(body, effortOverride ?? this.config.reasoningEffort);
		return body;
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (this.config.apiKey) {
			headers["Authorization"] = `Bearer ${this.config.apiKey}`;
		}
		return headers;
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
			url: chatCompletionsUrl(this.config.baseUrl),
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({ ...body, stream: false }),
			throw: false,
		});
		if (signal?.aborted) throw abortError();
		if (res.status !== 200) {
			throw new HttpStatusError(res.status, res.text ?? "");
		}
		return parseChatResult(res.json);
	}

	/** Streaming request via Node http(s) with SSE parsing, abort, and timeouts. */
	private chatStream(
		body: Record<string, unknown>,
		callbacks?: ChatCallbacks
	): Promise<ChatResult> {
		const url = new URL(chatCompletionsUrl(this.config.baseUrl));
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
					const acc = new ChatStreamAccumulator();
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
								if (delta.content || delta.reasoning) callbacks?.onDelta?.(delta);
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
							} catch {
								/* tolerate malformed keep-alive/odd lines */
							}
						}
					});
					res.on("end", () => succeed(acc.result()));
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
 * the OpenAI-style (`reasoning_effort`); servers ignore what they don't use.
 * (enable_thinking:false verified live to suppress reasoning on llama-server.)
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
	return {
		promptTokens: prompt,
		completionTokens: completion,
		totalTokens: total,
		contextTokens: timingsCtx ?? total,
		...(tps !== undefined ? { tokensPerSecond: tps } : {}),
		...(cached !== undefined ? { cachedTokens: cached } : {}),
	};
}