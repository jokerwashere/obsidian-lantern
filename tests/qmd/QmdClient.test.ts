import { describe, it, expect, vi, beforeEach } from "vitest";

// QmdClient imports requestUrl from "obsidian" and spawn from "child_process".
vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));
vi.mock("child_process", () => ({ spawn: vi.fn() }));

import { requestUrl } from "obsidian";
import {
	QmdClient,
	buildQueryBody,
	balanceQuotes,
	mapResult,
	cleanSnippet,
	type RawQmdResult,
} from "../../src/qmd/QmdClient";

const mockRequestUrl = vi.mocked(requestUrl);

describe("buildQueryBody", () => {
	it("sends lexical + vector sub-queries for hybrid (default)", () => {
		const body = buildQueryBody("webhooks", {});
		expect(body.searches).toEqual([
			{ type: "lex", query: "webhooks" },
			{ type: "vec", query: "webhooks" },
		]);
		expect(body.limit).toBe(10);
		expect(body.minScore).toBe(0);
	});

	it("uses distinct lex keywords when `lex` is set, keeping query as the vec signal", () => {
		const body = buildQueryBody("how leadership decisions get made", { lex: "OKR cockpit Goodhart" });
		expect(body.searches).toEqual([
			{ type: "lex", query: "OKR cockpit Goodhart" },
			{ type: "vec", query: "how leadership decisions get made" },
		]);
	});

	it("falls back to the query for lex when `lex` is blank, and balances quotes in lex", () => {
		expect(buildQueryBody("webhooks", { lex: "   " }).searches).toEqual([
			{ type: "lex", query: "webhooks" },
			{ type: "vec", query: "webhooks" },
		]);
		const balanced = buildQueryBody("concept", { lex: 'broken "' }) as {
			searches: Array<{ type: string; query: string }>;
		};
		expect(balanced.searches.find((s) => s.type === "lex")?.query).toBe("broken");
		expect(balanced.searches.find((s) => s.type === "vec")?.query).toBe("concept");
	});

	it("sends lexical-only in text mode", () => {
		const body = buildQueryBody("webhooks", { mode: "text" });
		expect(body.searches).toEqual([{ type: "lex", query: "webhooks" }]);
	});

	it("sends vector-only in vector mode", () => {
		const body = buildQueryBody("webhooks", { mode: "vector" });
		expect(body.searches).toEqual([{ type: "vec", query: "webhooks" }]);
	});

	it("includes collections, intent, rerank and limits when provided", () => {
		const body = buildQueryBody("q", {
			collections: ["vault"],
			limit: 5,
			minScore: 0.3,
			intent: "swift ui",
			rerank: false,
		});
		expect(body.collections).toEqual(["vault"]);
		expect(body.limit).toBe(5);
		expect(body.minScore).toBe(0.3);
		expect(body.intent).toBe("swift ui");
		expect(body.rerank).toBe(false);
	});

	it("omits collections when empty", () => {
		const body = buildQueryBody("q", { collections: [] });
		expect(body.collections).toBeUndefined();
	});

	it("anyOf becomes one lex sub-query per alternative, OR-ed via fusion", () => {
		// First lex sub-query gets qmd's 2× RRF weight, so alternatives lead and
		// the concept query stays as the (semantic) vec list.
		const body = buildQueryBody("IT people", {
			anyOf: ["IT director", "engineer", "developer"],
		});
		expect(body.searches).toEqual([
			{ type: "lex", query: "IT director" },
			{ type: "lex", query: "engineer" },
			{ type: "lex", query: "developer" },
			{ type: "vec", query: "IT people" },
		]);
	});

	it("anyOf in text mode keeps the concept as a trailing lex list", () => {
		const body = buildQueryBody("IT people", { mode: "text", anyOf: ["engineer", "developer"] });
		expect(body.searches).toEqual([
			{ type: "lex", query: "engineer" },
			{ type: "lex", query: "developer" },
			{ type: "lex", query: "IT people" },
		]);
	});

	it("anyOf trims blanks and caps at MAX_ANY_OF", () => {
		const many = Array.from({ length: 12 }, (_, i) => `term${i}`);
		const body = buildQueryBody("q", { mode: "vector", anyOf: ["  ", ...many] });
		const lex = (body.searches as Array<{ type: string }>).filter((s) => s.type === "lex");
		expect(lex).toHaveLength(8); // MAX_ANY_OF, blank dropped
	});

	it("balances odd quotes in lex sub-queries (qmd 500s otherwise) but leaves vec raw", () => {
		const body = buildQueryBody('just "', {}) as { searches: Array<{ type: string; query: string }> };
		const lex = body.searches.find((s) => s.type === "lex");
		const vec = body.searches.find((s) => s.type === "vec");
		expect(lex?.query).toBe("just"); // unmatched quote dropped + trimmed
		expect(vec?.query).toBe('just "'); // vec embeds the raw text
	});

	it("keeps balanced quotes intact and balances anyOf lex terms", () => {
		expect(balanceQuotes('"webhook secret"')).toBe('"webhook secret"');
		expect(balanceQuotes('a "b" "c')).toBe('a "b" c');
		const body = buildQueryBody("x", { mode: "text", anyOf: ['eng"', "dev"] }) as {
			searches: Array<{ type: string; query: string }>;
		};
		expect(body.searches.map((s) => s.query)).toEqual(["eng", "dev", "x"]);
	});
});

describe("mapResult", () => {
	it("splits the file field into collection and path", () => {
		const raw: RawQmdResult = {
			docid: "#abc",
			file: "my-vault/Notes/Foo.md",
			title: "Foo",
			score: 0.9,
			line: 12,
			snippet: "hello",
			context: null,
		};
		const result = mapResult(raw);
		expect(result.collection).toBe("my-vault");
		expect(result.path).toBe("Notes/Foo.md");
		expect(result.line).toBe(12);
		expect(result.docid).toBe("#abc");
	});

	it("strips the qmd:// scheme and URL-decodes the literal path (fixed qmd)", () => {
		const result = mapResult({
			docid: "#c0e5cd",
			file: "qmd://my-vault/Projects/Planning%202025/Acme%20Corp%20-%20Vendor%20Review.md",
			title: "Vendor review",
			score: 0.93,
			line: 2,
			snippet: "",
			context: null,
		});
		expect(result.collection).toBe("my-vault");
		expect(result.path).toBe("Projects/Planning 2025/Acme Corp - Vendor Review.md");
	});

	it("handles a file with no collection prefix", () => {
		const result = mapResult({
			docid: "#x",
			file: "toplevel.md",
			title: "T",
			score: 1,
			line: 1,
			snippet: "",
			context: null,
		});
		expect(result.collection).toBe("");
		expect(result.path).toBe("toplevel.md");
	});
});

describe("cleanSnippet", () => {
	it("strips line-number prefixes and diff-hunk headers", () => {
		const raw =
			"3: @@ -2,4 @@ (1 before, 721 after)\n4: \n5: The service can send outbound webhooks.";
		expect(cleanSnippet(raw)).toBe("The service can send outbound webhooks.");
	});

	it("returns plain text unchanged", () => {
		expect(cleanSnippet("just a snippet")).toBe("just a snippet");
	});
});

describe("QmdClient", () => {
	const client = new QmdClient({ port: 8181, binaryPath: "qmd" });

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("isRunning", () => {
		it("returns true when /health reports ok", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 200,
				json: { status: "ok", uptime: 3 },
			} as never);
			expect(await client.isRunning()).toBe(true);
			expect(mockRequestUrl).toHaveBeenCalledWith(
				expect.objectContaining({ url: "http://localhost:8181/health", method: "GET" })
			);
		});

		it("returns false on a non-200 response", async () => {
			mockRequestUrl.mockResolvedValue({ status: 503, json: undefined } as never);
			expect(await client.isRunning()).toBe(false);
		});

		it("returns false when the request throws (daemon down)", async () => {
			mockRequestUrl.mockRejectedValue(new Error("ECONNREFUSED"));
			expect(await client.isRunning()).toBe(false);
		});
	});

	describe("query", () => {
		it("returns [] for an empty query without hitting the network", async () => {
			expect(await client.query("   ")).toEqual([]);
			expect(mockRequestUrl).not.toHaveBeenCalled();
		});

		it("POSTs to /query and maps the results", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 200,
				json: {
					results: [
						{
							docid: "#7fa9f7",
							file: "vault/usage/webhooks.md",
							title: "Webhooks",
							score: 0.93,
							line: 3,
							snippet: "3: @@ -2,4 @@ (1 before)\n4: The service sends webhooks.",
							context: null,
						},
					],
				},
			} as never);

			const results = await client.query("webhooks", { collections: ["vault"], limit: 5 });

			expect(results).toHaveLength(1);
			expect(results[0].path).toBe("usage/webhooks.md");
			expect(results[0].collection).toBe("vault");
			expect(results[0].snippet).toBe("The service sends webhooks.");

			const call = mockRequestUrl.mock.calls[0][0] as { url: string; method: string; body: string };
			expect(call.url).toBe("http://localhost:8181/query");
			expect(call.method).toBe("POST");
			const sentBody = JSON.parse(call.body);
			expect(sentBody.collections).toEqual(["vault"]);
			expect(sentBody.searches).toHaveLength(2);
		});

		it("throws a descriptive error on a non-200 response", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 400,
				text: "Missing required field: searches",
				json: undefined,
			} as never);
			await expect(client.query("x")).rejects.toThrow(/HTTP 400/);
		});

		it("tolerates a missing results array", async () => {
			mockRequestUrl.mockResolvedValue({ status: 200, json: {} } as never);
			expect(await client.query("x")).toEqual([]);
		});

		it("gives a clear error when the daemon is unreachable", async () => {
			mockRequestUrl.mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED"));
			await expect(client.query("x")).rejects.toThrow(/not reachable.*binary path/s);
		});
	});
});
