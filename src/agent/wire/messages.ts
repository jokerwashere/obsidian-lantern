/**
 * Anthropic Messages (`POST /v1/messages`) as a Lantern wire format.
 *
 * Why native rather than Anthropic's OpenAI-compat endpoint: that layer is
 * documented as "primarily intended to test and compare model capabilities, and
 * is not considered a long-term or production-ready solution", it IGNORES
 * `reasoning_effort` outright, and it reports no cached tokens. Native gets
 * thinking, prompt-cache accounting, and the real error surface.
 *
 * Shapes here are taken from Anthropic's published request/response and the
 * literal SSE captures in their streaming docs (see tests/agent/wire —
 * the fixtures are those captures verbatim). Nothing is written from memory.
 * NOT yet verified against a live key; that gate is noted in ROADMAP.
 *
 * Where it diverges from chat completions, and why each mapping exists:
 *  - auth is `x-api-key` + `anthropic-version`, not `Authorization: Bearer`.
 *  - the system prompt is a top-level `system`, not a message.
 *  - tools are `{name, description, input_schema}`, not `{function:{…}}`.
 *  - TOOL RESULTS ARE USER CONTENT: a `tool_result` block inside a user
 *    message, keyed by `tool_use_id` — there is no tool role.
 *  - `max_tokens` is REQUIRED.
 *  - reasoning comes back as a `thinking` block carrying a `signature` that must
 *    be replayed byte-identical, so it round-trips as OpaqueReasoning.
 *  - `thinking.type: "enabled"` + `budget_tokens` is deprecated on 4.6 and
 *    400s on 4.7+/Opus 5; those take `{type:"adaptive"}` + `output_config.effort`.
 */

import type { ChatMessage, ChatResult, ChatUsage, ToolCall, ToolDef } from "../LlmClient";
import type { StreamDelta } from "../stream";
import {
	WireStreamError,
	type ModelCatalog,
	type OpaqueReasoning,
	type StreamAccumulator,
	type WireFormat,
	type WireRequest,
} from "./types";

/** Pinned API version; Anthropic requires it on every request. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** Every current Claude model is 200k; the 1M window is a beta opt-in we don't request. */
export const CLAUDE_CONTEXT_TOKENS = 200_000;

/** Anthropic caps sampling at 1.0 (values above are rejected, unlike the compat layer's silent clamp). */
export const MAX_TEMPERATURE = 1;

/**
 * Thinking budgets for models still on manual mode. Minimum is 1024 (the API
 * rejects less) and the budget must stay UNDER max_tokens, since thinking tokens
 * count against it.
 */
const THINKING_BUDGET: Record<"low" | "medium" | "high", number> = {
	low: 2048,
	medium: 8192,
	high: 16384,
};

/**
 * Model generations that only support manual extended thinking (≤ 4.5) — `{type:
 * "adaptive"}` 400s there, while 4.7+ rejects `{type: "enabled"}` in turn, so
 * the choice is per model.
 *
 * Parsed rather than pattern-matched because ids come in two shapes: the old
 * version-first `claude-3-5-sonnet-20241022` and the current family-first
 * `claude-sonnet-4-5-20250929` / `claude-opus-5`, with an optional date suffix.
 *
 * A name-based rule ages, so it is only the OPENING guess: Anthropic documents
 * distinguishable 400s for both directions ("thinking.type.enabled is not
 * supported" / the adaptive equivalent), which the client should use to swap
 * modes once and remember. See ROADMAP.
 */
export function usesManualThinking(model: string): boolean {
	const id = model.toLowerCase().replace(/-\d{8}$/, ""); // drop the release-date suffix
	if (/^claude-[0-3](?:-|$)/.test(id)) return true; // version-first naming: claude-3-5-sonnet, claude-2
	const version = /-(\d+)(?:-(\d+))?$/.exec(id);
	if (!version) return false; // unversioned/preview ids → assume current behavior
	const major = Number(version[1]);
	const minor = version[2] === undefined ? 0 : Number(version[2]);
	return major < 4 || (major === 4 && minor <= 5);
}

/** `.../v1` → `.../v1/messages` (trailing slashes tolerated). */
export function messagesUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/messages`;
}

/** `.../v1` → `.../v1/models`. */
export function anthropicModelsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/models`;
}

export function anthropicHeaders(apiKey?: string): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"anthropic-version": ANTHROPIC_VERSION,
	};
	if (apiKey) headers["x-api-key"] = apiKey;
	return headers;
}

/** A content block in a request body. Loose by design — we only ever build a few shapes. */
type Block = Record<string, unknown>;

/** `{type:"function", function:{name, description, parameters}}` → Anthropic's flat tool. */
export function toAnthropicTools(tools: ToolDef[]): Block[] {
	return tools.map((t) => ({
		name: t.function.name,
		description: t.function.description,
		input_schema: t.function.parameters,
	}));
}

/** Reasoning config for a model + effort, or undefined when the model gets none. */
export function thinkingFor(
	model: string,
	effort: WireRequest["effort"],
	maxTokens: number
): { thinking?: Block; output_config?: Block } {
	if (!effort) return {}; // unspecified → the model's own default
	if (effort === "off") return { thinking: { type: "disabled" } };

	if (usesManualThinking(model)) {
		// Budget must stay below max_tokens (thinking is billed inside it) and at
		// or above the 1024 floor the API enforces.
		const room = Math.max(1024, Math.floor(maxTokens * 0.6));
		return { thinking: { type: "enabled", budget_tokens: Math.min(THINKING_BUDGET[effort], room) } };
	}
	// Adaptive models: depth lives in output_config.effort, and "summarized"
	// display is what makes thinking_delta events stream at all.
	return {
		thinking: { type: "adaptive", display: "summarized" },
		output_config: { effort },
	};
}

/** Opaque reasoning this transport produced, ready to replay. Other transports' blobs are skipped. */
function ownReasoningBlocks(msg: ChatMessage): Block[] {
	return (msg.reasoning_blocks ?? [])
		.filter((b) => b.transport === "messages")
		.map((b) => b.data as Block);
}

/** Assistant turn → Anthropic content blocks, thinking FIRST (manual mode requires it). */
function assistantBlocks(msg: ChatMessage): Block[] {
	const blocks: Block[] = [...ownReasoningBlocks(msg)];
	if (typeof msg.content === "string" && msg.content.trim()) {
		blocks.push({ type: "text", text: msg.content });
	}
	for (const call of msg.tool_calls ?? []) {
		blocks.push({
			type: "tool_use",
			id: call.id,
			name: call.function.name,
			input: parseArgs(call.function.arguments),
		});
	}
	return blocks;
}

/** tool_use `input` is an OBJECT here, not the JSON string chat completions uses. */
function parseArgs(raw: string): Record<string, unknown> {
	if (!raw || !raw.trim()) return {};
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * Canonical history → Anthropic `messages` + `system`.
 *
 * The structural move: every run of `role:"tool"` messages collapses into ONE
 * user message of `tool_result` blocks, which is where Anthropic expects tool
 * output. Our loop always emits tool results consecutively after the assistant
 * turn that asked for them, so the result alternates user/assistant cleanly.
 */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: Block[] } {
	const systemParts: string[] = [];
	const out: Block[] = [];
	let pendingResults: Block[] = [];

	const flushResults = (): void => {
		if (pendingResults.length === 0) return;
		out.push({ role: "user", content: pendingResults });
		pendingResults = [];
	};

	for (const msg of messages) {
		if (msg.role === "tool") {
			pendingResults.push({
				type: "tool_result",
				tool_use_id: msg.tool_call_id ?? "",
				content: msg.content ?? "",
			});
			continue;
		}
		flushResults();

		if (msg.role === "system") {
			// Anthropic takes a single system prompt; multiples concatenate.
			if (typeof msg.content === "string" && msg.content) systemParts.push(msg.content);
			continue;
		}
		if (msg.role === "user") {
			out.push({ role: "user", content: msg.content ?? "" });
			continue;
		}
		const blocks = assistantBlocks(msg);
		// An empty content array is rejected; a tool-call-only turn always has
		// blocks, so this only guards genuinely empty assistant messages.
		if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
	}
	flushResults();

	return { system: systemParts.join("\n"), messages: out };
}

export function buildMessagesBody(req: WireRequest): Record<string, unknown> {
	const { system, messages } = toAnthropicMessages(req.messages);
	const body: Record<string, unknown> = {
		model: req.model,
		// Required by this API — there is no "unbounded" mode.
		max_tokens: req.maxTokens,
		messages,
	};
	if (system) body.system = system;
	if (req.tools && req.tools.length > 0) {
		body.tools = toAnthropicTools(req.tools);
		body.tool_choice = { type: "auto" };
	}

	const reasoning = thinkingFor(req.model, req.effort, req.maxTokens);
	Object.assign(body, reasoning);

	// Temperature is only accepted alongside thinking when it is 1 — verified
	// live: "`temperature` may only be set to 1 when thinking is enabled or in
	// adaptive mode" (HTTP 400). So it is sent ONLY when thinking is explicitly
	// disabled. Omitting `thinking` entirely is not proof it's off either: Claude
	// 5 thinks by default, so the same rule would apply.
	const thinkingOff = (reasoning.thinking as { type?: string } | undefined)?.type === "disabled";
	if (typeof req.temperature === "number" && thinkingOff) {
		body.temperature = Math.min(Math.max(req.temperature, 0), MAX_TEMPERATURE);
	}
	return body;
}

/** Anthropic stop reasons → the finish reasons the rest of Lantern already reads. */
export function mapStopReason(stop: string | null | undefined): string | null {
	switch (stop) {
		case "max_tokens":
			return "length";
		case "tool_use":
			return "tool_calls";
		case "end_turn":
		case "stop_sequence":
			return "stop";
		default:
			// pause_turn / refusal / model_context_window_exceeded pass through
			// verbatim rather than being flattened into something they aren't.
			return stop ?? null;
	}
}

interface AnthropicUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	/** How many of the billed output tokens were internal reasoning. */
	output_tokens_details?: { thinking_tokens?: number };
}

/**
 * Anthropic usage → ChatUsage. `input_tokens` EXCLUDES cache reads here, so true
 * context occupancy is input + cache read + cache creation + output.
 */
export function toChatUsage(usage: AnthropicUsage | undefined): ChatUsage | undefined {
	if (!usage) return undefined;
	const prompt = usage.input_tokens ?? 0;
	const completion = usage.output_tokens ?? 0;
	const cacheRead = usage.cache_read_input_tokens ?? 0;
	const cacheCreate = usage.cache_creation_input_tokens ?? 0;
	if (prompt === 0 && completion === 0 && cacheRead === 0) return undefined;
	const thinking = usage.output_tokens_details?.thinking_tokens;
	return {
		promptTokens: prompt + cacheRead + cacheCreate,
		completionTokens: completion,
		totalTokens: prompt + cacheRead + cacheCreate + completion,
		contextTokens: prompt + cacheRead + cacheCreate + completion,
		...(cacheRead > 0 ? { cachedTokens: cacheRead } : {}),
		...(typeof thinking === "number" && thinking > 0 ? { reasoningTokens: thinking } : {}),
	};
}

/** A `thinking` / `redacted_thinking` block, wrapped so it replays untouched. */
function opaque(block: unknown): OpaqueReasoning {
	return { transport: "messages", data: block };
}

interface ContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	signature?: string;
	data?: string;
	id?: string;
	name?: string;
	input?: unknown;
}

/** Non-streaming `POST /v1/messages` response → canonical result. */
export function parseMessagesResult(json: unknown): ChatResult {
	const root = json as {
		content?: ContentBlock[];
		stop_reason?: string | null;
		usage?: AnthropicUsage;
	};
	const blocks = Array.isArray(root?.content) ? root.content : [];

	const text: string[] = [];
	const thinking: string[] = [];
	const reasoningBlocks: OpaqueReasoning[] = [];
	const toolCalls: ToolCall[] = [];

	for (const block of blocks) {
		switch (block?.type) {
			case "text":
				if (block.text) text.push(block.text);
				break;
			case "thinking":
				if (block.thinking) thinking.push(block.thinking);
				reasoningBlocks.push(opaque(block));
				break;
			case "redacted_thinking":
				reasoningBlocks.push(opaque(block));
				break;
			case "tool_use":
				toolCalls.push({
					id: block.id ?? "",
					type: "function",
					function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) },
				});
				break;
			default:
				break; // server tools, citations, future block types
		}
	}

	const usage = toChatUsage(root?.usage);
	return {
		content: text.length > 0 ? text.join("") : null,
		toolCalls,
		reasoning: thinking.length > 0 ? thinking.join("") : null,
		...(reasoningBlocks.length > 0 ? { reasoningBlocks } : {}),
		finishReason: mapStopReason(root?.stop_reason),
		...(usage ? { usage } : {}),
	};
}

/** In-flight state for one indexed content block. */
interface BlockDraft {
	type: string;
	/** text_delta / thinking_delta accumulation. */
	text: string;
	/** signature_delta accumulation (thinking blocks). */
	signature: string;
	/** input_json_delta accumulation (tool_use). */
	json: string;
	id: string;
	name: string;
	/** The content_block_start payload, for block types we replay verbatim. */
	start: ContentBlock;
}

/**
 * Streaming accumulator for the Messages SSE dialect.
 *
 * Differences from the chat-completions stream that shape this:
 *  - events are BLOCK-INDEXED (`content_block_start/delta/stop` carry `index`),
 *    not a flat delta object, so state is per index.
 *  - tool arguments arrive as `input_json_delta.partial_json` fragments of a
 *    JSON string, even though the final `input` is an object.
 *  - thinking streams as `thinking_delta`, then exactly one `signature_delta`
 *    just before `content_block_stop`.
 *  - `usage` on `message_delta` is CUMULATIVE, so it's assigned, not summed.
 *  - there is no `[DONE]`; the stream ends at `message_stop`.
 *  - an `error` event can arrive inside a 200 response.
 */
export class MessagesStreamAccumulator implements StreamAccumulator {
	private blocks = new Map<number, BlockDraft>();
	private order: number[] = [];
	private stopReason: string | null = null;
	private usage: AnthropicUsage = {};

	push(payload: unknown): StreamDelta {
		const event = payload as {
			type?: string;
			index?: number;
			message?: { usage?: AnthropicUsage };
			content_block?: ContentBlock;
			delta?: Record<string, unknown>;
			usage?: AnthropicUsage;
			error?: { type?: string; message?: string };
		};

		switch (event?.type) {
			case "message_start":
				if (event.message?.usage) this.mergeUsage(event.message.usage);
				return {};

			case "content_block_start": {
				const start = event.content_block ?? {};
				this.draft(event.index ?? 0, {
					type: start.type ?? "text",
					text: "",
					signature: start.signature ?? "",
					json: "",
					id: start.id ?? "",
					name: start.name ?? "",
					start,
				});
				return {};
			}

			case "content_block_delta": {
				const draft = this.blocks.get(event.index ?? 0);
				if (!draft) return {};
				const delta = event.delta ?? {};
				switch (delta.type) {
					case "text_delta": {
						const text = typeof delta.text === "string" ? delta.text : "";
						draft.text += text;
						return text ? { content: text } : {};
					}
					case "thinking_delta": {
						const text = typeof delta.thinking === "string" ? delta.thinking : "";
						draft.text += text;
						return text ? { reasoning: text } : {};
					}
					case "signature_delta":
						if (typeof delta.signature === "string") draft.signature += delta.signature;
						return {};
					case "input_json_delta":
						if (typeof delta.partial_json === "string") draft.json += delta.partial_json;
						return {};
					default:
						return {};
				}
			}

			case "message_delta":
				if (typeof event.delta?.stop_reason === "string") this.stopReason = event.delta.stop_reason;
				// Cumulative — assign, never add.
				if (event.usage) this.mergeUsage(event.usage);
				return {};

			case "error":
				throw new WireStreamError(event.error?.type ?? "error", event.error?.message ?? "stream error");

			// content_block_stop / message_stop / ping carry nothing we need, and
			// unknown types are explicitly expected to be ignored (versioning policy).
			default:
				return {};
		}
	}

	result(): ChatResult {
		const text: string[] = [];
		const thinking: string[] = [];
		const reasoningBlocks: OpaqueReasoning[] = [];
		const toolCalls: ToolCall[] = [];

		for (const index of this.order) {
			const draft = this.blocks.get(index);
			if (!draft) continue;
			switch (draft.type) {
				case "text":
					if (draft.text) text.push(draft.text);
					break;
				case "thinking":
					if (draft.text) thinking.push(draft.text);
					// Rebuilt rather than reused: the signature only exists after its
					// delta, and it must go back exactly as received.
					reasoningBlocks.push(opaque({ type: "thinking", thinking: draft.text, signature: draft.signature }));
					break;
				case "redacted_thinking":
					reasoningBlocks.push(opaque(draft.start));
					break;
				case "tool_use":
					toolCalls.push({
						id: draft.id,
						type: "function",
						function: { name: draft.name, arguments: draft.json || "{}" },
					});
					break;
				default:
					break;
			}
		}

		const usage = toChatUsage(this.usage);
		return {
			content: text.length > 0 ? text.join("") : null,
			toolCalls,
			reasoning: thinking.length > 0 ? thinking.join("") : null,
			...(reasoningBlocks.length > 0 ? { reasoningBlocks } : {}),
			finishReason: mapStopReason(this.stopReason),
			...(usage ? { usage } : {}),
		};
	}

	private draft(index: number, draft: BlockDraft): void {
		if (!this.blocks.has(index)) this.order.push(index);
		this.blocks.set(index, draft);
	}

	private mergeUsage(usage: AnthropicUsage): void {
		for (const key of [
			"input_tokens",
			"output_tokens",
			"cache_read_input_tokens",
			"cache_creation_input_tokens",
		] as const) {
			if (typeof usage[key] === "number") this.usage[key] = usage[key];
		}
		// Streaming reports the thinking breakdown only on the final message_delta.
		if (usage.output_tokens_details) this.usage.output_tokens_details = usage.output_tokens_details;
	}
}

/** `GET /v1/models` → catalog. Anthropic reports no load state, so everything is "unknown". */
export function parseAnthropicModels(json: unknown): ModelCatalog {
	const data = (json as { data?: Array<{ id?: string }> })?.data ?? [];
	return {
		served: data.filter((m) => m.id).map((m) => ({ id: m.id as string, state: "unknown" as const })),
		resident: [],
	};
}

export const MESSAGES_WIRE: WireFormat = {
	id: "messages",
	endpoint: messagesUrl,
	modelsEndpoint: anthropicModelsUrl,
	headers: anthropicHeaders,
	buildBody: buildMessagesBody,
	parseResult: parseMessagesResult,
	accumulator: () => new MessagesStreamAccumulator(),
	parseModels: parseAnthropicModels,
	/**
	 * True, despite `{type:"error", error:{type, message}}` carrying no `param`
	 * field: Anthropic names the key in the message itself, and the learning
	 * layer needs it. Verified live against real 400s —
	 *   "`temperature` is deprecated for this model."            (Opus 5, Sonnet 5)
	 *   "\"thinking.type.disabled\" is not supported for this model."  (Fable 5)
	 * Both are model-specific and undiscoverable from the model list, so a
	 * drop-and-retry is the only thing that keeps newer models working without a
	 * hand-maintained capability table that would rot on every release.
	 */
	namesRejectedParams: true,
	// max_tokens is mandatory here; dropping it can never be the fix.
	requiredParams: new Set(["max_tokens", "messages", "model"]),
	fallbackContextTokens: () => CLAUDE_CONTEXT_TOKENS,
};
