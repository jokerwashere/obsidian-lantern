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
} from "./LlmClient";
import { ThinkTagFilter } from "./stream";
import type { ToolRegistry } from "./tools";
import { deriveContextBudget, estimateMessagesChars } from "./contextBudget";
import { bundledPrompt } from "./promptRegistry";

export type AgentEvent =
	| { type: "status"; text: string }
	| { type: "tool_call"; name: string; args: string }
	| { type: "tool_result"; name: string; content: string }
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
		signal?: AbortSignal
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
		let calibrated = false;
		const recordUsage = (r: ChatResult): void => {
			if (!r.usage) return;
			usageSeen = true;
			completionSum += r.usage.completionTokens;
			peakContext = Math.max(peakContext, r.usage.contextTokens);
			if (r.usage.promptTokens > 0) lastPrompt = r.usage.promptTokens;
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
			});
		};

		for (let step = 0; step < this.options.maxIterations; step++) {
			throwIfAborted(signal);
			onEvent({ type: "status", text: `Thinking (step ${step + 1}/${this.options.maxIterations})…` });

			const res = await this.streamingChat(messages, onEvent, signal, toolDefs);
			recordUsage(res);

			if (res.toolCalls.length === 0) {
				const answer = cleanAnswer(res.content);
				messages.push({ role: "assistant", content: answer });
				onEvent({ type: "answer", text: answer });
				emitUsage(res.finishReason ?? null);
				return { answer, messages };
			}

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

			for (const call of res.toolCalls) {
				throwIfAborted(signal);
				onEvent({ type: "tool_call", name: call.function.name, args: call.function.arguments });
				let result = await this.runTool(call.function.name, call.function.arguments);
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
				onEvent({ type: "tool_result", name: call.function.name, content: result });
				messages.push({
					role: "tool",
					tool_call_id: call.id,
					name: call.function.name,
					content: result,
				});
			}
		}

		// Iteration cap reached — force a final, tool-free answer (thinking off:
		// this call is explicitly "answer now", and it is the most prone to the
		// answered-inside-the-think-block failure).
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
		effort?: ReasoningEffort
	): Promise<ChatResult> {
		const filter = new ThinkTagFilter();
		const res = await this.llm.chat(messages, toolDefs, {
			signal,
			reasoningEffort: effort,
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
