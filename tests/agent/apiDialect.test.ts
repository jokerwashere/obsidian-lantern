import { describe, it, expect } from "vitest";
import {
	detectDialect,
	isOpenAiReasoningModel,
	applyOpenAiDialect,
	stripMessageFields,
	parseParamRejection,
	applyLearnedFixes,
	ESSENTIAL_PARAMS,
	openAiContextTokens,
	OPENAI_MAX_COMPLETION_TOKENS,
} from "../../src/agent/apiDialect";

describe("detectDialect", () => {
	it("marks OpenAI's own hosts strict", () => {
		expect(detectDialect("https://api.openai.com/v1")).toBe("openai");
		expect(detectDialect("https://api.openai.com/v1/")).toBe("openai");
		expect(detectDialect("https://my-resource.openai.azure.com/openai/v1")).toBe("openai");
	});

	it("treats everything else as permissive (incl. junk URLs)", () => {
		expect(detectDialect("http://localhost:8080/v1")).toBe("compatible");
		expect(detectDialect("http://localhost:1234/v1")).toBe("compatible");
		expect(detectDialect("https://openrouter.ai/api/v1")).toBe("compatible");
		expect(detectDialect("not a url")).toBe("compatible");
		// Not fooled by a lookalike host.
		expect(detectDialect("https://api.openai.com.evil.test/v1")).toBe("compatible");
	});
});

describe("isOpenAiReasoningModel", () => {
	it("matches the o-series and gpt-5, not the chat models", () => {
		expect(isOpenAiReasoningModel("o1-mini")).toBe(true);
		expect(isOpenAiReasoningModel("o3")).toBe(true);
		expect(isOpenAiReasoningModel("o4-mini")).toBe(true);
		expect(isOpenAiReasoningModel("gpt-5.1")).toBe(true);
		expect(isOpenAiReasoningModel("gpt-4o")).toBe(false);
		expect(isOpenAiReasoningModel("gpt-4.1-mini")).toBe(false);
	});
});

describe("applyOpenAiDialect", () => {
	const base = () => ({
		model: "gpt-4o",
		messages: [{ role: "user", content: "q" }],
		temperature: 0.2,
		max_tokens: 4915,
		chat_template_kwargs: { enable_thinking: false },
		thinking_budget_tokens: 8192,
		reasoning_control: true,
	});

	it("strips the llama.cpp-only params that OpenAI 400s on", () => {
		const body: Record<string, unknown> = base();
		applyOpenAiDialect(body);
		expect(body.chat_template_kwargs).toBeUndefined();
		expect(body.thinking_budget_tokens).toBeUndefined();
		expect(body.reasoning_control).toBeUndefined();
	});

	it("renames max_tokens and clamps it to the completion cap", () => {
		const body: Record<string, unknown> = base();
		applyOpenAiDialect(body);
		expect(body.max_tokens).toBeUndefined();
		expect(body.max_completion_tokens).toBe(4915);

		const big: Record<string, unknown> = { ...base(), max_tokens: 24576 };
		applyOpenAiDialect(big);
		expect(big.max_completion_tokens).toBe(OPENAI_MAX_COMPLETION_TOKENS);
	});

	it("leaves the cap unclamped for reasoning models (it also pays for thinking)", () => {
		const body: Record<string, unknown> = { ...base(), model: "o3", max_tokens: 24576 };
		applyOpenAiDialect(body);
		expect(body.max_completion_tokens).toBe(24576);
	});

	it("keeps temperature for chat models, drops it for reasoning models", () => {
		const chat: Record<string, unknown> = base();
		applyOpenAiDialect(chat);
		expect(chat.temperature).toBe(0.2);

		const reasoning: Record<string, unknown> = { ...base(), model: "o3-mini" };
		applyOpenAiDialect(reasoning);
		expect(reasoning.temperature).toBeUndefined();
	});

	it("keeps a real reasoning_effort", () => {
		const on: Record<string, unknown> = { ...base(), reasoning_effort: "medium" };
		applyOpenAiDialect(on, "medium");
		expect(on.reasoning_effort).toBe("medium");
	});

	it("spells 'off' as reasoning_effort 'none' on reasoning models only", () => {
		// gpt-5.1+ rejects function tools unless the effort is explicitly "none".
		const reasoning: Record<string, unknown> = { ...base(), model: "gpt-5.6-luna" };
		applyOpenAiDialect(reasoning, "off");
		expect(reasoning.reasoning_effort).toBe("none");

		const chat: Record<string, unknown> = base(); // gpt-4o has no reasoning at all
		applyOpenAiDialect(chat, "off");
		expect(chat.reasoning_effort).toBeUndefined();
	});

	it("drops reasoning_content from messages without touching the caller's array", () => {
		const messages = [
			{ role: "user", content: "q" },
			{ role: "assistant", content: null, tool_calls: [], reasoning_content: "thinking…" },
		];
		const body: Record<string, unknown> = { ...base(), messages };
		applyOpenAiDialect(body);

		expect(body.messages).not.toBe(messages);
		expect((body.messages as Array<Record<string, unknown>>)[1].reasoning_content).toBeUndefined();
		expect((body.messages as Array<Record<string, unknown>>)[1].tool_calls).toEqual([]);
		expect(messages[1].reasoning_content).toBe("thinking…"); // caller's copy intact
	});
});

describe("stripMessageFields", () => {
	it("returns the input untouched when nothing matches", () => {
		const messages = [{ role: "user", content: "q" }];
		expect(stripMessageFields(messages, new Set(["reasoning_content"]))).toBe(messages);
		expect(stripMessageFields(messages, new Set())).toBe(messages);
		expect(stripMessageFields("not an array", new Set(["x"]))).toBe("not an array");
	});
});

describe("parseParamRejection", () => {
	it("reads the OpenAI unknown-parameter error (the chat_template_kwargs 400)", () => {
		const body = JSON.stringify({
			error: {
				message: "Unknown parameter: 'chat_template_kwargs'.",
				type: "invalid_request_error",
				param: "chat_template_kwargs",
				code: "unknown_parameter",
			},
		});
		expect(parseParamRejection(body)).toEqual({ param: "chat_template_kwargs", scope: "body" });
	});

	it("reads the suggested replacement from an unsupported-parameter error", () => {
		const body = JSON.stringify({
			error: {
				message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
				param: "max_tokens",
				code: "unsupported_parameter",
			},
		});
		expect(parseParamRejection(body)).toEqual({
			param: "max_tokens",
			scope: "body",
			replacement: "max_completion_tokens",
		});
	});

	it("reads an unsupported temperature value", () => {
		const body = JSON.stringify({
			error: {
				message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) is supported.",
				param: "temperature",
				code: "unsupported_value",
			},
		});
		expect(parseParamRejection(body)).toEqual({ param: "temperature", scope: "body" });
	});

	it("takes the top-level key for a nested body param, the leaf for a message field", () => {
		const nested = JSON.stringify({
			error: { message: "Unknown parameter.", param: "chat_template_kwargs.enable_thinking", code: "unknown_parameter" },
		});
		expect(parseParamRejection(nested)).toEqual({ param: "chat_template_kwargs", scope: "body" });

		const msg = JSON.stringify({
			error: { message: "Unknown parameter.", param: "messages[1].reasoning_content", code: "unknown_parameter" },
		});
		expect(parseParamRejection(msg)).toEqual({ param: "reasoning_content", scope: "message" });
	});

	it("falls back to the param named in the message when there's no param field", () => {
		const body = JSON.stringify({ error: { message: "Unrecognized request argument supplied: reasoning_effort" } });
		expect(parseParamRejection(body)).toEqual({ param: "reasoning_effort", scope: "body" });
	});

	it("reads a too-large completion cap", () => {
		const body = JSON.stringify({
			error: { message: "max_tokens is too large: 24576. This model supports at most 16384 completion tokens.", param: "max_tokens" },
		});
		expect(parseParamRejection(body)).toEqual({ param: "max_tokens", scope: "body" });
	});

	it("reads a prescribed VALUE (gpt-5.1+ function tools need reasoning_effort 'none')", () => {
		const body = JSON.stringify({
			error: {
				message:
					"Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
				type: "invalid_request_error",
				param: "reasoning_effort",
				code: null,
			},
		});
		expect(parseParamRejection(body)).toEqual({ param: "reasoning_effort", scope: "body", value: "none" });
	});

	it("refuses to read a value out of English prose", () => {
		// "set max_tokens to a value less than 4096" once yielded value "a", which
		// then stuck to the endpoint for the session and forced max_tokens="a"
		// into every later request. Only quoted, numeric or boolean literals count.
		const prose = (message: string, param: string) =>
			parseParamRejection(JSON.stringify({ error: { message, param } }))?.value;
		expect(prose("Please set max_tokens to a value less than 4096.", "max_tokens")).toBeUndefined();
		expect(prose("Set temperature to at most 1 for this model.", "temperature")).toBeUndefined();
		// Still reads a real literal.
		expect(prose("…or set reasoning_effort to 'none'.", "reasoning_effort")).toBe("none");
	});

	it("reads Anthropic's prose errors, which carry no param field at all", () => {
		// Both verified live against api.anthropic.com.
		const anthropic = (message: string) =>
			parseParamRejection(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
		expect(anthropic("`temperature` is deprecated for this model.")).toEqual({ param: "temperature", scope: "body" });
		expect(
			anthropic('"thinking.type.disabled" is not supported for this model. Thinking defaults to adaptive mode.')
		).toEqual({ param: "thinking", scope: "body" }); // fixed at its top level
		expect(anthropic("chat_template_kwargs: Extra inputs are not permitted")).toEqual({
			param: "chat_template_kwargs",
			scope: "body",
		});
	});

	it("coerces a prescribed literal to its JSON type", () => {
		const withValue = (message: string, param: string) =>
			parseParamRejection(JSON.stringify({ error: { message, param } }))?.value;
		expect(withValue("Please set stream to 'false' for this model.", "stream")).toBe(false);
		expect(withValue("Set n to 1 for this model.", "n")).toBe(1);
		// A suggestion about a DIFFERENT param is not applied to this one.
		expect(withValue("Unsupported parameter: 'top_k'. Set top_p to 0.9 instead.", "top_k")).toBeUndefined();
	});

	it("trusts error.param whatever the prose says — phrasing changes, structure doesn't", () => {
		const body = JSON.stringify({
			error: { message: "Some phrasing OpenAI hasn't used yet.", param: "reasoning_effort", code: null },
		});
		expect(parseParamRejection(body)).toEqual({ param: "reasoning_effort", scope: "body" });
	});

	it("returns null when nothing identifies a param", () => {
		expect(parseParamRejection("")).toBeNull();
		expect(parseParamRejection("<html>502 Bad Gateway</html>")).toBeNull();
		expect(
			parseParamRejection(
				JSON.stringify({ error: { message: "Incorrect API key provided: sk-xxx.", code: "invalid_api_key" } })
			)
		).toBeNull();
	});

	it("still names the param for errors only the CALLER can rule out", () => {
		// Fixability is the client's call (ESSENTIAL_PARAMS), not the parser's.
		expect(
			parseParamRejection(
				JSON.stringify({
					error: { message: "The model 'gpt-9' does not exist", param: "model", code: "model_not_found" },
				})
			)
		).toEqual({ param: "model", scope: "body" });
	});
});

describe("openAiContextTokens", () => {
	it("knows the legacy small windows — those ids are frozen and can't rot", () => {
		expect(openAiContextTokens("gpt-3.5-turbo")).toBe(16_385);
		expect(openAiContextTokens("gpt-3.5-turbo-0125")).toBe(16_385);
		expect(openAiContextTokens("gpt-4")).toBe(8_192);
		expect(openAiContextTokens("gpt-4-0613")).toBe(8_192);
		expect(openAiContextTokens("gpt-4-32k")).toBe(32_768);
	});

	it("does not mistake the modern 128k+ families for old gpt-4", () => {
		for (const id of ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-nano", "gpt-4-turbo", "gpt-4-turbo-2024-04-09"]) {
			expect({ id, ctx: openAiContextTokens(id) }).toEqual({ id, ctx: 128_000 });
		}
	});

	it("falls back conservatively for anything unrecognized", () => {
		// Under-reporting compacts sooner than needed; over-reporting would let
		// the prompt grow until the server rejects it.
		expect(openAiContextTokens("gpt-5.6-luna")).toBe(128_000);
		expect(openAiContextTokens("o3")).toBe(128_000);
		expect(openAiContextTokens("")).toBe(128_000);
	});
});

describe("ESSENTIAL_PARAMS", () => {
	it("protects the payload key of every wire format, and store", () => {
		// messages/input/system/instructions ARE the conversation — deleting one
		// can't fix a 400. `store` is different: dropping it would silently
		// re-enable OpenAI's 30-day retention of whatever we sent.
		for (const param of ["messages", "input", "instructions", "system", "model", "tools", "store"]) {
			expect(ESSENTIAL_PARAMS.has(param)).toBe(true);
		}
	});
});

describe("applyLearnedFixes", () => {
	it("renames before dropping, and strips learned message fields", () => {
		const body: Record<string, unknown> = {
			model: "m",
			messages: [{ role: "assistant", content: "a", reasoning_content: "t" }],
			max_tokens: 4096,
			temperature: 0.2,
			chat_template_kwargs: { enable_thinking: false },
		};
		applyLearnedFixes(body, {
			dropped: new Set(["chat_template_kwargs", "temperature"]),
			renamed: new Map([["max_tokens", "max_completion_tokens"]]),
			coerced: new Map(),
			messageFields: new Set(["reasoning_content"]),
		});
		expect(body).toMatchObject({ model: "m", max_completion_tokens: 4096 });
		expect(body.max_tokens).toBeUndefined();
		expect(body.temperature).toBeUndefined();
		expect(body.chat_template_kwargs).toBeUndefined();
		expect((body.messages as Array<Record<string, unknown>>)[0]).toEqual({ role: "assistant", content: "a" });
	});

	it("sets a prescribed value even for a param the body omits", () => {
		const body: Record<string, unknown> = { model: "gpt-5.6-luna", messages: [] };
		applyLearnedFixes(body, {
			dropped: new Set(),
			renamed: new Map(),
			coerced: new Map([["reasoning_effort", "none"]]),
			messageFields: new Set(),
		});
		expect(body.reasoning_effort).toBe("none");
	});

	it("lets a prescribed value outrank a drop of the same param", () => {
		const body: Record<string, unknown> = { model: "m", messages: [], reasoning_effort: "high" };
		applyLearnedFixes(body, {
			dropped: new Set(["reasoning_effort"]),
			renamed: new Map(),
			coerced: new Map([["reasoning_effort", "none"]]),
			messageFields: new Set(),
		});
		expect(body.reasoning_effort).toBe("none");
	});

	it("is a no-op when nothing was learned", () => {
		const body: Record<string, unknown> = { model: "m", messages: [], max_tokens: 10 };
		applyLearnedFixes(body, { dropped: new Set(), renamed: new Map(), coerced: new Map(), messageFields: new Set() });
		expect(body).toEqual({ model: "m", messages: [], max_tokens: 10 });
	});
});
