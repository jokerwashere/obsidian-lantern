import { describe, it, expect } from "vitest";
import { SseDecoder, ChatStreamAccumulator, ThinkTagFilter } from "../../src/agent/stream";

describe("SseDecoder", () => {
	it("yields data payloads and flags [DONE]", () => {
		const d = new SseDecoder();
		const out = d.feed('data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n');
		expect(out).toEqual(['{"a":1}', '{"b":2}']);
		expect(d.done).toBe(true);
	});

	it("handles payloads split across feeds at arbitrary points", () => {
		const d = new SseDecoder();
		expect(d.feed('data: {"a"')).toEqual([]);
		expect(d.feed(':1}\nda')).toEqual(['{"a":1}']);
		expect(d.feed("ta: [DO")).toEqual([]);
		expect(d.feed("NE]\n")).toEqual([]);
		expect(d.done).toBe(true);
	});

	it("ignores comments, blank lines, and CRLF", () => {
		const d = new SseDecoder();
		const out = d.feed(': keep-alive\r\n\r\ndata: {"x":1}\r\n\r\n');
		expect(out).toEqual(['{"x":1}']);
	});
});

describe("ChatStreamAccumulator", () => {
	/** Chunk shapes captured verbatim from llama-server b9598. */
	const chunk = (delta: Record<string, unknown>) => ({ choices: [{ delta, finish_reason: null }] });

	it("accumulates content and reports per-chunk deltas", () => {
		const acc = new ChatStreamAccumulator();
		expect(acc.push(chunk({ role: "assistant", content: null }))).toEqual({});
		expect(acc.push(chunk({ content: "hello" }))).toEqual({ content: "hello" });
		expect(acc.push(chunk({ content: " world" }))).toEqual({ content: " world" });
		expect(acc.result()).toEqual({ content: "hello world", toolCalls: [], reasoning: null });
	});

	it("captures the final usage chunk and finish_reason", () => {
		const acc = new ChatStreamAccumulator();
		acc.push(chunk({ content: "hi" }));
		acc.push({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
		acc.push({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } });
		const r = acc.result();
		expect(r.finishReason).toBe("stop");
		expect(r.usage).toEqual({ promptTokens: 40, completionTokens: 8, totalTokens: 48, contextTokens: 48 });
	});

	it("keeps reasoning_content separate from content", () => {
		const acc = new ChatStreamAccumulator();
		expect(acc.push(chunk({ reasoning_content: "Thinking" }))).toEqual({ reasoning: "Thinking" });
		acc.push(chunk({ content: "Answer" }));
		expect(acc.reasoning).toBe("Thinking");
		expect(acc.result().content).toBe("Answer");
	});

	it("merges tool-call fragments by index (id/name first, args concatenated)", () => {
		const acc = new ChatStreamAccumulator();
		acc.push(chunk({ tool_calls: [{ index: 0, id: "G6Q8", type: "function", function: { name: "get_weather", arguments: "{" } }] }));
		acc.push(chunk({ tool_calls: [{ index: 0, function: { arguments: '"city":"' } }] }));
		acc.push(chunk({ tool_calls: [{ index: 0, function: { arguments: "Berlin" } }] }));
		acc.push(chunk({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }));

		const result = acc.result();
		expect(result.toolCalls).toEqual([
			{ id: "G6Q8", type: "function", function: { name: "get_weather", arguments: '{"city":"Berlin"}' } },
		]);
		expect(result.content).toBeNull();
	});

	it("synthesizes ids for servers that omit them and orders calls by index", () => {
		const acc = new ChatStreamAccumulator();
		acc.push(chunk({ tool_calls: [{ index: 1, function: { name: "b", arguments: "{}" } }] }));
		acc.push(chunk({ tool_calls: [{ index: 0, function: { name: "a", arguments: "{}" } }] }));
		const calls = acc.result().toolCalls;
		expect(calls.map((c) => c.function.name)).toEqual(["a", "b"]);
		expect(calls[0].id).toBe("call_0");
		expect(calls[1].id).toBe("call_1");
	});
});

describe("ThinkTagFilter", () => {
	it("passes plain text through", () => {
		const f = new ThinkTagFilter();
		expect(f.feed("hello ") + f.feed("world") + f.flush()).toBe("hello world");
	});

	it("suppresses a complete think block", () => {
		const f = new ThinkTagFilter();
		const out = f.feed("<think>secret reasoning</think>The answer.") + f.flush();
		expect(out).toBe("The answer.");
	});

	it("handles tags split across arbitrary chunk boundaries", () => {
		const text = "Before <think>hidden</think>after";
		for (let i = 0; i < text.length; i++) {
			const f = new ThinkTagFilter();
			const out = f.feed(text.slice(0, i)) + f.feed(text.slice(i)) + f.flush();
			expect(out).toBe("Before after");
		}
	});

	it("suppresses an unclosed think block to the end of stream", () => {
		const f = new ThinkTagFilter();
		const out = f.feed("<think>this never ends ") + f.feed("and keeps going") + f.flush();
		expect(out).toBe("");
	});

	it("supports <thinking> and mixed case", () => {
		const f = new ThinkTagFilter();
		const out = f.feed("<THINKING>x</Thinking>ok") + f.flush();
		expect(out).toBe("ok");
	});

	it("does not eat text that merely starts with '<'", () => {
		const f = new ThinkTagFilter();
		const out = f.feed("a < b and <thing> stays") + f.flush();
		expect(out).toBe("a < b and <thing> stays");
	});

	it("releases a held partial prefix that turns out not to be a tag", () => {
		const f = new ThinkTagFilter();
		const out = f.feed("see <thin") + f.feed("g else") + f.flush();
		expect(out).toBe("see <thing else");
	});
});
