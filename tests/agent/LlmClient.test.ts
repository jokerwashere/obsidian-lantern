import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import { requestUrl } from "obsidian";
import {
	LlmClient,
	chatCompletionsUrl,
	modelsUrl,
	propsUrl,
	parseChatResult,
	parseUsage,
	applyReasoning,
	maxTokensForContext,
	parseCtxFromArgs,
	parseCtxFromPreset,
	ctxFromModelEntry,
	contextFromModels,
} from "../../src/agent/LlmClient";
import { FALLBACK_CONTEXT_TOKENS } from "../../src/agent/contextBudget";

const mockRequestUrl = vi.mocked(requestUrl);

describe("chatCompletionsUrl", () => {
	it("appends the chat path and strips trailing slashes", () => {
		expect(chatCompletionsUrl("http://localhost:8080/v1")).toBe("http://localhost:8080/v1/chat/completions");
		expect(chatCompletionsUrl("http://localhost:8080/v1/")).toBe("http://localhost:8080/v1/chat/completions");
	});
});

describe("modelsUrl", () => {
	it("appends the models path and strips trailing slashes", () => {
		expect(modelsUrl("http://localhost:8080/v1")).toBe("http://localhost:8080/v1/models");
		expect(modelsUrl("http://localhost:8080/v1/")).toBe("http://localhost:8080/v1/models");
	});
});

describe("parseChatResult", () => {
	it("extracts content and tool calls", () => {
		const r = parseChatResult({
			choices: [{ message: { content: "hi", tool_calls: [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }] } }],
		});
		expect(r.content).toBe("hi");
		expect(r.toolCalls).toHaveLength(1);
	});

	it("defaults to null content and empty tool calls", () => {
		expect(parseChatResult({ choices: [{ message: {} }] })).toEqual({ content: null, toolCalls: [], reasoning: null });
		expect(parseChatResult({})).toEqual({ content: null, toolCalls: [], reasoning: null });
	});
});

describe("applyReasoning", () => {
	it("does nothing when effort is undefined", () => {
		const body: Record<string, unknown> = {};
		applyReasoning(body, undefined);
		expect(body).toEqual({});
	});

	it("disables thinking for 'off'", () => {
		const body: Record<string, unknown> = {};
		applyReasoning(body, "off");
		expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(body.reasoning_effort).toBeUndefined();
	});

	it("enables thinking with effort + token budget for a level", () => {
		const body: Record<string, unknown> = {};
		applyReasoning(body, "medium");
		expect(body.chat_template_kwargs).toEqual({ enable_thinking: true });
		expect(body.reasoning_effort).toBe("medium");
		expect(body.thinking_budget_tokens).toBe(8192);
	});

	it("uses a finite (never -1) budget for high — -1 means INT_MAX/runaway", () => {
		const body: Record<string, unknown> = {};
		applyReasoning(body, "high");
		expect(body.thinking_budget_tokens).toBe(16384);
	});
});

describe("LlmClient.chat", () => {
	const client = new LlmClient({ baseUrl: "http://localhost:8080/v1", apiKey: "secret", model: "qwen" });

	beforeEach(() => vi.clearAllMocks());

	it("posts messages + tools and parses the result", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { choices: [{ message: { content: "answer", tool_calls: [] } }] },
		} as never);

		const tools = [{ type: "function" as const, function: { name: "t", description: "d", parameters: {} } }];
		const res = await client.chat([{ role: "user", content: "q" }], tools);

		expect(res.content).toBe("answer");
		const call = mockRequestUrl.mock.calls[0][0] as { url: string; headers: Record<string, string>; body: string };
		expect(call.url).toBe("http://localhost:8080/v1/chat/completions");
		expect(call.headers["Authorization"]).toBe("Bearer secret");
		const body = JSON.parse(call.body);
		expect(body.tools).toHaveLength(1);
		expect(body.tool_choice).toBe("auto");
		expect(body.model).toBe("qwen");
		expect(body.stream).toBe(false);
		expect(body.max_tokens).toBe(4915); // finite total-generation cap (fallback ctx 8192 × 0.6)
	});

	it("omits tools when none are given", async () => {
		mockRequestUrl.mockResolvedValue({ status: 200, json: { choices: [{ message: { content: "x" } }] } } as never);
		await client.chat([{ role: "user", content: "q" }]);
		const body = JSON.parse((mockRequestUrl.mock.calls[0][0] as { body: string }).body);
		expect(body.tools).toBeUndefined();
		expect(body.tool_choice).toBeUndefined();
	});

	it("throws on non-200", async () => {
		mockRequestUrl.mockResolvedValue({ status: 500, text: "boom", json: undefined } as never);
		await expect(client.chat([{ role: "user", content: "q" }])).rejects.toThrow(/HTTP 500/);
	});
});

describe("LlmClient.listModels", () => {
	const client = new LlmClient({ baseUrl: "http://localhost:8080/v1", apiKey: "secret" });

	beforeEach(() => vi.clearAllMocks());

	it("GETs /models with auth and returns the model ids", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { data: [{ id: "qwen3" }, { id: "gemma" }, {}] },
		} as never);

		const models = await client.listModels();
		expect(models).toEqual(["qwen3", "gemma"]);

		const call = mockRequestUrl.mock.calls[0][0] as { url: string; method: string; headers: Record<string, string> };
		expect(call.url).toBe("http://localhost:8080/v1/models");
		expect(call.method).toBe("GET");
		expect(call.headers["Authorization"]).toBe("Bearer secret");
	});

	it("throws on non-200", async () => {
		mockRequestUrl.mockResolvedValue({ status: 404, json: undefined } as never);
		await expect(client.listModels()).rejects.toThrow(/HTTP 404/);
	});
});

describe("propsUrl", () => {
	it("points at the server root, not /v1", () => {
		expect(propsUrl("http://localhost:8080/v1")).toBe("http://localhost:8080/props");
		expect(propsUrl("http://localhost:8080/v1/")).toBe("http://localhost:8080/props");
		expect(propsUrl("http://localhost:8080")).toBe("http://localhost:8080/props");
	});
});

describe("router context parsing", () => {
	it("reads --ctx-size / -c and --parallel / -np from args", () => {
		expect(parseCtxFromArgs(["--alias", "x", "--ctx-size", "32768"])).toEqual({ ctx: 32768, parallel: undefined });
		expect(parseCtxFromArgs(["-c", "16384", "-np", "2"])).toEqual({ ctx: 16384, parallel: 2 });
		expect(parseCtxFromArgs(["--host", "127.0.0.1"])).toEqual({ ctx: undefined, parallel: undefined });
	});

	it("reads ctx-size from a router preset block", () => {
		expect(parseCtxFromPreset("[default]\nctx-size = 32768\n")).toBe(32768);
		expect(parseCtxFromPreset("nothing here")).toBeUndefined();
	});

	it("computes per-slot ctx (÷ parallel) from a model entry, args before preset", () => {
		expect(ctxFromModelEntry({ id: "m", status: { args: ["--ctx-size", "32768"] } })).toBe(32768);
		expect(ctxFromModelEntry({ id: "m", status: { args: ["--ctx-size", "32768", "--parallel", "2"] } })).toBe(16384);
		expect(ctxFromModelEntry({ id: "m", status: { preset: "ctx-size = 8192" } })).toBe(8192);
		expect(ctxFromModelEntry({ id: "m", status: {} })).toBeNull();
	});

	it("prefers the target model, else falls back to any entry with a ctx", () => {
		const data = [
			{ id: "a", status: { args: ["--ctx-size", "4096"] } },
			{ id: "b", status: { args: ["--ctx-size", "32768"] } },
		];
		expect(contextFromModels(data, "b")).toBe(32768);
		expect(contextFromModels(data, "missing")).toBe(4096); // first parseable
		expect(contextFromModels([{ id: "x", status: {} }])).toBeNull();
	});
});

describe("LlmClient.getContextSize", () => {
	beforeEach(() => vi.clearAllMocks());

	it("reads default_generation_settings.n_ctx from /props (loaded model)", async () => {
		const client = new LlmClient({ baseUrl: "http://localhost:8080/v1" });
		mockRequestUrl.mockImplementation(((opts: { url: string }) =>
			opts.url.endsWith("/props")
				? { status: 200, json: { default_generation_settings: { n_ctx: 16384 } } }
				: { status: 200, json: { data: [] } }) as never);
		expect(await client.getContextSize()).toBe(16384);
	});

	it("falls back to router /v1/models args when /props reports n_ctx 0", async () => {
		const client = new LlmClient({ baseUrl: "http://localhost:8080/v1", model: "qwen" });
		mockRequestUrl.mockImplementation(((opts: { url: string }) =>
			opts.url.endsWith("/props")
				? { status: 200, json: { role: "router", default_generation_settings: { n_ctx: 0 } } }
				: {
						status: 200,
						json: {
							data: [
								{ id: "other", status: { args: ["--ctx-size", "4096"] } },
								{ id: "qwen", status: { args: ["--ctx-size", "32768"] } },
							],
						},
					}) as never);
		expect(await client.getContextSize()).toBe(32768);
	});

	it("memoizes detection, and resolveContextTokens honors override then fallback", async () => {
		const client = new LlmClient({ baseUrl: "http://localhost:8080/v1" });
		mockRequestUrl.mockResolvedValue({ status: 404, json: undefined } as never);
		expect(await client.getContextSize()).toBeNull();
		const callsAfterFirst = mockRequestUrl.mock.calls.length;
		await client.getContextSize();
		expect(mockRequestUrl.mock.calls.length).toBe(callsAfterFirst); // cached, no re-probe
		expect(await client.resolveContextTokens()).toBe(FALLBACK_CONTEXT_TOKENS);
		expect(await client.resolveContextTokens(65536)).toBe(65536); // override wins
	});
});

describe("parseUsage", () => {
	it("reads the OpenAI usage object", () => {
		expect(parseUsage({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })).toEqual({
			promptTokens: 100,
			completionTokens: 20,
			totalTokens: 120,
			contextTokens: 120,
		});
	});

	it("prefers llama.cpp timings for contextTokens", () => {
		const u = parseUsage({
			usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
			timings: { prompt_n: 30, cache_n: 70, predicted_n: 20 },
		});
		expect(u?.contextTokens).toBe(120); // 30 + 70 + 20
	});

	it("works from timings alone, and is undefined when neither is present", () => {
		expect(parseUsage({ timings: { prompt_n: 50, cache_n: 0, predicted_n: 10 } })?.contextTokens).toBe(60);
		expect(parseUsage({})).toBeUndefined();
		expect(parseUsage({ choices: [] })).toBeUndefined();
	});
});

describe("parseChatResult usage + finish_reason", () => {
	it("includes usage and finish_reason when the server reports them", () => {
		const r = parseChatResult({
			choices: [{ message: { content: "hi" }, finish_reason: "length" }],
			usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
		});
		expect(r.finishReason).toBe("length");
		expect(r.usage?.totalTokens).toBe(7);
	});

	it("omits them when absent", () => {
		const r = parseChatResult({ choices: [{ message: { content: "hi" } }] });
		expect(r.finishReason).toBeUndefined();
		expect(r.usage).toBeUndefined();
	});
});

describe("LlmClient.charsPerToken calibration", () => {
	it("defaults, then learns a clamped EMA from samples", () => {
		const client = new LlmClient({ baseUrl: "http://localhost:8080/v1" });
		expect(client.charsPerToken()).toBe(3.5); // default
		client.recordCharsPerToken(4);
		expect(client.charsPerToken()).toBe(4); // first sample sets it
		client.recordCharsPerToken(100); // clamped to 8, EMA moves toward it
		expect(client.charsPerToken()).toBeGreaterThan(4);
		expect(client.charsPerToken()).toBeLessThanOrEqual(8);
		const before = client.charsPerToken();
		client.recordCharsPerToken(0); // invalid → ignored
		expect(client.charsPerToken()).toBe(before);
	});
});

describe("maxTokensForContext", () => {
	it("sizes a finite generation cap to the context, clamped", () => {
		expect(maxTokensForContext(32768)).toBe(19661); // 32768 × 0.6, above the 16384 high budget
		expect(maxTokensForContext(8192)).toBe(4915);
		expect(maxTokensForContext(2048)).toBe(2048); // min clamp
		expect(maxTokensForContext(1_000_000)).toBe(24576); // max clamp
		expect(maxTokensForContext(0)).toBe(4915); // non-positive → fallback ctx 8192
	});
});
