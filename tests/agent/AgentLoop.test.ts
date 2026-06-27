import { describe, it, expect, vi } from "vitest";
import {
	AgentLoop,
	parseToolArgs,
	cleanAnswer,
	coldStartMessage,
	formatOffset,
	currentDateTimeContext,
	DEFAULT_SYSTEM_PROMPT,
	type AgentEvent,
} from "../../src/agent/AgentLoop";
import type { LlmClient, ChatResult, ChatMessage } from "../../src/agent/LlmClient";
import type { ToolRegistry } from "../../src/agent/tools";

/** Wrap a chat() mock as an LlmClient, stubbing context detection (honors override). */
function mockLlm(chat: ReturnType<typeof vi.fn>): LlmClient {
	return {
		chat,
		resolveContextTokens: async (override?: number) => (override && override > 0 ? override : 8192),
		charsPerToken: () => 3.5,
		recordCharsPerToken: () => {},
		modelLoadState: async () => "unknown",
	} as unknown as LlmClient;
}

/** A fake LlmClient whose chat() returns queued results in order. */
function fakeLlm(results: ChatResult[]): { client: LlmClient; chat: ReturnType<typeof vi.fn> } {
	const chat = vi.fn();
	for (const r of results) chat.mockResolvedValueOnce(r);
	return { client: mockLlm(chat), chat };
}

function toolCall(name: string, args: string, id = "c1") {
	return { id, type: "function" as const, function: { name, arguments: args } };
}

const searchTool: ToolRegistry = {
	search_vault: {
		def: { type: "function", function: { name: "search_vault", description: "", parameters: {} } },
		execute: vi.fn().mockResolvedValue("Found 1 result: [a.md:1] A"),
	},
};

describe("cleanAnswer", () => {
	it("strips <think> blocks and trims", () => {
		expect(cleanAnswer("<think>hmm, let me reason</think>\n\nThe answer is X.")).toBe("The answer is X.");
	});
	it("handles <thinking> and stray tags", () => {
		expect(cleanAnswer("<thinking>x</thinking> done")).toBe("done");
	});
	it("returns '' for null", () => {
		expect(cleanAnswer(null)).toBe("");
	});
	it("leaves a normal answer untouched", () => {
		expect(cleanAnswer("Just an answer")).toBe("Just an answer");
	});
	it("suppresses an UNCLOSED think block instead of leaking reasoning", () => {
		expect(cleanAnswer("<think>truncated reasoning that never closes")).toBe("");
		expect(cleanAnswer("Answer first. <think>cut off")).toBe("Answer first.");
	});
});

describe("parseToolArgs", () => {
	it("parses valid JSON", () => {
		expect(parseToolArgs('{"query":"x"}')).toEqual({ query: "x" });
	});
	it("recovers the first JSON object from noisy output", () => {
		expect(parseToolArgs('here you go: {"query":"x"} thanks')).toEqual({ query: "x" });
	});
	it("returns {} for empty or unparseable input", () => {
		expect(parseToolArgs("")).toEqual({});
		expect(parseToolArgs("not json")).toEqual({});
	});
});

describe("coldStartMessage", () => {
	it("explains a cold start for not-yet-resident states, null when ready", () => {
		expect(coldStartMessage("loaded")).toBeNull();
		expect(coldStartMessage("unknown")).toBeNull();
		expect(coldStartMessage("downloading")).toMatch(/download/i);
		expect(coldStartMessage("loading")).toMatch(/load/i);
		expect(coldStartMessage("sleeping")).toMatch(/wak/i);
		expect(coldStartMessage("unloaded")).toMatch(/wak/i);
	});
});

describe("formatOffset", () => {
	it("formats whole-hour offsets with the correct sign", () => {
		expect(formatOffset(-120)).toBe("UTC+02:00"); // CEST is ahead of UTC
		expect(formatOffset(300)).toBe("UTC-05:00"); // US EST is behind UTC
		expect(formatOffset(0)).toBe("UTC+00:00");
	});
	it("handles half-hour offsets", () => {
		expect(formatOffset(-330)).toBe("UTC+05:30"); // India
		expect(formatOffset(210)).toBe("UTC-03:30"); // Newfoundland
	});
});

describe("currentDateTimeContext", () => {
	it("includes the date, a UTC offset, and a relative-date instruction", () => {
		const out = currentDateTimeContext(new Date("2026-06-11T12:00:00Z"));
		expect(out).toContain("Current date and time:");
		expect(out).toContain("2026");
		expect(out).toMatch(/UTC[+-]\d{2}:\d{2}/);
		expect(out).toContain('"today"');
	});
});

describe("AgentLoop.run", () => {
	/** Grab the messages array passed to the first chat() call. */
	function systemMessageOf(chat: ReturnType<typeof vi.fn>): string {
		const messages = chat.mock.calls[0][0] as ChatMessage[];
		expect(messages[0].role).toBe("system");
		return String(messages[0].content);
	}

	it("uses the built-in default system prompt with date context appended", async () => {
		const { client, chat } = fakeLlm([{ content: "ok", toolCalls: [] }]);
		await new AgentLoop(client, {}, { maxIterations: 3 }).run("hi", () => {});

		const system = systemMessageOf(chat);
		expect(system.startsWith(DEFAULT_SYSTEM_PROMPT.trim())).toBe(true);
		expect(system).toContain("Current date and time:");
	});

	it("uses resolveSystemPrompt() as the base prompt when it returns text", async () => {
		const { client, chat } = fakeLlm([{ content: "ok", toolCalls: [] }]);
		await new AgentLoop(client, {}, {
			maxIterations: 3,
			resolveSystemPrompt: async () => "MY NOTE PROMPT",
		}).run("hi", () => {});
		const system = systemMessageOf(chat);
		expect(system).toContain("MY NOTE PROMPT");
		expect(system).not.toContain("scientific-paper footnotes"); // built-in replaced
		expect(system).toContain("Current date and time:");
	});

	it("falls back to the built-in when resolveSystemPrompt() returns null", async () => {
		const { client, chat } = fakeLlm([{ content: "ok", toolCalls: [] }]);
		await new AgentLoop(client, {}, {
			maxIterations: 3,
			resolveSystemPrompt: async () => null,
		}).run("hi", () => {});
		expect(systemMessageOf(chat).startsWith(DEFAULT_SYSTEM_PROMPT.trim())).toBe(true);
	});

	it("prefers the note (resolveSystemPrompt) over the inline systemPrompt override", async () => {
		const { client, chat } = fakeLlm([{ content: "ok", toolCalls: [] }]);
		await new AgentLoop(client, {}, {
			maxIterations: 3,
			resolveSystemPrompt: async () => "NOTE WINS",
			systemPrompt: "INLINE OVERRIDE",
		}).run("hi", () => {});
		const system = systemMessageOf(chat);
		expect(system).toContain("NOTE WINS");
		expect(system).not.toContain("INLINE OVERRIDE");
	});

	it("uses the inline systemPrompt when the note resolves empty/null", async () => {
		const { client, chat } = fakeLlm([{ content: "ok", toolCalls: [] }]);
		await new AgentLoop(client, {}, {
			maxIterations: 3,
			resolveSystemPrompt: async () => null,
			systemPrompt: "INLINE OVERRIDE",
		}).run("hi", () => {});
		const system = systemMessageOf(chat);
		expect(system).toContain("INLINE OVERRIDE");
		expect(system).not.toContain("scientific-paper footnotes"); // built-in not used
	});

	it("applies a custom datetime-context template override", async () => {
		const { client, chat } = fakeLlm([{ content: "ok", toolCalls: [] }]);
		await new AgentLoop(client, {}, {
			maxIterations: 3,
			datetimeTemplate: "CLOCK: {{when}} / {{zone}}",
		}).run("hi", () => {});
		const system = systemMessageOf(chat);
		expect(system).toContain("CLOCK: ");
		expect(system).not.toContain("Current date and time:"); // bundled template replaced
	});

	it("uses a custom system prompt when provided, still appending date context", async () => {
		const { client, chat } = fakeLlm([{ content: "ok", toolCalls: [] }]);
		await new AgentLoop(client, {}, { maxIterations: 3, systemPrompt: "FOLLOW MY RULES" }).run("hi", () => {});

		const system = systemMessageOf(chat);
		expect(system).toContain("FOLLOW MY RULES");
		expect(system).not.toContain("scientific-paper footnotes");
		expect(system).toContain("Current date and time:");
	});

	it("treats a blank custom prompt as 'use the default'", async () => {
		const { client, chat } = fakeLlm([{ content: "ok", toolCalls: [] }]);
		await new AgentLoop(client, {}, { maxIterations: 3, systemPrompt: "   " }).run("hi", () => {});

		expect(systemMessageOf(chat)).toContain("scientific-paper footnotes");
	});

	it("returns the answer directly when the model makes no tool calls", async () => {
		const { client, chat } = fakeLlm([{ content: "Hello", toolCalls: [] }]);
		const loop = new AgentLoop(client, {}, { maxIterations: 5 });

		const events: AgentEvent[] = [];
		const { answer } = await loop.run("hi", (e) => events.push(e));

		expect(answer).toBe("Hello");
		expect(chat).toHaveBeenCalledTimes(1);
		expect(events.some((e) => e.type === "answer")).toBe(true);
	});

	it("executes a tool call then answers, feeding the result back", async () => {
		const { client, chat } = fakeLlm([
			{ content: null, toolCalls: [toolCall("search_vault", '{"query":"webhooks"}')] },
			{ content: "Per [[a.md]], do X.", toolCalls: [] },
		]);
		const loop = new AgentLoop(client, searchTool, { maxIterations: 5 });

		const events: AgentEvent[] = [];
		const { answer, messages } = await loop.run("how?", (e) => events.push(e));

		expect(searchTool.search_vault.execute).toHaveBeenCalledWith({ query: "webhooks" });
		expect(answer).toContain("[[a.md]]");
		expect(chat).toHaveBeenCalledTimes(2);
		// A tool message with the result was added to the history.
		expect(messages.some((m) => m.role === "tool" && String(m.content).includes("Found 1 result"))).toBe(true);
		expect(events.map((e) => e.type)).toEqual(
			expect.arrayContaining(["tool_call", "tool_result", "answer"])
		);
	});

	it("runs read-only tool calls in one turn concurrently", async () => {
		// tool_a parks until tool_b has started — only reachable if they overlap.
		let bStarted!: () => void;
		const bEntered = new Promise<void>((r) => (bStarted = r));
		const tools: ToolRegistry = {
			tool_a: {
				def: { type: "function", function: { name: "tool_a", description: "", parameters: {} } },
				execute: vi.fn(async () => {
					await bEntered;
					return "A done";
				}),
			},
			tool_b: {
				def: { type: "function", function: { name: "tool_b", description: "", parameters: {} } },
				execute: vi.fn(async () => {
					bStarted();
					return "B done";
				}),
			},
		};
		const { client } = fakeLlm([
			{ content: null, toolCalls: [toolCall("tool_a", "{}", "a"), toolCall("tool_b", "{}", "b")] },
			{ content: "ok", toolCalls: [] },
		]);

		const events: AgentEvent[] = [];
		await new AgentLoop(client, tools, { maxIterations: 5 }).run("q", (e) => events.push(e));

		// Both ran (no deadlock), and results came back in ORIGINAL call order.
		const results = events.filter((e) => e.type === "tool_result") as Array<{ id: string; content: string }>;
		expect(results.map((r) => r.id)).toEqual(["a", "b"]);
		expect(results[0].content).toContain("A done");
		// Every tool_call is announced before any tool_result lands.
		const types = events.map((e) => e.type);
		expect(types.indexOf("tool_result")).toBeGreaterThan(types.lastIndexOf("tool_call"));
	});

	it("keeps a batch containing a mutating tool sequential", async () => {
		const order: string[] = [];
		const tick = () => new Promise<void>((r) => setTimeout(r, 0));
		const tools: ToolRegistry = {
			read_x: {
				def: { type: "function", function: { name: "read_x", description: "", parameters: {} } },
				execute: vi.fn(async () => {
					order.push("read:start");
					await tick();
					order.push("read:end");
					return "r";
				}),
			},
			write_x: {
				mutates: true,
				def: { type: "function", function: { name: "write_x", description: "", parameters: {} } },
				execute: vi.fn(async () => {
					order.push("write:start");
					await tick();
					order.push("write:end");
					return "w";
				}),
			},
		};
		const { client } = fakeLlm([
			{ content: null, toolCalls: [toolCall("read_x", "{}", "r"), toolCall("write_x", "{}", "w")] },
			{ content: "ok", toolCalls: [] },
		]);

		await new AgentLoop(client, tools, { maxIterations: 5 }).run("q", () => {});

		// Sequential → read fully completes before the write starts (no interleave).
		expect(order).toEqual(["read:start", "read:end", "write:start", "write:end"]);
	});

	it("'Answer now' (wrap-up signal) forces a final answer and stops calling tools", async () => {
		const wrap = new AbortController();
		const execute = vi.fn().mockResolvedValue("result");
		const tools: ToolRegistry = {
			search_vault: {
				def: { type: "function", function: { name: "search_vault", description: "", parameters: {} } },
				execute,
			},
		};
		// The model asks for a tool; the user presses "Answer now" during that
		// call. The loop must skip the tool and force a tool-free final answer.
		const chat = vi
			.fn()
			.mockImplementationOnce(async () => {
				wrap.abort();
				return { content: null, toolCalls: [toolCall("search_vault", "{}")] };
			})
			.mockResolvedValueOnce({ content: "Answer from what I have.", toolCalls: [] });
		const loop = new AgentLoop(mockLlm(chat), tools, { maxIterations: 5 });

		const { answer } = await loop.run("q", () => {}, [], undefined, wrap.signal);

		expect(answer).toBe("Answer from what I have.");
		expect(execute).not.toHaveBeenCalled(); // wrap-up skipped the requested tool
		expect(chat).toHaveBeenCalledTimes(2); // the tool-asking call + the forced final answer
	});

	it("reports an error result for an unknown tool", async () => {
		const { client } = fakeLlm([
			{ content: null, toolCalls: [toolCall("nope", "{}")] },
			{ content: "done", toolCalls: [] },
		]);
		const loop = new AgentLoop(client, {}, { maxIterations: 5 });

		const events: AgentEvent[] = [];
		await loop.run("q", (e) => events.push(e));

		const result = events.find((e) => e.type === "tool_result") as { content: string };
		expect(result.content).toMatch(/unknown tool/i);
	});

	it("forces a final answer when the iteration cap is hit", async () => {
		// Always asks for a tool → never resolves on its own within the cap.
		const { client, chat } = fakeLlm([
			{ content: null, toolCalls: [toolCall("search_vault", "{}")] },
			{ content: "Final answer from gathered context.", toolCalls: [] }, // the forced, tool-free call
		]);
		const loop = new AgentLoop(client, searchTool, { maxIterations: 1 });

		const { answer } = await loop.run("q", () => {});

		expect(answer).toBe("Final answer from gathered context.");
		// 1 loop iteration + 1 forced final call.
		expect(chat).toHaveBeenCalledTimes(2);
		// The forced call is made without tools and with thinking disabled.
		expect(chat.mock.calls[1][1]).toBeUndefined();
		expect(chat.mock.calls[1][2]?.reasoningEffort).toBe("off");
	});

	it("passes the turn's reasoning BACK on the assistant tool-call message (upstream-webui behavior)", async () => {
		const chat = vi
			.fn()
			.mockResolvedValueOnce({
				content: null,
				toolCalls: [toolCall("search_vault", "{}")],
				reasoning: "I should search the vault first.",
			})
			.mockResolvedValueOnce({ content: "done", toolCalls: [] });
		const tools: ToolRegistry = {
			search_vault: {
				def: { type: "function", function: { name: "search_vault", description: "", parameters: {} } },
				execute: vi.fn().mockResolvedValue("results"),
			},
		};
		const loop = new AgentLoop(mockLlm(chat), tools, { maxIterations: 3 });

		await loop.run("q", () => {});

		const secondCallMessages = chat.mock.calls[1][0] as ChatMessage[];
		const assistantTurn = secondCallMessages.find((m) => m.tool_calls?.length);
		expect(assistantTurn?.reasoning_content).toBe("I should search the vault first.");
	});

	it("omits reasoning passback when passReasoningBack is false", async () => {
		const chat = vi
			.fn()
			.mockResolvedValueOnce({ content: null, toolCalls: [toolCall("search_vault", "{}")], reasoning: "hmm" })
			.mockResolvedValueOnce({ content: "done", toolCalls: [] });
		const tools: ToolRegistry = {
			search_vault: {
				def: { type: "function", function: { name: "search_vault", description: "", parameters: {} } },
				execute: vi.fn().mockResolvedValue("r"),
			},
		};
		const loop = new AgentLoop(mockLlm(chat), tools, {
			maxIterations: 3,
			passReasoningBack: false,
		});

		await loop.run("q", () => {});

		const second = chat.mock.calls[1][0] as ChatMessage[];
		expect(second.find((m) => m.tool_calls?.length)?.reasoning_content).toBeUndefined();
	});

	it("retries ONCE with thinking off when the answer is stuck in reasoning", async () => {
		// A live-vault regression: the model wrote its answer inside the
		// template-pre-opened <think> block and never closed it — the server
		// returned empty content with the answer filed under reasoning.
		const chat = vi
			.fn()
			.mockResolvedValueOnce({ content: null, toolCalls: [], reasoning: "Alex is Head of IT…" })
			.mockResolvedValueOnce({ content: "Alex Rivera is Head of Global IT.", toolCalls: [] });
		const loop = new AgentLoop(mockLlm(chat), {}, { maxIterations: 3 });

		const events: AgentEvent[] = [];
		const { answer } = await loop.run("who runs IT?", (e) => events.push(e));

		expect(answer).toBe("Alex Rivera is Head of Global IT.");
		expect(chat).toHaveBeenCalledTimes(2);
		expect(chat.mock.calls[0][2]?.reasoningEffort).toBeUndefined();
		expect(chat.mock.calls[1][2]?.reasoningEffort).toBe("off");
		expect(events.some((e) => e.type === "status" && /stuck in reasoning/i.test((e as { text: string }).text))).toBe(true);
	});

	it("also detects the inline unclosed-<think> variant and never retries twice", async () => {
		const chat = vi.fn().mockResolvedValue({ content: "<think>endless pondering", toolCalls: [] });
		const loop = new AgentLoop(mockLlm(chat), {}, { maxIterations: 3 });

		const { answer } = await loop.run("q", () => {});

		expect(chat).toHaveBeenCalledTimes(2); // one retry, no loop
		expect(chat.mock.calls[1][2]?.reasoningEffort).toBe("off");
		expect(answer).toBe(""); // both empty → honest empty, view shows its fallback
	});

	it("does not retry when a real answer or tool call is present", async () => {
		const chat = vi.fn().mockResolvedValue({ content: "fine", toolCalls: [], reasoning: "thought a bit" });
		const loop = new AgentLoop(mockLlm(chat), {}, { maxIterations: 3 });
		await loop.run("q", () => {});
		expect(chat).toHaveBeenCalledTimes(1);
	});

	it("forwards streamed content as answer_delta, filtering inline <think>", async () => {
		const chat = vi.fn().mockImplementation(
			async (_m: ChatMessage[], _t: unknown, cb?: { onDelta?: (d: { content?: string; reasoning?: string }) => void }) => {
				cb?.onDelta?.({ reasoning: "pondering…" });
				cb?.onDelta?.({ content: "<thi" });
				cb?.onDelta?.({ content: "nk>secret</think>Visible " });
				cb?.onDelta?.({ content: "text" });
				return { content: "<think>secret</think>Visible text", toolCalls: [] };
			}
		);
		const loop = new AgentLoop(mockLlm(chat), {}, { maxIterations: 2 });

		const events: AgentEvent[] = [];
		const { answer } = await loop.run("q", (e) => events.push(e));

		const deltas = events.filter((e) => e.type === "answer_delta").map((e) => (e as { text: string }).text);
		expect(deltas.join("")).toBe("Visible text");
		const reasoning = events.filter((e) => e.type === "reasoning_delta");
		expect(reasoning).toHaveLength(1);
		expect(answer).toBe("Visible text");
	});

	it("appends the promptAppendix between the base prompt and date context", async () => {
		const { client, chat } = fakeLlm([{ content: "ok", toolCalls: [] }]);
		await new AgentLoop(client, {}, { maxIterations: 2, promptAppendix: "WRITE TOOLS INFO" }).run(
			"hi",
			() => {}
		);
		const system = systemMessageOf(chat);
		expect(system).toContain("WRITE TOOLS INFO");
		expect(system.indexOf("WRITE TOOLS INFO")).toBeLessThan(system.indexOf("Current date and time:"));
	});

	it("hard-truncates a tool result that exceeds the per-run context budget (small context)", async () => {
		const tools: ToolRegistry = {
			search_vault: {
				def: { type: "function", function: { name: "search_vault", description: "", parameters: {} } },
				execute: vi.fn().mockResolvedValue("y".repeat(50_000)),
			},
		};
		const { client } = fakeLlm([
			{ content: null, toolCalls: [toolCall("search_vault", "{}", "c1")] },
			{ content: "done", toolCalls: [] },
		]);
		// Small context → small tool budget → the 50k result must be trimmed.
		const loop = new AgentLoop(client, tools, { maxIterations: 5, contextTokensOverride: 4000 });

		const { messages } = await loop.run("q", () => {});
		const tool = messages.find((m) => m.role === "tool");
		expect(tool?.content?.length).toBeLessThan(20_000);
		expect(tool?.content).toContain("[trimmed: context budget reached");
	});

	it("leaves tool results untrimmed when the context is large", async () => {
		const result = "z".repeat(10_000);
		const tools: ToolRegistry = {
			search_vault: {
				def: { type: "function", function: { name: "search_vault", description: "", parameters: {} } },
				execute: vi.fn().mockResolvedValue(result),
			},
		};
		const { client } = fakeLlm([
			{ content: null, toolCalls: [toolCall("search_vault", "{}", "c1")] },
			{ content: "done", toolCalls: [] },
		]);
		const loop = new AgentLoop(client, tools, { maxIterations: 5, contextTokensOverride: 200_000 });

		const { messages } = await loop.run("q", () => {});
		expect(messages.find((m) => m.role === "tool")?.content).toBe(result);
	});

	it("emits a usage event with aggregated tokens when the server reports usage", async () => {
		const events: AgentEvent[] = [];
		const { client } = fakeLlm([
			{
				content: null,
				toolCalls: [toolCall("search_vault", "{}", "c1")],
				usage: { promptTokens: 1000, completionTokens: 50, totalTokens: 1050, contextTokens: 1050 },
			},
			{
				content: "done",
				toolCalls: [],
				finishReason: "stop",
				usage: { promptTokens: 1500, completionTokens: 80, totalTokens: 1580, contextTokens: 1580 },
			},
		]);
		const loop = new AgentLoop(client, searchTool, { maxIterations: 5, contextTokensOverride: 8192 });

		await loop.run("q", (e) => events.push(e));
		const usage = events.find((e) => e.type === "usage");
		expect(usage).toBeDefined();
		if (usage?.type === "usage") {
			expect(usage.completionTokens).toBe(130); // 50 + 80
			expect(usage.contextTokens).toBe(1580); // peak across calls
			expect(usage.basePromptTokens).toBe(1000); // first call's prompt (persistent footprint)
			expect(usage.maxContextTokens).toBe(8192);
			expect(usage.finishReason).toBe("stop");
		}
	});

	it("throws AbortError when the signal is already aborted", async () => {
		const { client, chat } = fakeLlm([{ content: "x", toolCalls: [] }]);
		const loop = new AgentLoop(client, {}, { maxIterations: 2 });
		const controller = new AbortController();
		controller.abort();

		await expect(loop.run("q", () => {}, [], controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(chat).not.toHaveBeenCalled();
	});

	it("stops between tool calls when aborted mid-run", async () => {
		const execute = vi.fn().mockResolvedValue("result");
		const tools: ToolRegistry = {
			search_vault: {
				def: { type: "function", function: { name: "search_vault", description: "", parameters: {} } },
				execute,
			},
		};
		const controller = new AbortController();
		const chat = vi.fn().mockImplementation(async () => {
			controller.abort(); // abort after the model asks for a tool
			return { content: null, toolCalls: [toolCall("search_vault", "{}")] };
		});
		const loop = new AgentLoop(mockLlm(chat), tools, { maxIterations: 5 });

		await expect(loop.run("q", () => {}, [], controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(execute).not.toHaveBeenCalled();
	});
});
