import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import { requestUrl } from "obsidian";
import {
	perplexitySearch,
	exaSearch,
	webLink,
	buildWebTools,
	parseMcpEnvelope,
	parseMcpResults,
} from "../../src/agent/webSearch";

const mockRequestUrl = vi.mocked(requestUrl);

describe("webLink", () => {
	it("builds a markdown link (never a wikilink), stripping brackets from the title", () => {
		expect(webLink("Rust [ownership]", "https://e.com/a")).toBe("[Rust ownership](https://e.com/a)");
		expect(webLink("", "https://e.com/a")).toBe("[https://e.com/a](https://e.com/a)");
	});
});

describe("perplexitySearch", () => {
	beforeEach(() => vi.clearAllMocks());

	it("POSTs /search with auth + params and returns results", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { results: [{ title: "T", url: "https://x", snippet: "s" }] },
		} as never);

		const out = await perplexitySearch("KEY", "quantum", { maxResults: 3, recency: "week", domains: ["arxiv.org"] });
		expect(out).toHaveLength(1);

		const call = mockRequestUrl.mock.calls[0][0] as { url: string; headers: Record<string, string>; body: string };
		expect(call.url).toBe("https://api.perplexity.ai/search");
		expect(call.headers["Authorization"]).toBe("Bearer KEY");
		const body = JSON.parse(call.body);
		expect(body.query).toBe("quantum");
		expect(body.max_results).toBe(3);
		expect(body.search_recency_filter).toBe("week");
		expect(body.search_domain_filter).toEqual(["arxiv.org"]);
	});

	it("clamps max_results to 1..20", async () => {
		mockRequestUrl.mockResolvedValue({ status: 200, json: { results: [] } } as never);
		await perplexitySearch("K", "q", { maxResults: 50 });
		expect(JSON.parse((mockRequestUrl.mock.calls[0][0] as { body: string }).body).max_results).toBe(20);
	});

	it("throws on a non-200", async () => {
		mockRequestUrl.mockResolvedValue({ status: 401, text: "unauthorized", json: undefined } as never);
		await expect(perplexitySearch("K", "q", { maxResults: 5 })).rejects.toThrow(/HTTP 401/);
	});
});

describe("exaSearch", () => {
	beforeEach(() => vi.clearAllMocks());

	it("with a key → POSTs api.exa.ai/search with x-api-key, text contents, domains + recency", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { results: [{ title: "E", url: "https://e/a", text: "body", publishedDate: "2026-02-02" }] },
		} as never);

		const out = await exaSearch("EXAKEY", "rust", { maxResults: 3, recency: "week", domains: ["arxiv.org"] });
		expect(out).toEqual([{ title: "E", url: "https://e/a", snippet: "body", date: "2026-02-02" }]);

		const call = mockRequestUrl.mock.calls[0][0] as { url: string; headers: Record<string, string>; body: string };
		expect(call.url).toBe("https://api.exa.ai/search");
		expect(call.headers["x-api-key"]).toBe("EXAKEY");
		expect(call.headers["Authorization"]).toBeUndefined();
		const body = JSON.parse(call.body);
		expect(body.query).toBe("rust");
		expect(body.numResults).toBe(3);
		expect(body.contents.text.maxCharacters).toBe(2000);
		expect(body.includeDomains).toEqual(["arxiv.org"]);
		expect(typeof body.startPublishedDate).toBe("string"); // recency → published-date floor
	});

	it("without a key → calls the keyless MCP endpoint (tools/call web_search_exa), parsing the JSON-RPC result", async () => {
		const mcp = {
			jsonrpc: "2.0",
			id: 1,
			result: { content: [{ type: "text", text: JSON.stringify({ results: [{ title: "M", url: "https://m", text: "snip" }] }) }] },
		};
		mockRequestUrl.mockResolvedValue({ status: 200, text: `data: ${JSON.stringify(mcp)}\n\n`, json: undefined } as never);

		const out = await exaSearch("", "rust", { maxResults: 2 });
		expect(out).toEqual([{ title: "M", url: "https://m", snippet: "snip", date: undefined }]);

		const call = mockRequestUrl.mock.calls[0][0] as { url: string; headers: Record<string, string>; body: string };
		expect(call.url).toBe("https://mcp.exa.ai/mcp");
		expect(call.headers["Accept"]).toContain("text/event-stream");
		const body = JSON.parse(call.body);
		expect(body.method).toBe("tools/call");
		expect(body.params.name).toBe("web_search_exa");
		expect(body.params.arguments).toMatchObject({ query: "rust", numResults: 2, type: "auto", livecrawl: "fallback" });
	});

	it("throws on a non-200 (both keyed and keyless)", async () => {
		mockRequestUrl.mockResolvedValue({ status: 401, text: "nope", json: undefined } as never);
		await expect(exaSearch("K", "q", { maxResults: 5 })).rejects.toThrow(/Exa HTTP 401/);
		mockRequestUrl.mockResolvedValue({ status: 500, text: "down", json: undefined } as never);
		await expect(exaSearch("", "q", { maxResults: 5 })).rejects.toThrow(/Exa MCP HTTP 500/);
	});
});

describe("parseMcpEnvelope", () => {
	it("extracts the JSON-RPC object from an SSE `data:` frame", () => {
		const env = parseMcpEnvelope('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n');
		expect(env?.result).toEqual({ ok: true });
	});
	it("falls back to plain JSON, and returns null on garbage", () => {
		expect(parseMcpEnvelope('{"result":{"ok":1}}')?.result).toEqual({ ok: 1 });
		expect(parseMcpEnvelope("not json")).toBeNull();
	});
});

describe("parseMcpResults", () => {
	it("parses a JSON results array", () => {
		expect(parseMcpResults(JSON.stringify({ results: [{ title: "A", url: "https://a", text: "t" }] }))).toEqual([
			{ title: "A", url: "https://a", snippet: "t", date: undefined },
		]);
	});
	it("maps highlights to the snippet when a JSON result has no text", () => {
		expect(parseMcpResults(JSON.stringify({ results: [{ title: "H", url: "https://h", highlights: ["a", "b"] }] }))).toEqual([
			{ title: "H", url: "https://h", snippet: "a … b", date: undefined },
		]);
	});
	it("falls back to Title:/URL:/Text: text blocks and drops records with no URL", () => {
		const text = "Title: One\nURL: https://one\nText: hello\nTitle: Ghost\nText: no url here";
		expect(parseMcpResults(text)).toEqual([{ title: "One", url: "https://one", snippet: "hello", date: undefined }]);
	});
	it("keeps multi-line / multi-paragraph Text whole and reads 'Published Date:' and multiple records", () => {
		const text = [
			"Title: One",
			"URL: https://one",
			"Published Date: 2026-01-01",
			"Text: para one line one",
			"para one line two",
			"",
			"para two",
			"Title: Two",
			"URL: https://two",
			"Highlights: hi there",
		].join("\n");
		expect(parseMcpResults(text)).toEqual([
			{ title: "One", url: "https://one", snippet: "para one line one\npara one line two\n\npara two", date: "2026-01-01" },
			{ title: "Two", url: "https://two", snippet: "hi there", date: undefined },
		]);
	});
});

describe("buildWebTools.web_search", () => {
	beforeEach(() => vi.clearAllMocks());
	const tool = () => buildWebTools({ provider: "perplexity", apiKey: "K", maxResults: 5 }).web_search;

	it("returns JSON with a ready-to-cite markdown link per result", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { results: [{ title: "Doc", url: "https://x/a", snippet: "hello", date: "2026-01-01" }] },
		} as never);

		const parsed = JSON.parse(await tool().execute({ query: "q" }));
		expect(parsed.results[0]).toMatchObject({
			title: "Doc",
			url: "https://x/a",
			date: "2026-01-01",
			link: "[Doc](https://x/a)",
		});
	});

	it("routes to Exa when the provider is exa", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			json: { results: [{ title: "E", url: "https://e", text: "body" }] },
		} as never);
		const exaTool = buildWebTools({ provider: "exa", apiKey: "K", maxResults: 5 }).web_search;
		const parsed = JSON.parse(await exaTool.execute({ query: "q" }));
		expect((mockRequestUrl.mock.calls[0][0] as { url: string }).url).toBe("https://api.exa.ai/search");
		expect(parsed.results[0]).toMatchObject({ title: "E", url: "https://e", snippet: "body", link: "[E](https://e)" });
	});

	it("errors without a query, and reports a failed request", async () => {
		expect(await tool().execute({})).toMatch(/requires a non-empty 'query'/);
		mockRequestUrl.mockResolvedValue({ status: 500, text: "boom", json: undefined } as never);
		expect(await tool().execute({ query: "q" })).toMatch(/web search failed/);
	});
});
