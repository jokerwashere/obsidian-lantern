/**
 * Streaming transport tests against a REAL local http server (no transport
 * mocks) — the server speaks the exact SSE dialect captured from llama-server.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import type { AddressInfo } from "net";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import { requestUrl } from "obsidian";
import { LlmClient, isAbortError } from "../../src/agent/LlmClient";

const mockRequestUrl = vi.mocked(requestUrl);

type Behavior = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server;
let port = 0;
let behavior: Behavior = () => {};

function sse(res: ServerResponse, payloads: unknown[]): void {
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	for (const p of payloads) res.write(`data: ${JSON.stringify(p)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
}

const delta = (d: Record<string, unknown>) => ({ choices: [{ delta: d, finish_reason: null }] });

beforeAll(async () => {
	server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => behavior(req, res, body));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
	vi.clearAllMocks();
});

function makeClient(extra: Record<string, unknown> = {}): LlmClient {
	// Explicit model: bypasses /v1/models auto-resolution so the per-test
	// requestUrl call-count assertions stay exact.
	return new LlmClient({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "m", ...extra });
}

describe("LlmClient streaming", () => {
	it("streams content deltas and resolves the accumulated result", async () => {
		behavior = (_req, res, body) => {
			expect(JSON.parse(body).stream).toBe(true);
			sse(res, [
				delta({ role: "assistant", content: null }),
				delta({ content: "Hel" }),
				delta({ content: "lo" }),
				{ choices: [{ delta: {}, finish_reason: "stop" }] },
			]);
		};

		const deltas: string[] = [];
		const res = await makeClient().chat([{ role: "user", content: "q" }], undefined, {
			onDelta: (d) => d.content && deltas.push(d.content),
		});

		expect(deltas).toEqual(["Hel", "lo"]);
		expect(res.content).toBe("Hello");
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});

	it("accumulates streamed tool calls and forwards reasoning separately", async () => {
		behavior = (_req, res) =>
			sse(res, [
				delta({ reasoning_content: "Pondering" }),
				delta({ tool_calls: [{ index: 0, id: "X1", type: "function", function: { name: "search_vault", arguments: "{\"qu" } }] }),
				delta({ tool_calls: [{ index: 0, function: { arguments: 'ery":"a"}' } }] }),
				{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
			]);

		const reasoning: string[] = [];
		const res = await makeClient().chat([{ role: "user", content: "q" }], undefined, {
			onDelta: (d) => d.reasoning && reasoning.push(d.reasoning),
		});

		expect(reasoning).toEqual(["Pondering"]);
		expect(res.toolCalls).toEqual([
			{ id: "X1", type: "function", function: { name: "search_vault", arguments: '{"query":"a"}' } },
		]);
	});

	it("rejects with AbortError when the signal fires mid-stream", async () => {
		behavior = (_req, res) => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(`data: ${JSON.stringify(delta({ content: "start" }))}\n\n`);
			// …then never finish; the client aborts.
		};

		const controller = new AbortController();
		const promise = makeClient().chat([{ role: "user", content: "q" }], undefined, {
			signal: controller.signal,
			onDelta: (d) => d.content && controller.abort(),
		});

		await expect(promise).rejects.toSatisfy(isAbortError);
	});

	it("falls back to non-streaming when the server rejects the stream but accepts plain, then sticks", async () => {
		let streamRequests = 0;
		behavior = (_req, res, body) => {
			if (JSON.parse(body).stream) {
				streamRequests++;
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { message: "Cannot use tools with stream" } }));
			}
		};
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { choices: [{ message: { content: "plain answer" } }] },
		} as never);

		const client = makeClient();
		const first = await client.chat([{ role: "user", content: "q" }], undefined, { onDelta: () => {} });
		expect(first.content).toBe("plain answer");
		expect(streamRequests).toBe(1);
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);

		// Second call: streaming is sticky-disabled — straight to plain.
		await client.chat([{ role: "user", content: "q2" }], undefined, { onDelta: () => {} });
		expect(streamRequests).toBe(1);
		expect(mockRequestUrl).toHaveBeenCalledTimes(2);
	});

	it("does NOT disable streaming when the plain retry also fails", async () => {
		behavior = (_req, res) => {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { message: "context overflow" } }));
		};
		mockRequestUrl.mockResolvedValue({ status: 400, text: "context overflow", json: undefined } as never);

		const client = makeClient();
		await expect(
			client.chat([{ role: "user", content: "q" }], undefined, { onDelta: () => {} })
		).rejects.toThrow(/HTTP 400/);

		// Streaming must be attempted again next time (not sticky-disabled).
		let streamed = false;
		behavior = (_req, res, body) => {
			streamed = JSON.parse(body).stream === true;
			sse(res, [delta({ content: "ok" })]);
		};
		const res = await client.chat([{ role: "user", content: "q" }], undefined, { onDelta: () => {} });
		expect(streamed).toBe(true);
		expect(res.content).toBe("ok");
	});

	it("surfaces connection failures without falling back", async () => {
		const client = new LlmClient({ baseUrl: "http://127.0.0.1:1/v1", model: "m" }); // nothing listens on port 1
		await expect(
			client.chat([{ role: "user", content: "q" }], undefined, { onDelta: () => {} })
		).rejects.toThrow();
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});

	it("aborts a stalled stream via the idle timeout", async () => {
		behavior = (_req, res) => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(`data: ${JSON.stringify(delta({ content: "then silence" }))}\n\n`);
			// stall forever
		};
		const client = makeClient({ idleTimeoutMs: 120 });
		await expect(
			client.chat([{ role: "user", content: "q" }], undefined, { onDelta: () => {} })
		).rejects.toThrow(/stalled/);
	});

	it("prefers the RESIDENT model when auto-resolving (no model swap)", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: {
				data: [{ id: "default" }, { id: "warm-35b" }, { id: "cold-9b" }],
				models: [{ name: "warm-35b" }], // ollama-style resident list
			},
		} as never);
		let sentModel = "";
		behavior = (_req, res, body) => {
			sentModel = JSON.parse(body).model;
			sse(res, [delta({ content: "ok" })]);
		};

		const client = new LlmClient({ baseUrl: `http://127.0.0.1:${port}/v1` });
		await client.chat([{ role: "user", content: "q" }], undefined, { onDelta: () => {} });
		expect(sentModel).toBe("warm-35b");
	});

	it("fails fast with settings guidance when a router serves many models and none is resident", async () => {
		// Grounded live: a blind pick ("default") silently triggered a
		// multi-minute cold model load — guidance beats a wedged chat.
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { data: [{ id: "default" }, { id: "big-model" }, { id: "small" }], models: [] },
		} as never);
		let socketTouched = false;
		behavior = () => {
			socketTouched = true;
		};

		const client = new LlmClient({ baseUrl: `http://127.0.0.1:${port}/v1` }); // no model
		await expect(
			client.chat([{ role: "user", content: "q" }], undefined, { onDelta: () => {} })
		).rejects.toThrow(/pick one in Lantern settings/i);
		expect(socketTouched).toBe(false); // no request fired before the guidance
	});

	it("memoizes the resident-model resolution after one lookup", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { data: [{ id: "a" }, { id: "b" }], models: [{ name: "a" }] },
		} as never);
		behavior = (_req, res) => sse(res, [delta({ content: "ok" })]);

		const client = new LlmClient({ baseUrl: `http://127.0.0.1:${port}/v1` });
		await client.chat([{ role: "user", content: "q" }], undefined, { onDelta: () => {} });
		await client.chat([{ role: "user", content: "q2" }], undefined, { onDelta: () => {} });
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
	});

	it("falls back to the first served id, then to the legacy placeholder", async () => {
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: { data: [{ id: "qwen-only" }] },
		} as never);
		let sentModel = "";
		behavior = (_req, res, body) => {
			sentModel = JSON.parse(body).model;
			sse(res, [delta({ content: "ok" })]);
		};

		await new LlmClient({ baseUrl: `http://127.0.0.1:${port}/v1` }).chat(
			[{ role: "user", content: "q" }],
			undefined,
			{ onDelta: () => {} }
		);
		expect(sentModel).toBe("qwen-only");

		mockRequestUrl.mockRejectedValueOnce(new Error("down"));
		await new LlmClient({ baseUrl: `http://127.0.0.1:${port}/v1` }).chat(
			[{ role: "user", content: "q" }],
			undefined,
			{ onDelta: () => {} }
		);
		expect(sentModel).toBe("local-model");
	});

	it("per-call reasoningEffort override beats the configured effort", async () => {
		let kwargs: Record<string, unknown> | undefined;
		behavior = (_req, res, body) => {
			kwargs = JSON.parse(body).chat_template_kwargs;
			sse(res, [delta({ content: "ok" })]);
		};

		const client = makeClient({ reasoningEffort: "medium" });
		await client.chat([{ role: "user", content: "q" }], undefined, {
			onDelta: () => {},
			reasoningEffort: "off",
		});
		expect(kwargs).toEqual({ enable_thinking: false });
	});

	it("plain calls (no callbacks) keep using requestUrl and never touch the socket", async () => {
		let socketTouched = false;
		behavior = () => {
			socketTouched = true;
		};
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { choices: [{ message: { content: "ok" } }] },
		} as never);

		const res = await makeClient().chat([{ role: "user", content: "q" }]);
		expect(res.content).toBe("ok");
		expect(socketTouched).toBe(false);
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
	});
});
