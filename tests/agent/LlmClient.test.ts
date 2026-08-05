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
	normalizeLoadState,
	isColdState,
	reasoningControlUrl,
	withMeasuredSpeed,
	type SpeedSample,
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

	it("arms reasoning_control when thinking is on, not when off", () => {
		const on: Record<string, unknown> = {};
		applyReasoning(on, "low");
		expect(on.reasoning_control).toBe(true);

		const off: Record<string, unknown> = {};
		applyReasoning(off, "off");
		expect(off.reasoning_control).toBeUndefined();
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

describe("LlmClient dialects", () => {
	const ok = { status: 200, json: { choices: [{ message: { content: "OK" } }] } };
	const tools = [{ type: "function" as const, function: { name: "search_vault", description: "d", parameters: {} } }];
	const sentBody = (i = 0) => JSON.parse((mockRequestUrl.mock.calls[i][0] as { body: string }).body);
	/** The 400 OpenAI answers a llama.cpp-shaped body with. */
	const unknownParam = (param: string) => ({
		status: 400,
		text: JSON.stringify({
			error: { message: `Unknown parameter: '${param}'.`, type: "invalid_request_error", param, code: "unknown_parameter" },
		}),
		json: undefined,
	});

	beforeEach(() => vi.clearAllMocks());

	it("sends OpenAI a clean body on the FIRST request (no llama.cpp params)", async () => {
		const client = new LlmClient({ baseUrl: "https://api.openai.com/v1", apiKey: "sk-x", model: "gpt-4o" });
		mockRequestUrl.mockResolvedValue(ok as never);

		await client.chat([{ role: "user", content: "q" }]);

		expect(mockRequestUrl).toHaveBeenCalledTimes(1); // no error, no retry
		const body = sentBody();
		expect(body.chat_template_kwargs).toBeUndefined();
		expect(body.thinking_budget_tokens).toBeUndefined();
		expect(body.reasoning_control).toBeUndefined();
		expect(body.max_tokens).toBeUndefined();
		expect(body.max_completion_tokens).toBe(16384); // 128k assumed ctx, clamped
		expect(body.model).toBe("gpt-4o");
	});

	it("keeps sending the llama.cpp params to a local server", async () => {
		const client = new LlmClient({ baseUrl: "http://localhost:8080/v1", model: "qwen", reasoningEffort: "off" });
		mockRequestUrl.mockResolvedValue(ok as never);

		await client.chat([{ role: "user", content: "q" }]);

		const body = sentBody();
		expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(body.max_tokens).toBe(4915);
		expect(body.max_completion_tokens).toBeUndefined();
	});

	it("maps reasoning effort to reasoning_effort alone on OpenAI", async () => {
		const client = new LlmClient({
			baseUrl: "https://api.openai.com/v1",
			model: "gpt-5",
			reasoningEffort: "medium",
			temperature: 0.2,
		});
		mockRequestUrl.mockResolvedValue(ok as never);

		await client.chat([{ role: "user", content: "q" }]);

		const body = sentBody();
		expect(body.reasoning_effort).toBe("medium");
		expect(body.chat_template_kwargs).toBeUndefined();
		expect(body.temperature).toBeUndefined(); // gpt-5 only accepts the default
	});

	it("learns from a 400 on any other endpoint: drops the param and retries, then omits it", async () => {
		const client = new LlmClient({ baseUrl: "https://gateway.test/v1", model: "m", reasoningEffort: "off" });
		mockRequestUrl
			.mockResolvedValueOnce(unknownParam("chat_template_kwargs") as never)
			.mockResolvedValue(ok as never);

		const res = await client.chat([{ role: "user", content: "q" }]);

		expect(res.content).toBe("OK");
		expect(mockRequestUrl).toHaveBeenCalledTimes(2);
		expect(sentBody(0).chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(sentBody(1).chat_template_kwargs).toBeUndefined();

		// The lesson sticks — the next call starts clean.
		await client.chat([{ role: "user", content: "q2" }]);
		expect(mockRequestUrl).toHaveBeenCalledTimes(3);
		expect(sentBody(2).chat_template_kwargs).toBeUndefined();
	});

	it("honors a server-requested rename (max_tokens → max_completion_tokens)", async () => {
		const client = new LlmClient({ baseUrl: "https://gateway.test/v1", model: "m" });
		mockRequestUrl
			.mockResolvedValueOnce({
				status: 400,
				text: JSON.stringify({
					error: {
						message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
						param: "max_tokens",
						code: "unsupported_parameter",
					},
				}),
				json: undefined,
			} as never)
			.mockResolvedValue(ok as never);

		await client.chat([{ role: "user", content: "q" }]);

		expect(sentBody(1).max_tokens).toBeUndefined();
		expect(sentBody(1).max_completion_tokens).toBe(4915);
	});

	it("drops a message field the server rejects, leaving the caller's messages intact", async () => {
		const client = new LlmClient({ baseUrl: "https://gateway.test/v1", model: "m" });
		mockRequestUrl
			.mockResolvedValueOnce({
				status: 400,
				text: JSON.stringify({
					error: { message: "Unknown parameter: 'reasoning_content'.", param: "messages[1].reasoning_content", code: "unknown_parameter" },
				}),
				json: undefined,
			} as never)
			.mockResolvedValue(ok as never);

		const messages = [
			{ role: "user" as const, content: "q" },
			{ role: "assistant" as const, content: "a", reasoning_content: "thinking…" },
		];
		await client.chat(messages);

		expect(sentBody(1).messages[1].reasoning_content).toBeUndefined();
		expect(messages[1].reasoning_content).toBe("thinking…");
	});

	it("sends reasoning_effort 'none' to a gpt-5 model when the setting is off", async () => {
		const client = new LlmClient({ baseUrl: "https://api.openai.com/v1", model: "gpt-5.6-luna", reasoningEffort: "off" });
		mockRequestUrl.mockResolvedValue(ok as never);

		await client.chat([{ role: "user", content: "q" }], tools);

		expect(mockRequestUrl).toHaveBeenCalledTimes(1); // no 400, no retry
		expect(sentBody().reasoning_effort).toBe("none"); // required for function tools
	});

	it("obeys 'set reasoning_effort to none' — the gpt-5.1+ function-tools 400", async () => {
		const client = new LlmClient({
			baseUrl: "https://api.openai.com/v1",
			model: "gpt-5.6-luna",
			reasoningEffort: "medium",
		});
		mockRequestUrl
			.mockResolvedValueOnce({
				status: 400,
				text: JSON.stringify({
					error: {
						message:
							"Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
						type: "invalid_request_error",
						param: "reasoning_effort",
						code: null,
					},
				}),
				json: undefined,
			} as never)
			.mockResolvedValue(ok as never);

		const res = await client.chat([{ role: "user", content: "q" }], tools);

		expect(res.content).toBe("OK");
		expect(sentBody(0).reasoning_effort).toBe("medium");
		expect(sentBody(1).reasoning_effort).toBe("none"); // coerced, not dropped

		// Sticky: the next question starts at "none" instead of paying the 400 again.
		await client.chat([{ role: "user", content: "q2" }], tools);
		expect(mockRequestUrl).toHaveBeenCalledTimes(3);
		expect(sentBody(2).reasoning_effort).toBe("none");
	});

	it("surfaces a 400 that dropping a param can't fix, without retrying", async () => {
		const client = new LlmClient({ baseUrl: "https://gateway.test/v1", model: "nope" });
		mockRequestUrl.mockResolvedValue({
			status: 400,
			text: JSON.stringify({ error: { message: "The model 'nope' does not exist", param: "model", code: "model_not_found" } }),
			json: undefined,
		} as never);

		await expect(client.chat([{ role: "user", content: "q" }])).rejects.toThrow(/HTTP 400/);
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
	});

	it("gives up after a bounded number of rejections", async () => {
		const client = new LlmClient({ baseUrl: "https://gateway.test/v1", model: "m", reasoningEffort: "medium" });
		// A server that rejects one more real param on every attempt — each one is
		// learnable, so only the retry cap stops the loop.
		const params = [
			"chat_template_kwargs",
			"thinking_budget_tokens",
			"reasoning_control",
			"reasoning_effort",
			"temperature",
			"max_tokens",
		];
		let n = 0;
		mockRequestUrl.mockImplementation((() => unknownParam(params[n++] ?? "temperature")) as never);

		await expect(client.chat([{ role: "user", content: "q" }])).rejects.toThrow(/HTTP 400/);
		expect(mockRequestUrl).toHaveBeenCalledTimes(5); // 1 + MAX_PARAM_RETRIES
	});

	it("forgets what it learned when the endpoint changes", async () => {
		const client = new LlmClient({ baseUrl: "https://gateway.test/v1", model: "m", reasoningEffort: "off" });
		mockRequestUrl.mockResolvedValueOnce(unknownParam("chat_template_kwargs") as never).mockResolvedValue(ok as never);
		await client.chat([{ role: "user", content: "q" }]);
		expect(sentBody(1).chat_template_kwargs).toBeUndefined();

		client.updateConfig({ baseUrl: "http://localhost:8080/v1" });
		await client.chat([{ role: "user", content: "q" }]);
		expect(sentBody(2).chat_template_kwargs).toEqual({ enable_thinking: false });
	});

	it("assumes 128k context for OpenAI without probing /props", async () => {
		const client = new LlmClient({ baseUrl: "https://api.openai.com/v1", model: "gpt-4o" });
		expect(await client.getContextSize()).toBeNull();
		expect(mockRequestUrl).not.toHaveBeenCalled();
		expect(await client.resolveContextTokens()).toBe(128_000);
		expect(await client.resolveContextTokens(32_000)).toBe(32_000); // override still wins
	});
});

describe("LlmClient transport selection", () => {
	const sentTo = (i = 0) => (mockRequestUrl.mock.calls[i][0] as { url: string }).url;
	const sentHeaders = (i = 0) => (mockRequestUrl.mock.calls[i][0] as { headers: Record<string, string> }).headers;
	const sentBody = (i = 0) => JSON.parse((mockRequestUrl.mock.calls[i][0] as { body: string }).body);

	beforeEach(() => vi.clearAllMocks());

	it("routes api.anthropic.com to /v1/messages with x-api-key, not Bearer", async () => {
		const client = new LlmClient({
			baseUrl: "https://api.anthropic.com/v1",
			apiKey: "sk-ant-x",
			model: "claude-sonnet-4-6",
			reasoningEffort: "off",
			temperature: 0.2,
		});
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } },
		} as never);

		const res = await client.chat([
			{ role: "system", content: "sys" },
			{ role: "user", content: "q" },
		]);

		expect(sentTo()).toBe("https://api.anthropic.com/v1/messages");
		expect(sentHeaders()["x-api-key"]).toBe("sk-ant-x");
		expect(sentHeaders()["anthropic-version"]).toBe("2023-06-01");
		expect(sentHeaders()["Authorization"]).toBeUndefined();

		const body = sentBody();
		expect(body.system).toBe("sys"); // lifted out of messages
		expect(body.max_tokens).toBeGreaterThan(0); // required by this API
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body.chat_template_kwargs).toBeUndefined();
		expect(res.content).toBe("OK");
		expect(res.finishReason).toBe("stop");
	});

	it("leaves a LOCAL endpoint on chat completions, whatever the effort", async () => {
		const client = new LlmClient({ baseUrl: "http://localhost:8080/v1", model: "qwen", reasoningEffort: "high" });
		mockRequestUrl.mockResolvedValue({ status: 200, json: { choices: [{ message: { content: "x" } }] } } as never);

		await client.chat([{ role: "user", content: "q" }]);

		expect(sentTo()).toBe("http://localhost:8080/v1/chat/completions");
		expect(sentBody().chat_template_kwargs).toEqual({ enable_thinking: true });
		expect(sentBody().max_tokens).toBe(4915); // unchanged local sizing
	});

	it("honors an explicit format override for a gateway", async () => {
		const client = new LlmClient({ baseUrl: "https://gw.test/v1", model: "claude-sonnet-4-6", transport: "messages" });
		mockRequestUrl.mockResolvedValue({ status: 200, json: { content: [{ type: "text", text: "OK" }] } } as never);
		await client.chat([{ role: "user", content: "q" }]);
		expect(sentTo()).toBe("https://gw.test/v1/messages");
	});

	it("does NOT run the param-learning layer on Anthropic (its errors name no param)", async () => {
		const client = new LlmClient({ baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-6" });
		// The real 400 body, captured live — the param name is only a message prefix.
		mockRequestUrl.mockResolvedValue({
			status: 400,
			text: JSON.stringify({
				type: "error",
				error: { type: "invalid_request_error", message: "chat_template_kwargs: Extra inputs are not permitted" },
			}),
			json: undefined,
		} as never);

		await expect(client.chat([{ role: "user", content: "q" }])).rejects.toThrow(/HTTP 400/);
		expect(mockRequestUrl).toHaveBeenCalledTimes(1); // surfaced, never guessed at
	});

	it("recovers from Anthropic's model-specific 400s, which name the param in prose", async () => {
		// Live-verified against api.anthropic.com: claude-opus-5 / claude-sonnet-5
		// reject `temperature` outright ("is deprecated for this model") even with
		// thinking disabled. Without drop-and-retry those models are unusable, and
		// the failure is terminal because Anthropic sends no `error.param`.
		const client = new LlmClient({
			baseUrl: "https://api.anthropic.com/v1",
			model: "claude-opus-5",
			reasoningEffort: "off",
			temperature: 0.2,
		});
		mockRequestUrl
			.mockResolvedValueOnce({
				status: 400,
				text: JSON.stringify({
					type: "error",
					error: { type: "invalid_request_error", message: "`temperature` is deprecated for this model." },
				}),
				json: undefined,
			} as never)
			.mockResolvedValue({ status: 200, json: { content: [{ type: "text", text: "OK" }] } } as never);

		const res = await client.chat([{ role: "user", content: "q" }]);

		expect(res.content).toBe("OK");
		expect(sentBody(0).temperature).toBe(0.2);
		expect(sentBody(1).temperature).toBeUndefined(); // dropped, then retried
		expect(sentBody(1).max_tokens).toBeGreaterThan(0); // required param untouched
	});

	it("drops the whole thinking key when Anthropic rejects thinking.type.disabled", async () => {
		// claude-fable-5 always thinks; an explicit `disabled` is a 400. The error
		// names `thinking.type.disabled`, and a body param is fixed at its top level.
		const client = new LlmClient({ baseUrl: "https://api.anthropic.com/v1", model: "claude-fable-5", reasoningEffort: "off" });
		mockRequestUrl
			.mockResolvedValueOnce({
				status: 400,
				text: JSON.stringify({
					type: "error",
					error: {
						type: "invalid_request_error",
						message: '"thinking.type.disabled" is not supported for this model. Thinking defaults to adaptive mode.',
					},
				}),
				json: undefined,
			} as never)
			.mockResolvedValue({ status: 200, json: { content: [{ type: "text", text: "OK" }] } } as never);

		await client.chat([{ role: "user", content: "q" }]);

		expect(sentBody(0).thinking).toEqual({ type: "disabled" });
		expect(sentBody(1).thinking).toBeUndefined();
	});

	it("never 'fixes' a 400 by dropping a param the format requires", async () => {
		const client = new LlmClient({ baseUrl: "https://api.anthropic.com/v1", model: "claude-opus-5" });
		mockRequestUrl.mockResolvedValue({
			status: 400,
			text: JSON.stringify({
				type: "error",
				error: { type: "invalid_request_error", message: "max_tokens: Extra inputs are not permitted" },
			}),
			json: undefined,
		} as never);

		await expect(client.chat([{ role: "user", content: "q" }])).rejects.toThrow(/HTTP 400/);
		expect(mockRequestUrl).toHaveBeenCalledTimes(1); // surfaced, not mangled
	});

	it("assumes Claude's 200k window without probing /props", async () => {
		const client = new LlmClient({ baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-6" });
		expect(await client.getContextSize()).toBeNull();
		expect(mockRequestUrl).not.toHaveBeenCalled();
		expect(await client.resolveContextTokens()).toBe(200_000);
	});

	it("lists Anthropic models through the same picker", async () => {
		const client = new LlmClient({ baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-ant-x" });
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { data: [{ id: "claude-opus-5" }, { id: "claude-sonnet-4-6" }] },
		} as never);

		expect(await client.listModels()).toEqual(["claude-opus-5", "claude-sonnet-4-6"]);
		expect(await client.listModelStatuses()).toEqual([
			{ id: "claude-opus-5", state: "unknown" },
			{ id: "claude-sonnet-4-6", state: "unknown" },
		]);
		expect(sentTo()).toBe("https://api.anthropic.com/v1/models");
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

describe("withMeasuredSpeed", () => {
	const usage = { promptTokens: 10, completionTokens: 200, totalTokens: 210, contextTokens: 210 };
	const sample = (over: Partial<SpeedSample> = {}): SpeedSample => ({
		firstAt: 1_000,
		lastAt: 5_000,
		chunks: 100,
		sawReasoning: false,
		...over,
	});

	it("measures tok/s when the server reports none", () => {
		const res = withMeasuredSpeed({ content: "x", toolCalls: [], usage }, sample());
		expect(res.usage?.tokensPerSecond).toBe(50); // 200 tokens / 4s
		expect(res.usage?.tokensPerSecondEstimated).toBe(true);
	});

	it("never overrides a server-reported speed (llama.cpp timings win)", () => {
		const reported = { ...usage, tokensPerSecond: 41 };
		const res = withMeasuredSpeed({ content: "x", toolCalls: [], usage: reported }, sample());
		expect(res.usage?.tokensPerSecond).toBe(41);
		expect(res.usage?.tokensPerSecondEstimated).toBeUndefined();
	});

	it("accepts a short but well-sampled answer", () => {
		// A 42-token reply over ~300ms of real streaming is measurable; an
		// earlier, blunter floor discarded exactly this case against OpenAI.
		const short = { ...usage, completionTokens: 42 };
		const res = withMeasuredSpeed({ content: "x", toolCalls: [], usage: short }, sample({ lastAt: 1_300, chunks: 40 }));
		expect(Math.round(res.usage?.tokensPerSecond ?? 0)).toBe(140);
	});

	it("excludes reasoning that was never streamed from the numerator", () => {
		// OpenAI thinks BEFORE emitting anything visible: those tokens are billed
		// in completionTokens but happened outside the measured window, so
		// dividing them by it inflated the rate several-fold on short answers.
		const withHiddenReasoning = { ...usage, completionTokens: 200, reasoningTokens: 150 };
		const hidden = withMeasuredSpeed({ content: "x", toolCalls: [], usage: withHiddenReasoning }, sample());
		expect(hidden.usage?.tokensPerSecond).toBe(12.5); // (200 - 150) / 4s, not 50

		// Anthropic DOES stream thinking, so those tokens are inside the window
		// and must stay in the numerator.
		const streamed = withMeasuredSpeed(
			{ content: "x", toolCalls: [], usage: withHiddenReasoning },
			sample({ sawReasoning: true })
		);
		expect(streamed.usage?.tokensPerSecond).toBe(50); // 200 / 4s
	});

	it("does not punish a provider for streaming in few, large chunks", () => {
		// Anthropic delivers a whole thinking paragraph in ONE delta. Judging the
		// sample by chunk count would reject it for being efficient.
		const res = withMeasuredSpeed({ content: "x", toolCalls: [], usage }, sample({ chunks: 3 }));
		expect(res.usage?.tokensPerSecond).toBe(50);
		expect(res.usage?.tokensPerSecondEstimated).toBe(true);
	});

	it("refuses samples too thin to mean anything", () => {
		// Too few tokens to rate, however long the window.
		const tiny = { ...usage, completionTokens: 5 };
		expect(
			withMeasuredSpeed({ content: "x", toolCalls: [], usage: tiny }, sample()).usage?.tokensPerSecond
		).toBeUndefined();
		// A single flush: no window at all.
		expect(
			withMeasuredSpeed({ content: "x", toolCalls: [], usage }, sample({ chunks: 1 })).usage?.tokensPerSecond
		).toBeUndefined();
		// Sub-100ms window: divides badly.
		expect(
			withMeasuredSpeed({ content: "x", toolCalls: [], usage }, sample({ lastAt: 1_050 })).usage?.tokensPerSecond
		).toBeUndefined();
		// Nothing streamed at all (non-streaming call).
		expect(
			withMeasuredSpeed({ content: "x", toolCalls: [], usage }, sample({ firstAt: null, lastAt: null, chunks: 0 }))
				.usage?.tokensPerSecond
		).toBeUndefined();
		// No usage → nothing to divide.
		expect(withMeasuredSpeed({ content: "x", toolCalls: [] }, sample()).usage).toBeUndefined();
		// Zero completion tokens → no rate.
		const empty = { ...usage, completionTokens: 0 };
		expect(
			withMeasuredSpeed({ content: "", toolCalls: [], usage: empty }, sample()).usage?.tokensPerSecond
		).toBeUndefined();
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

	it("reads OpenAI's reasoning-token split (billed inside completion_tokens)", () => {
		const u = parseUsage({
			usage: {
				prompt_tokens: 100,
				completion_tokens: 900,
				total_tokens: 1000,
				completion_tokens_details: { reasoning_tokens: 768 },
			},
		});
		expect(u?.completionTokens).toBe(900);
		expect(u?.reasoningTokens).toBe(768);
		// llama.cpp reports no such breakdown — absent, not zero.
		expect(parseUsage({ usage: { prompt_tokens: 1, completion_tokens: 2 } })?.reasoningTokens).toBeUndefined();
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

	it("reads generation speed and cached tokens (OpenAI details)", () => {
		const u = parseUsage({
			usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 64 } },
			timings: { prompt_n: 30, cache_n: 70, predicted_n: 20, predicted_per_second: 41.7 },
		});
		expect(u?.tokensPerSecond).toBeCloseTo(41.7);
		expect(u?.cachedTokens).toBe(64); // prefers the OpenAI cached_tokens
	});

	it("falls back to timings.cache_n for cached tokens, omits zero/absent speed+cache", () => {
		const fromTimings = parseUsage({ timings: { prompt_n: 30, cache_n: 70, predicted_n: 20 } });
		expect(fromTimings?.cachedTokens).toBe(70);
		expect(fromTimings?.tokensPerSecond).toBeUndefined();

		const noExtras = parseUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
		expect(noExtras?.tokensPerSecond).toBeUndefined();
		expect(noExtras?.cachedTokens).toBeUndefined();
	});
});

describe("normalizeLoadState / isColdState", () => {
	it("maps known router status values, others → unknown", () => {
		expect(normalizeLoadState("loaded")).toBe("loaded");
		expect(normalizeLoadState("LOADING")).toBe("loading");
		expect(normalizeLoadState("sleeping")).toBe("sleeping");
		expect(normalizeLoadState("unloaded")).toBe("unloaded");
		expect(normalizeLoadState("downloading")).toBe("downloading");
		expect(normalizeLoadState(undefined)).toBe("unknown");
		expect(normalizeLoadState("weird")).toBe("unknown");
	});

	it("treats only not-yet-resident states as cold (loaded/unknown are ready)", () => {
		expect(isColdState("loaded")).toBe(false);
		expect(isColdState("unknown")).toBe(false);
		expect(isColdState("sleeping")).toBe(true);
		expect(isColdState("loading")).toBe(true);
		expect(isColdState("unloaded")).toBe(true);
		expect(isColdState("downloading")).toBe(true);
	});
});

describe("reasoningControlUrl", () => {
	it("targets the control endpoint, tolerating a trailing slash", () => {
		expect(reasoningControlUrl("http://localhost:8080/v1")).toBe("http://localhost:8080/v1/chat/completions/control");
		expect(reasoningControlUrl("http://localhost:8080/v1/")).toBe("http://localhost:8080/v1/chat/completions/control");
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
