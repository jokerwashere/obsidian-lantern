/**
 * Pure streaming primitives for the OpenAI-compatible chat stream.
 *
 * Shapes are grounded against a live llama-server (b9598) probe:
 *  - SSE lines: `data: {json}\n\n`, terminated by `data: [DONE]`.
 *  - Text arrives as `choices[0].delta.content` fragments; reasoning models
 *    served by llama-server emit `delta.reasoning_content` fragments instead
 *    of inline <think> tags (the inline form is still filtered, as a fallback
 *    for servers/templates that don't extract reasoning).
 *  - Tool calls stream as `delta.tool_calls[{index, id?, type?, function:
 *    {name?, arguments?}}]`: the first chunk per index carries id/name, later
 *    chunks carry only argument fragments → merge by index, concatenate
 *    arguments.
 */

import type { ChatResult, ToolCall, ChatUsage } from "./LlmClient";
import { parseUsage } from "./LlmClient";

/**
 * Incremental `data:`-line decoder for an OpenAI-compatible SSE stream.
 * Line-based: every OpenAI-compatible server emits one complete JSON payload
 * per `data:` line (multi-line data fields are legal SSE but unused here).
 */
export class SseDecoder {
	private buf = "";
	/** True once `data: [DONE]` was seen. */
	done = false;

	/** Feed raw text; returns the complete JSON payload strings found. */
	feed(text: string): string[] {
		this.buf += text;
		const out: string[] = [];
		let nl: number;
		while ((nl = this.buf.indexOf("\n")) !== -1) {
			const line = this.buf.slice(0, nl).replace(/\r$/, "");
			this.buf = this.buf.slice(nl + 1);
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trimStart();
			if (data === "[DONE]") {
				this.done = true;
				continue;
			}
			if (data) out.push(data);
		}
		return out;
	}
}

/** What a single parsed stream chunk contributed. */
export interface StreamDelta {
	content?: string;
	reasoning?: string;
}

interface ToolCallDraft {
	id?: string;
	name?: string;
	args: string;
}

/** Minimal shape of an OpenAI chat-completions stream chunk. */
interface StreamChunk {
	choices?: Array<{
		finish_reason?: string | null;
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
	}>;
	/** Final usage chunk (sent when stream_options.include_usage is set). */
	usage?: unknown;
	/** llama.cpp timings (often attached to the final chunk). */
	timings?: unknown;
}

/** Accumulates stream chunks into a final ChatResult. */
export class ChatStreamAccumulator {
	content = "";
	reasoning = "";
	private tools = new Map<number, ToolCallDraft>();
	private finishReason: string | null = null;
	private usageRaw: { usage?: unknown; timings?: unknown } | null = null;

	/** Apply one parsed chunk; returns what it contributed (for live UI). */
	push(chunk: unknown): StreamDelta {
		const c = chunk as StreamChunk;
		// The final chunk carries usage/timings (empty choices) — capture before
		// the delta early-return below.
		if (c?.usage !== undefined || c?.timings !== undefined) {
			this.usageRaw = { usage: c.usage, timings: c.timings };
		}
		const choice = c?.choices?.[0];
		if (choice?.finish_reason) this.finishReason = choice.finish_reason;
		const delta = choice?.delta;
		const out: StreamDelta = {};
		if (!delta) return out;

		if (typeof delta.content === "string" && delta.content.length > 0) {
			this.content += delta.content;
			out.content = delta.content;
		}
		if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
			this.reasoning += delta.reasoning_content;
			out.reasoning = delta.reasoning_content;
		}
		for (const tc of delta.tool_calls ?? []) {
			const index = tc.index ?? 0;
			let draft = this.tools.get(index);
			if (!draft) {
				draft = { args: "" };
				this.tools.set(index, draft);
			}
			if (tc.id) draft.id = tc.id;
			if (tc.function?.name) draft.name = tc.function.name;
			if (typeof tc.function?.arguments === "string") draft.args += tc.function.arguments;
		}
		return out;
	}

	result(): ChatResult {
		const toolCalls: ToolCall[] = [...this.tools.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([index, draft]) => ({
				// Some servers omit ids on streamed tool calls; synthesize one so
				// the tool-result message can reference it.
				id: draft.id ?? `call_${index}`,
				type: "function" as const,
				function: { name: draft.name ?? "", arguments: draft.args },
			}));
		const usage: ChatUsage | undefined = this.usageRaw ? parseUsage(this.usageRaw) : undefined;
		return {
			content: this.content.length > 0 ? this.content : null,
			toolCalls,
			reasoning: this.reasoning.length > 0 ? this.reasoning : null,
			...(this.finishReason ? { finishReason: this.finishReason } : {}),
			...(usage ? { usage } : {}),
		};
	}
}

const OPEN_TAGS = ["<thinking>", "<think>"];
const CLOSE_TAGS = ["</thinking>", "</think>"];

/** Longest suffix of `text` that is a proper prefix of any of `tags` (case-insensitive). */
function partialTagSuffix(text: string, tags: string[]): number {
	const lower = text.toLowerCase();
	const max = Math.max(...tags.map((t) => t.length)) - 1;
	for (let len = Math.min(max, lower.length); len > 0; len--) {
		const suffix = lower.slice(lower.length - len);
		if (tags.some((t) => t.startsWith(suffix))) return len;
	}
	return 0;
}

/** Earliest case-insensitive index of any tag-start in `text`, with the tag matched. */
function findTag(text: string, tags: string[]): { index: number; tag: string } | null {
	const lower = text.toLowerCase();
	let best: { index: number; tag: string } | null = null;
	for (const tag of tags) {
		const i = lower.indexOf(tag);
		if (i !== -1 && (best === null || i < best.index)) best = { index: i, tag };
	}
	return best;
}

/**
 * Incremental <think>…</think> suppressor for streamed content. Handles tags
 * split across arbitrary chunk boundaries; an unclosed think block suppresses
 * everything to the end of the stream (mirroring cleanAnswer's fallback).
 */
export class ThinkTagFilter {
	private pending = "";
	private inThink = false;

	/** Feed a content fragment; returns the text that may be shown. */
	feed(text: string): string {
		this.pending += text;
		let out = "";

		for (;;) {
			if (!this.inThink) {
				const hit = findTag(this.pending, OPEN_TAGS);
				if (hit) {
					out += this.pending.slice(0, hit.index);
					this.pending = this.pending.slice(hit.index + hit.tag.length);
					this.inThink = true;
					continue;
				}
				// No full opening tag: emit everything except a suffix that could
				// still become one ("<thi" at a chunk boundary).
				const hold = partialTagSuffix(this.pending, OPEN_TAGS);
				out += this.pending.slice(0, this.pending.length - hold);
				this.pending = this.pending.slice(this.pending.length - hold);
				return out;
			}

			const close = findTag(this.pending, CLOSE_TAGS);
			if (close) {
				this.pending = this.pending.slice(close.index + close.tag.length);
				this.inThink = false;
				continue;
			}
			// Still thinking: discard all but a possible partial closing tag.
			const hold = partialTagSuffix(this.pending, CLOSE_TAGS);
			this.pending = this.pending.slice(this.pending.length - hold);
			return out;
		}
	}

	/** End of stream: release any held tail (nothing if inside a think block). */
	flush(): string {
		const tail = this.inThink ? "" : this.pending;
		this.pending = "";
		this.inThink = false;
		return tail;
	}
}
