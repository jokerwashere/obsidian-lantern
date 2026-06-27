/**
 * AgentLoop — drives the tool-calling loop against the local LLM.
 *
 * Sends the conversation + tool definitions to the model; if it asks to call
 * tools, runs them and feeds the results back; repeats until the model answers
 * or the iteration cap is hit. Emits events so the UI can show a live trace.
 */

import {
	isAbortError,
	abortError,
	type LlmClient,
	type ChatMessage,
	type ToolDef,
	type ReasoningEffort,
	type ChatResult,
	type ModelLoadState,
} from "./LlmClient";
import { ThinkTagFilter } from "./stream";
import type { ToolRegistry } from "./tools";
import { deriveContextBudget, estimateMessagesChars } from "./contextBudget";
import { bundledPrompt } from "./promptRegistry";

export type AgentEvent =
	| { type: "status"; text: string }
	| { type: "tool_call"; id: string; name: string; args: string }
	| { type: "tool_result"; id: string; name: string; content: string }
	/** Live fragment of the assistant's (visible) answer text. */
	| { type: "answer_delta"; text: string }
	/** Live fragment of the model's reasoning (when the server reports it). */
	| { type: "reasoning_delta"; text: string }
	| { type: "answer"; text: string }
	/** Token usage for the just-finished answer (only when the server reports it). */
	| {
			type: "usage";
			/** Final call's prompt tokens (peak input). */
			promptTokens: number;
			/** First call's prompt tokens = persistent conversation footprint. */
			basePromptTokens: number;
			completionTokens: number;
			/** Peak context occupancy reached during the answer. */
			contextTokens: number;
			maxContextTokens: number;
			finishReason: string | null;
			/** Generation speed of the final answer call (tokens/sec); absent if unreported. */
			tokensPerSecond?: number;
			/** Prompt tokens served from the KV cache on the final call; absent if unreported. */
			cachedTokens?: number;
	  };

export interface AgentOptions {
	maxIterations: number;
	/** Inline system-prompt override (settings editor); blank → built-in default. */
	systemPrompt?: string;
	/** Resolve the base prompt per question (note-backed); null → fall through to systemPrompt/default. */
	resolveSystemPrompt?: () => Promise<string | null>;
	/** Extra prompt section (e.g. write-tools teaching when they're enabled). */
	promptAppendix?: string;
	/** Date/time context template ({{when}}/{{zone}}); defaults to the bundled prompt. */
	datetimeTemplate?: string;
	/** The "answer now" message sent at the iteration cap; defaults to the bundled prompt. */
	finalAnswerPrompt?: string;
	/** Pass reasoning back on tool-call turns (default true; see ChatMessage). */
	passReasoningBack?: boolean;
	/** Manual context-window size (tokens); 0/undefined = auto-detect from the server. */
	contextTokensOverride?: number;
}

/**
 * Floor for the per-run tool-result budget, and the size each over-budget
 * result is trimmed to. The budget itself is derived per run from the detected
 * context window (deriveContextBudget) minus the measured system + tool-defs +
 * history base; history BETWEEN turns is compacted separately.
 */
const OVER_BUDGET_RESULT_CHARS = 800;

export interface AgentRunResult {
	answer: string;
	/** Full message history (for follow-up turns). */
	messages: ChatMessage[];
}

/**
 * The built-in system prompt (grounded, cited answers; teaches qmd query craft).
 * Source of truth is the bundled `src/agent/prompts/system.md`, inlined at build
 * time — edit that file to tune or A/B-test the prompt. A custom system-prompt
 * note in settings overrides it; the settings "create" action copies this verbatim.
 */
export const DEFAULT_SYSTEM_PROMPT = bundledPrompt("system");

/**
 * A user-facing "the first response will be slow" line when the target model
 * isn't resident, or null when it's loaded/ready. Turns a mysterious long wait
 * (the model loading into memory) into an explained one.
 */
export function coldStartMessage(state: ModelLoadState): string | null {
	switch (state) {
		case "downloading":
			return "Downloading the model (first run — this can take a while)…";
		case "loading":
			return "Loading the model into memory (first response may be slow)…";
		case "sleeping":
		case "unloaded":
			return "Waking the model (cold start — first response may be slow)…";
		default:
			return null;
	}
}

/**
 * Format a `Date.getTimezoneOffset()` value (minutes, positive = behind UTC) as
 * a signed "UTC±HH:MM" string. e.g. -120 (CEST) -> "UTC+02:00".
 */
export function formatOffset(timezoneOffsetMin: number): string {
	const eastMin = -timezoneOffsetMin;
	const sign = eastMin >= 0 ? "+" : "-";
	const abs = Math.abs(eastMin);
	const hh = String(Math.floor(abs / 60)).padStart(2, "0");
	const mm = String(abs % 60).padStart(2, "0");
	return `UTC${sign}${hh}:${mm}`;
}

/**
 * A single line of temporal context for the model: the user's current local
 * date, time, timezone name, IANA zone, and UTC offset. Recomputed per query so
 * "today"/"this week" stay correct even in a long-running Obsidian session.
 */
export function currentDateTimeContext(now: Date = new Date(), template: string = bundledPrompt("datetime-context")): string {
	const when = new Intl.DateTimeFormat(undefined, {
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(now);

	const tzName =
		new Intl.DateTimeFormat(undefined, { timeZoneName: "long" })
			.formatToParts(now)
			.find((p) => p.type === "timeZoneName")?.value ?? "";
	const iana = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const offset = formatOffset(now.getTimezoneOffset());
	const zone = [tzName, iana, offset].filter(Boolean).join(", ");

	// Template lives in prompts/datetime-context.md ({{when}}/{{zone}} placeholders);
	// a user override (passed in) replaces it.
	return template.trim().replace("{{when}}", when).replace("{{zone}}", zone);
}

export class AgentLoop {
	constructor(
		private llm: LlmClient,
		private tools: ToolRegistry,
		private options: AgentOptions
	) {}

	async run(
		question: string,
		onEvent: (event: AgentEvent) => void,
		history: ChatMessage[] = [],
		signal?: AbortSignal,
		/**
		 * "Answer now": when this fires, end any in-flight reasoning early and
		 * stop calling tools — force a final answer at the next opportunity. A
		 * graceful counterpart to the hard-abort `signal`.
		 */
		wrapUpSignal?: AbortSignal
	): Promise<AgentRunResult> {
		const toolDefs = Object.values(this.tools).map((t) => t.def);
		// Use the custom prompt when set (non-blank), else the built-in default;
		// append the (gated) appendix and fresh temporal context either way.
		// Precedence: a note (resolveSystemPrompt) wins, else the inline override
		// (systemPrompt), else the built-in default — each only when non-blank.
		const note = this.options.resolveSystemPrompt ? (await this.options.resolveSystemPrompt())?.trim() : "";
		const inline = this.options.systemPrompt?.trim();
		const base = note || inline || DEFAULT_SYSTEM_PROMPT;
		const appendix = this.options.promptAppendix?.trim();
		const dateContext = currentDateTimeContext(new Date(), this.options.datetimeTemplate);
		const system = `${base.trim()}${appendix ? `\n\n${appendix}` : ""}\n\n${dateContext}`;

		const messages: ChatMessage[] = [
			{ role: "system", content: system },
			...history,
			{ role: "user", content: question },
		];

		// Per-run tool-result budget: what's left of the prompt context after the
		// fixed cost of system prompt + tool definitions + carried history.
		const ctxTokens = await this.llm.resolveContextTokens(this.options.contextTokensOverride);
		const { promptChars } = deriveContextBudget(ctxTokens, this.llm.charsPerToken());
		const baseChars = estimateMessagesChars(messages) + JSON.stringify(toolDefs).length;
		const toolBudget = Math.max(OVER_BUDGET_RESULT_CHARS, promptChars - baseChars);
		let toolChars = 0;

		// Token-usage aggregation for this answer (only when the server reports it).
		let usageSeen = false;
		let completionSum = 0;
		let peakContext = 0;
		let lastPrompt = 0;
		let basePrompt = 0;
		let lastTps = 0;
		let lastCached = 0;
		let calibrated = false;
		const recordUsage = (r: ChatResult): void => {
			if (!r.usage) return;
			usageSeen = true;
			completionSum += r.usage.completionTokens;
			peakContext = Math.max(peakContext, r.usage.contextTokens);
			if (r.usage.promptTokens > 0) lastPrompt = r.usage.promptTokens;
			// Speed + cache reflect the most recent (i.e. answer-producing) call.
			if (r.usage.tokensPerSecond) lastTps = r.usage.tokensPerSecond;
			if (r.usage.cachedTokens) lastCached = r.usage.cachedTokens;
			// The FIRST call's prompt = the persistent conversation footprint
			// (system + tools + carried history + question), before tool results
			// balloon it. It's the honest "how full is the conversation" number,
			// and the right basis to calibrate chars/token from (baseChars ↔ it).
			if (!calibrated && r.usage.promptTokens > 0) {
				basePrompt = r.usage.promptTokens;
				this.llm.recordCharsPerToken(baseChars / r.usage.promptTokens);
				calibrated = true;
			}
		};
		const emitUsage = (finishReason: string | null): void => {
			if (!usageSeen) return;
			onEvent({
				type: "usage",
				promptTokens: lastPrompt,
				basePromptTokens: basePrompt,
				completionTokens: completionSum,
				contextTokens: peakContext,
				maxContextTokens: ctxTokens,
				finishReason,
				...(lastTps > 0 ? { tokensPerSecond: lastTps } : {}),
				...(lastCached > 0 ? { cachedTokens: lastCached } : {}),
			});
		};

		// If the target model isn't resident, the FIRST call blocks while the
		// server loads/wakes it — surface that so a long first wait isn't a
		// mystery (best-effort: any probe failure → no message → normal status).
		const coldMessage = coldStartMessage(await this.llm.modelLoadState());

		// "Answer now": hold the current call's reasoning-end handle so a wrap-up
		// request can end thinking immediately, even mid-stream. The loop also
		// stops issuing tool calls once requested (the break points below).
		const wrapUpRequested = (): boolean => Boolean(wrapUpSignal?.aborted);
		let endCurrentReasoning: (() => Promise<boolean>) | null = null;
		if (wrapUpSignal) {
			wrapUpSignal.addEventListener("abort", () => void endCurrentReasoning?.(), { once: true });
		}
		const onControl = (end: () => Promise<boolean>): void => {
			endCurrentReasoning = end;
			if (wrapUpRequested()) void end(); // asked before this reasoning started → end it now
		};

		for (let step = 0; step < this.options.maxIterations; step++) {
			throwIfAborted(signal);
			// Wrap-up asked during a prior tool round → don't start another tool
			// call, go straight to the forced final answer.
			if (wrapUpRequested() && step > 0) break;
			const thinking = `Thinking (step ${step + 1}/${this.options.maxIterations})…`;
			onEvent({ type: "status", text: step === 0 && coldMessage ? coldMessage : thinking });

			const res = await this.streamingChat(messages, onEvent, signal, toolDefs, undefined, onControl);
			endCurrentReasoning = null; // this call is done; nothing to end anymore
			recordUsage(res);

			if (res.toolCalls.length === 0) {
				const answer = cleanAnswer(res.content);
				messages.push({ role: "assistant", content: answer });
				onEvent({ type: "answer", text: answer });
				emitUsage(res.finishReason ?? null);
				return { answer, messages };
			}

			// Wrap-up asked during THIS call → drop its tool calls (don't run them)
			// and force a final answer from the context gathered so far.
			if (wrapUpRequested()) break;

			// Record the assistant turn that requested the tools, then run each.
			// Its reasoning is passed back (upstream-webui behavior): Qwen-style
			// templates re-render prior thinking to keep the think-block state
			// consistent across tool round-trips — withholding it is what made
			// models answer inside a never-closed think block.
			const passBack = this.options.passReasoningBack !== false;
			messages.push({
				role: "assistant",
				content: res.content,
				tool_calls: res.toolCalls,
				...(passBack && res.reasoning ? { reasoning_content: res.reasoning } : {}),
			});

			throwIfAborted(signal);
			// Announce every requested call before any result lands (under
			// concurrency results may finish out of order; the UI maps each
			// result back to its call by id).
			for (const call of res.toolCalls) {
				onEvent({ type: "tool_call", id: call.id, name: call.function.name, args: call.function.arguments });
			}

			// Read-only tools are independent → run them concurrently (a turn with
			// search_vault + search_references + read_file finishes in one round
			// trip instead of three). A batch containing any mutating tool stays
			// sequential so its Apply/Deny cards don't stack. runTool never throws
			// (it captures tool errors as strings), so Promise.all can't reject.
			const anyMutating = res.toolCalls.some((c) => this.tools[c.function.name]?.mutates);
			const rawResults = anyMutating
				? await this.runToolsSequential(res.toolCalls, signal)
				: await Promise.all(res.toolCalls.map((c) => this.runTool(c.function.name, c.function.arguments)));
			throwIfAborted(signal);

			// Apply the per-run tool-result budget and feed results back in the
			// ORIGINAL call order (deterministic regardless of completion order).
			for (let i = 0; i < res.toolCalls.length; i++) {
				const call = res.toolCalls[i];
				let result = rawResults[i];
				// Spend the remaining budget (with a floor so every result keeps
				// at least a useful stub), never blow past it.
				const remaining = toolBudget - toolChars;
				if (result.length > remaining) {
					const keep = Math.max(remaining, OVER_BUDGET_RESULT_CHARS);
					if (result.length > keep) {
						result =
							result.slice(0, keep) +
							"\n…[trimmed: context budget reached — answer from what you have]";
					}
				}
				toolChars += result.length;
				onEvent({ type: "tool_result", id: call.id, name: call.function.name, content: result });
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					name: call.function.name,
					content: result,
				});
			}
		}

		// Iteration cap reached OR the user pressed "Answer now" — force a final,
		// tool-free answer (thinking off: this call is explicitly "answer now",
		// and it is the most prone to the answered-inside-the-think-block failure).
		throwIfAborted(signal);
		onEvent({ type: "status", text: "Wrapping up…" });
		const finalRes = await this.streamingChat(
			[
				...messages,
				{
					role: "user",
					content: (this.options.finalAnswerPrompt ?? bundledPrompt("final-answer")).trim(),
				},
			],
			onEvent,
			signal,
			undefined,
			"off"
		);
		recordUsage(finalRes);
		const answer =
			cleanAnswer(finalRes.content) || "I couldn't find enough in your vault to answer that.";
		messages.push({ role: "assistant", content: answer });
		onEvent({ type: "answer", text: answer });
		emitUsage(finalRes.finishReason ?? null);
		return { answer, messages };
	}

	/**
	 * One LLM call with live deltas forwarded as events. Visible content is
	 * passed through an incremental <think> filter so inline reasoning (from
	 * servers that don't extract it) never flashes up in the UI.
	 *
	 * Stuck-in-reasoning recovery: Qwen-style templates pre-open the <think>
	 * block, and in tool-loop contexts the model sometimes writes its final
	 * answer there and stops without ever closing it — the server then
	 * returns EMPTY content with the real answer filed under reasoning
	 * (observed live in a test vault). When a call ends with no tool
	 * calls, no visible answer, but reasoning text, retry it ONCE with
	 * thinking disabled.
	 */
	private async streamingChat(
		messages: ChatMessage[],
		onEvent: (event: AgentEvent) => void,
		signal?: AbortSignal,
		toolDefs?: ToolDef[],
		effort?: ReasoningEffort,
		/** Receives this call's reasoning-end handle (for "Answer now"); only fires while thinking. */
		onControl?: (end: () => Promise<boolean>) => void
	): Promise<ChatResult> {
		const filter = new ThinkTagFilter();
		const res = await this.llm.chat(messages, toolDefs, {
			signal,
			reasoningEffort: effort,
			// Only armed when reasoning is on (off for the final/forced calls), so
			// this naturally never fires there.
			...(onControl ? { onReasoningControl: (control) => onControl(control.end) } : {}),
			onDelta: (delta) => {
				if (delta.reasoning) {
					onEvent({ type: "reasoning_delta", text: delta.reasoning });
				}
				if (delta.content) {
					const visible = filter.feed(delta.content);
					if (visible) onEvent({ type: "answer_delta", text: visible });
				}
			},
		});
		const tail = filter.flush();
		if (tail) onEvent({ type: "answer_delta", text: tail });

		const stuckInReasoning =
			res.toolCalls.length === 0 &&
			cleanAnswer(res.content) === "" &&
			(Boolean(res.reasoning) || /<think/i.test(res.content ?? ""));
		if (stuckInReasoning && effort !== "off") {
			onEvent({ type: "status", text: "Answer got stuck in reasoning — retrying with thinking off…" });
			return this.streamingChat(messages, onEvent, signal, toolDefs, "off");
		}
		return res;
	}

	private async runTool(name: string, rawArgs: string): Promise<string> {
		const tool = this.tools[name];
		if (!tool) return `Error: unknown tool "${name}".`;
		try {
			return await tool.execute(parseToolArgs(rawArgs));
		} catch (error) {
			return `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	/** Run a batch one at a time (used when it contains a mutating/interactive tool). */
	private async runToolsSequential(calls: ChatResult["toolCalls"], signal?: AbortSignal): Promise<string[]> {
		const out: string[] = [];
		for (const call of calls) {
			throwIfAborted(signal);
			out.push(await this.runTool(call.function.name, call.function.arguments));
		}
		return out;
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

export { isAbortError };

/**
 * Strip inline reasoning (<think>…</think>) blocks and trim the answer. An
 * UNCLOSED think block (reasoning cut off by the token limit) suppresses
 * everything from the opening tag to the end — otherwise the raw
 * chain-of-thought would be shown as the answer.
 */
export function cleanAnswer(content: string | null): string {
	return (content ?? "")
		.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
		.replace(/<think(?:ing)?>[\s\S]*$/i, "")
		.replace(/<\/?think(?:ing)?>/gi, "")
		.trim();
}

/** Parse tool-call arguments, tolerating the malformed JSON small models sometimes emit. */
export function parseToolArgs(raw: string): Record<string, unknown> {
	if (!raw || !raw.trim()) return {};
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		// Fall back to the first {...} block in the string.
		const match = raw.match(/\{[\s\S]*\}/);
		if (match) {
			try {
				return JSON.parse(match[0]) as Record<string, unknown>;
			} catch {
				/* give up */
			}
		}
		return {};
	}
}
