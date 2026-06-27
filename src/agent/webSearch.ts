/**
 * Web search (gated, opt-in). Returns relevant web *sources* (title / url /
 * snippet) for the LOCAL model to read and cite — retrieval only, the synthesis
 * stays local. Two providers:
 *
 *  - **Perplexity** Search API — POST /search, Bearer key (REQUIRED).
 *  - **Exa** — POST /search with an `x-api-key`, and a KEYLESS fallback via Exa's
 *    free MCP endpoint when no key is set (so the Exa API key is OPTIONAL).
 *
 * Sending the query leaves the machine, so the tool is OFF by default and absent
 * from the registry unless enabled (and, for Perplexity, a key is set).
 *
 * Search only — never web *fetching*: the tool returns search results; it never
 * retrieves a page's full contents (Exa's /contents and /answer are not used).
 *
 * Billing note (Perplexity): a Pro subscription is NOT API access — it grants a
 * recurring $5/month API credit, then pay-as-you-go (a separate API key).
 */

import { requestUrl } from "obsidian";
import type { AgentTool } from "./tools";

export type WebSearchProvider = "perplexity" | "exa";

export interface WebSearchOptions {
	provider: WebSearchProvider;
	/** Provider API key. Required for Perplexity; OPTIONAL for Exa (keyless MCP fallback). */
	apiKey: string;
	/** Results requested per call (1–20). */
	maxResults: number;
}

/** A normalised web source for the model to cite (title / url / snippet / date). */
export interface WebResult {
	title?: string;
	url?: string;
	snippet?: string;
	date?: string;
}

interface SearchParams {
	maxResults: number;
	recency?: string;
	domains?: string[];
}

const PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const RECENCY = ["hour", "day", "week", "month", "year"];

/** Recency window → milliseconds, for providers that filter by published date (Exa). */
const RECENCY_MS: Record<string, number> = {
	hour: 3_600_000,
	day: 86_400_000,
	week: 604_800_000,
	month: 2_592_000_000, // 30d
	year: 31_536_000_000, // 365d
};

const clampResults = (n: number): number => Math.min(Math.max(n, 1), 20);

/** Ready-to-cite markdown link for a web source (never a [[wikilink]]). */
export function webLink(title: string | undefined, url: string): string {
	const text = (title && title.trim() ? title.trim() : url).replace(/[[\]]/g, "");
	return `[${text}](${url})`;
}

// ----------------------------------------------------------------- Perplexity

interface PerplexityRaw {
	title?: string;
	url?: string;
	snippet?: string;
	date?: string;
	last_updated?: string;
}

const mapPerplexity = (r: PerplexityRaw): WebResult => ({
	title: r.title,
	url: r.url,
	snippet: r.snippet,
	date: r.date ?? r.last_updated,
});

/** POST Perplexity /search; returns normalised results (throws on a non-200). */
export async function perplexitySearch(apiKey: string, query: string, opts: SearchParams): Promise<WebResult[]> {
	const body: Record<string, unknown> = {
		query,
		max_results: clampResults(opts.maxResults),
		// "high" pulls richer per-result content so the model can answer from the
		// snippet without "reading" the page (costs more than medium).
		search_context_size: "high",
	};
	if (opts.recency) body.search_recency_filter = opts.recency;
	if (opts.domains && opts.domains.length > 0) body.search_domain_filter = opts.domains.slice(0, 20);

	const res = await requestUrl({
		url: PERPLEXITY_SEARCH_URL,
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify(body),
		throw: false,
	});
	if (res.status !== 200) throw new Error(`Perplexity HTTP ${res.status}: ${(res.text ?? "").slice(0, 200)}`);
	const results = (res.json as { results?: PerplexityRaw[] })?.results;
	return Array.isArray(results) ? results.map(mapPerplexity) : [];
}

// ------------------------------------------------------------------------ Exa

interface ExaRaw {
	title?: string;
	url?: string;
	text?: string;
	highlights?: string[];
	publishedDate?: string;
}

const mapExa = (r: ExaRaw): WebResult => ({
	title: r.title,
	url: r.url,
	snippet: r.text?.trim() ? r.text : r.highlights?.length ? r.highlights.join(" … ") : undefined,
	date: r.publishedDate,
});

/** Exa search. With a key → direct REST /search; without → the keyless free MCP endpoint. */
export async function exaSearch(apiKey: string, query: string, opts: SearchParams): Promise<WebResult[]> {
	return apiKey ? exaRestSearch(apiKey, query, opts) : exaMcpSearch(query, opts);
}

async function exaRestSearch(apiKey: string, query: string, opts: SearchParams): Promise<WebResult[]> {
	const body: Record<string, unknown> = {
		query,
		type: "auto",
		numResults: clampResults(opts.maxResults),
		// Ask for page text inline — that becomes the citable snippet (no separate
		// /contents fetch). Capped so a result stays compact for a local model.
		contents: { text: { maxCharacters: 2000 } },
	};
	if (opts.domains && opts.domains.length > 0) body.includeDomains = opts.domains.slice(0, 20);
	if (opts.recency && RECENCY_MS[opts.recency]) {
		body.startPublishedDate = new Date(Date.now() - RECENCY_MS[opts.recency]).toISOString();
	}

	const res = await requestUrl({
		url: EXA_SEARCH_URL,
		method: "POST",
		headers: { "Content-Type": "application/json", "x-api-key": apiKey },
		body: JSON.stringify(body),
		throw: false,
	});
	if (res.status !== 200) throw new Error(`Exa HTTP ${res.status}: ${(res.text ?? "").slice(0, 200)}`);
	const results = (res.json as { results?: ExaRaw[] })?.results;
	return Array.isArray(results) ? results.map(mapExa) : [];
}

/**
 * Keyless Exa search via the free MCP endpoint: a single `tools/call` to
 * `web_search_exa` (the server accepts it without an MCP initialize handshake).
 * The response is SSE or plain JSON; we read the JSON-RPC result's content
 * blocks, which carry the Exa results (JSON, or "Title:/URL:/Text:" text).
 */
async function exaMcpSearch(query: string, opts: SearchParams): Promise<WebResult[]> {
	const body = {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params: {
			name: "web_search_exa",
			arguments: { query, numResults: clampResults(opts.maxResults), type: "auto", livecrawl: "fallback" },
		},
	};
	const res = await requestUrl({
		url: EXA_MCP_URL,
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
		body: JSON.stringify(body),
		throw: false,
	});
	if (res.status !== 200) throw new Error(`Exa MCP HTTP ${res.status}: ${(res.text ?? "").slice(0, 200)}`);

	const rpc = parseMcpEnvelope(res.text ?? "");
	const content = (rpc?.result as { content?: Array<{ text?: string }> } | undefined)?.content;
	if (!Array.isArray(content)) return [];
	const out: WebResult[] = [];
	for (const block of content) {
		if (typeof block?.text === "string") out.push(...parseMcpResults(block.text));
	}
	return out;
}

/** Pull the JSON-RPC object out of an MCP response (SSE `data:` frames, else plain JSON). */
export function parseMcpEnvelope(text: string): { result?: unknown; error?: unknown } | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	if (trimmed.includes("data:")) {
		// SSE: take the last `data:` frame that parses with a result/error.
		let found: { result?: unknown; error?: unknown } | null = null;
		for (const line of trimmed.split(/\r?\n/)) {
			const m = line.match(/^data:\s*(.*)$/);
			if (!m) continue;
			try {
				const obj = JSON.parse(m[1]) as { result?: unknown; error?: unknown };
				if (obj && (obj.result !== undefined || obj.error !== undefined)) found = obj;
			} catch {
				/* skip non-JSON frames (comments, keep-alives) */
			}
		}
		if (found) return found;
	}
	try {
		return JSON.parse(trimmed) as { result?: unknown; error?: unknown };
	} catch {
		return null;
	}
}

/** Known field labels in Exa's text-format content blocks (value may span lines). */
const MCP_FIELD = /^(Title|URL|Author|Score|Published Date|PublishedDate|Published|Text|Highlights|Summary):\s*(.*)$/;

/** A `web_search_exa` content block: JSON ({results:[…]} or […]) or "Title:/URL:/Text:" text. */
export function parseMcpResults(text: string): WebResult[] {
	try {
		const obj = JSON.parse(text) as { results?: ExaRaw[] } | ExaRaw[];
		const results = Array.isArray(obj) ? obj : obj?.results;
		if (Array.isArray(results)) return results.map(mapExa).filter((r) => r.url);
	} catch {
		/* not JSON → parse the line-oriented text format below */
	}

	// Fallback: "Field: value" lines. A field's value runs until the next known
	// label, so multi-line / multi-paragraph Text bodies are kept whole; a new
	// record begins at a Title (or a repeated URL).
	const out: WebResult[] = [];
	let rec: Record<string, string> = {};
	let field: string | null = null;
	const flush = () => {
		const url = rec["URL"]?.trim();
		if (url) {
			out.push({
				title: rec["Title"]?.trim() || undefined,
				url,
				snippet: (rec["Text"] ?? rec["Highlights"])?.trim() || undefined,
				date: (rec["Published Date"] ?? rec["PublishedDate"] ?? rec["Published"])?.trim() || undefined,
			});
		}
		rec = {};
	};
	for (const line of text.split(/\r?\n/)) {
		const m = line.match(MCP_FIELD);
		if (m) {
			if (m[1] === "Title" || (m[1] === "URL" && rec["URL"] !== undefined)) flush();
			field = m[1];
			rec[field] = m[2];
		} else if (field !== null) {
			rec[field] += "\n" + line; // continuation of a multi-line value
		}
	}
	flush();
	return out;
}

// ------------------------------------------------------------------- dispatch

/** Run the configured provider; returns normalised web sources for the model to cite. */
export async function webSearch(
	opts: WebSearchOptions,
	query: string,
	params: { recency?: string; domains?: string[] }
): Promise<WebResult[]> {
	const p: SearchParams = { maxResults: opts.maxResults, recency: params.recency, domains: params.domains };
	return opts.provider === "exa" ? exaSearch(opts.apiKey, query, p) : perplexitySearch(opts.apiKey, query, p);
}

export function buildWebTools(opts: WebSearchOptions): Record<string, AgentTool> {
	return {
		web_search: {
			def: {
				type: "function",
				function: {
					name: "web_search",
					description:
						"Search the public web for current or external information not in the vault. " +
						"Returns JSON results [{title, url, snippet, date, link}] — each snippet already carries the relevant content, so you do NOT need to open or read the page. Search the vault first; use this only when the answer needs up-to-date or outside info. Cite a result by pasting its 'link' as a footnote.",
					parameters: {
						type: "object",
						properties: {
							query: { type: "string", description: "What to look up on the web." },
							recency: {
								type: "string",
								enum: RECENCY,
								description: "Limit to the last hour/day/week/month/year (optional).",
							},
							domains: {
								type: "array",
								items: { type: "string" },
								description: "Restrict to these domains, e.g. ['arxiv.org'] (optional).",
							},
						},
						required: ["query"],
					},
				},
			},
			execute: async (args) => {
				const query = String(args.query ?? "").trim();
				if (!query) return "Error: web_search requires a non-empty 'query'.";
				const recency =
					typeof args.recency === "string" && RECENCY.includes(args.recency) ? args.recency : undefined;
				const domains = Array.isArray(args.domains)
					? args.domains.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
					: undefined;

				let results: WebResult[];
				try {
					results = await webSearch(opts, query, { recency, domains });
				} catch (error) {
					return `Error: web search failed — ${error instanceof Error ? error.message : String(error)}`;
				}
				return JSON.stringify({
					query,
					results: results
						.filter((r) => r.url)
						.map((r) => ({
							title: r.title ?? r.url,
							url: r.url,
							...(r.date ? { date: r.date } : {}),
							...(r.snippet ? { snippet: r.snippet.slice(0, 2000) } : {}),
							link: webLink(r.title, r.url as string),
						})),
				});
			},
		},
	};
}
