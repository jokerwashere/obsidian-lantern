/**
 * QmdClient — thin client over a locally-running `qmd` instance.
 *
 * The plugin delegates search to the user's installed qmd (which runs the real
 * GGUF models — EmbeddingGemma, Qwen3-Reranker, fine-tuned query expansion —
 * via llama.cpp) instead of reimplementing search in the browser.
 *
 * Transport: qmd's HTTP server (`qmd mcp --http --port <port> --daemon`) exposes
 * a plain REST endpoint that needs no MCP/JSON-RPC handshake:
 *   GET  /health                          -> { status: "ok", uptime }
 *   POST /query  (alias /search)          -> { results: RawQmdResult[] }
 * The daemon keeps the models resident, so queries after the first are warm.
 */

import { requestUrl } from "obsidian";
import { spawn } from "child_process";
import { commandEnv, resolveCommand } from "./processEnv";
import { truncate, decodeUriSafe } from "../util";

export type QmdSearchType = "lex" | "vec" | "hyde";

/** Search mode: text = BM25 lexical, vector = semantic only, hybrid = both. */
export type QmdSearchMode = "text" | "hybrid" | "vector";

export interface QmdClientConfig {
	/** Port the qmd HTTP daemon listens on (qmd default: 8181). */
	port: number;
	/** Path to the qmd binary, used to start the daemon if it isn't running. */
	binaryPath: string;
	/** Host — qmd binds localhost only. */
	host?: string;
}

export interface QmdQueryOptions {
	/** Collection names to search; omit to use qmd's defaults. */
	collections?: string[];
	/** Maximum number of results. */
	limit?: number;
	/** Minimum relevance score (0–1). */
	minScore?: number;
	/** Optional disambiguation/intent context. */
	intent?: string;
	/** Run qmd's cross-encoder reranker (slower, higher precision). */
	rerank?: boolean;
	/** Search mode (default: hybrid). */
	mode?: QmdSearchMode;
	/**
	 * Distinct lexical-keyword text for the `lex` (BM25) sub-query. When set, the
	 * positional `query` drives only the semantic `vec` sub-query, so the caller
	 * can supply exact anchors (names/titles/code) separately from a paraphrase —
	 * what qmd's structured endpoint is built for. Omit to reuse `query` for both
	 * (the previous behavior). Ignored when `anyOf` is given (those ARE the lex set).
	 */
	lex?: string;
	/**
	 * Caller-written hypothetical answer passage, sent as an extra `hyde`
	 * sub-query (qmd weights the first sub-query 2×, so it goes last).
	 */
	hyde?: string;
	/**
	 * Alternatives for an "any of these" search. qmd's lex grammar AND's all
	 * terms (no OR operator), but multiple sub-queries are RRF-unioned — so
	 * each alternative becomes its own lex sub-query, OR-ing them. The main
	 * `query` then carries the semantic (vec) signal.
	 */
	anyOf?: string[];
}

/** Per-call cap on `anyOf` alternatives (each is a separate FTS sub-query). */
export const MAX_ANY_OF = 8;

/**
 * Balance double-quotes for a lex sub-query. qmd's FTS5 query builder throws
 * (→ HTTP 500) on an odd number of `"` — common while the user is mid-typing
 * a phrase. Dropping the last unmatched quote keeps a valid MATCH; an empty
 * lex query is accepted by qmd (returns no rows). Only lex text needs this —
 * vec/hyde embed the raw string.
 */
export function balanceQuotes(text: string): string {
	const count = (text.match(/"/g) || []).length;
	if (count % 2 === 0) return text;
	const last = text.lastIndexOf('"');
	return (text.slice(0, last) + text.slice(last + 1)).trim();
}

/** Raw item shape returned by qmd's REST /query endpoint. */
export interface RawQmdResult {
	docid: string;
	/** "<collection>/<relative/path.md>" */
	file: string;
	title: string;
	score: number;
	/** 1-based source line of the best match. */
	line: number;
	snippet: string;
	context: string | null;
}

export interface QmdResult {
	/** qmd doc id (e.g. "#abc123"). */
	docid: string;
	/** Collection name (first path segment of `file`). */
	collection: string;
	/** Path within the collection (vault-relative when the collection is the vault). */
	path: string;
	title: string;
	score: number;
	/** 1-based source line of the best match. */
	line: number;
	/** Cleaned snippet text (qmd line-number / diff-hunk markers stripped). */
	snippet: string;
	/** Collection context string, if any. */
	context: string | null;
}

// qmd's server does listen(port, "localhost"), which on macOS binds IPv6 ::1
// only. Use the same hostname so the client resolves to the same address
// (connecting to 127.0.0.1 would be refused).
const DEFAULT_HOST = "localhost";

/**
 * Build the JSON body for qmd's REST /query endpoint.
 *
 * The endpoint takes pre-typed sub-queries and does NOT run qmd's LLM query
 * expansion itself, so we send the raw query as lexical (+ vector for hybrid).
 *
 * `anyOf` turns "match any of these" into OR semantics: qmd has no lex OR
 * operator, but it RRF-unions independent sub-queries — so each alternative
 * becomes its own lex sub-query, and the main `query` carries the vec signal.
 */
export function buildQueryBody(
	query: string,
	options: QmdQueryOptions
): Record<string, unknown> {
	const types: QmdSearchType[] =
		options.mode === "text" ? ["lex"] : options.mode === "vector" ? ["vec"] : ["lex", "vec"];

	const anyOf = (options.anyOf ?? [])
		.map((t) => t.trim())
		.filter(Boolean)
		.slice(0, MAX_ANY_OF);

	// Lex text is quote-balanced (qmd 500s on odd quotes); vec/hyde stay raw.
	const searches: Array<{ type: QmdSearchType; query: string }> = [];
	if (anyOf.length > 0) {
		// Alternatives are the lex OR-set (first gets qmd's 2× weight); the main
		// query stays semantic. Keep a lex(query) only in text mode (no vec).
		for (const term of anyOf) searches.push({ type: "lex", query: balanceQuotes(term) });
		if (types.includes("vec")) searches.push({ type: "vec", query });
		else searches.push({ type: "lex", query: balanceQuotes(query) });
	} else {
		// Distinct lex (keywords) vs vec (paraphrase): when `lex` is supplied the
		// lexical sub-query uses it and `query` stays the semantic signal; else the
		// raw query feeds both (the previous behavior). lex stays quote-balanced.
		const lexText = options.lex && options.lex.trim() ? options.lex.trim() : query;
		for (const type of types) {
			searches.push({ type, query: type === "lex" ? balanceQuotes(lexText) : query });
		}
	}
	if (options.hyde && options.hyde.trim()) {
		searches.push({ type: "hyde", query: options.hyde.trim() });
	}

	const body: Record<string, unknown> = {
		searches,
		limit: options.limit ?? 10,
		minScore: options.minScore ?? 0,
	};
	if (options.collections && options.collections.length > 0) {
		body.collections = options.collections;
	}
	if (options.intent) {
		body.intent = options.intent;
	}
	if (options.rerank !== undefined) {
		body.rerank = options.rerank;
	}
	return body;
}

/**
 * Split a qmd `file` field into collection + path.
 *
 * Newer qmd (literal-path storage) returns a qmd:// URI with a percent-encoded
 * real path, e.g. `qmd://coll/Job%20Hunt%202025/Note.md`; older qmd (≤2.5.3)
 * returned a bare slug `coll/job-hunt-2025/note.md`. Handle both: strip the
 * scheme and URL-decode each part. `/` separators are not encoded by qmd.
 */
export function mapResult(raw: RawQmdResult): QmdResult {
	const file = (raw.file ?? "").replace(/^qmd:\/\//, "");
	const slash = file.indexOf("/");
	const collection = decodeUriSafe(slash === -1 ? "" : file.slice(0, slash));
	const path = decodeUriSafe(slash === -1 ? file : file.slice(slash + 1));

	return {
		docid: raw.docid,
		collection,
		path,
		title: raw.title,
		score: raw.score,
		line: raw.line,
		snippet: cleanSnippet(raw.snippet ?? ""),
		context: raw.context ?? null,
	};
}

/**
 * Strip qmd's presentation markup from a snippet: leading "N: " line-number
 * prefixes and "@@ -a,b @@ (... )" diff-hunk header lines.
 */
export function cleanSnippet(snippet: string): string {
	return snippet
		.split("\n")
		.map((line) => line.replace(/^\d+:\s?/, ""))
		.filter((line) => !/^@@ .*@@/.test(line))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export class QmdClient {
	private config: Required<QmdClientConfig>;
	/** In-flight ensureRunning, so concurrent callers share one daemon start. */
	private starting: Promise<void> | null = null;

	constructor(config: QmdClientConfig) {
		this.config = { host: DEFAULT_HOST, ...config };
	}

	updateConfig(config: Partial<QmdClientConfig>): void {
		this.config = { ...this.config, ...config };
	}

	private baseUrl(): string {
		return `http://${this.config.host}:${this.config.port}`;
	}

	/** True if a qmd daemon is responding on the configured port. */
	async isRunning(): Promise<boolean> {
		try {
			const res = await requestUrl({
				url: `${this.baseUrl()}/health`,
				method: "GET",
				throw: false,
			});
			const body = res.json as { status?: string } | undefined;
			return res.status === 200 && body?.status === "ok";
		} catch {
			return false;
		}
	}

	/**
	 * Ensure a qmd daemon is running on the configured port, starting one if
	 * necessary and polling /health until it is ready. Concurrent calls (e.g.
	 * the startup warmup racing the first search) share a single start attempt.
	 */
	async ensureRunning(timeoutMs = 30000): Promise<void> {
		if (await this.isRunning()) return;

		if (!this.starting) {
			this.starting = this.startAndPoll(timeoutMs).finally(() => {
				this.starting = null;
			});
		}
		return this.starting;
	}

	private async startAndPoll(timeoutMs: number): Promise<void> {
		await this.spawnDaemon();

		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			if (await this.isRunning()) return;
			await delay(500);
		}
		throw new Error(
			`qmd daemon did not become healthy on port ${this.config.port} within ${timeoutMs}ms`
		);
	}

	/**
	 * Run a search against the qmd daemon. Assumes the daemon is running
	 * (call ensureRunning() first).
	 */
	async query(text: string, options: QmdQueryOptions = {}): Promise<QmdResult[]> {
		const trimmed = text.trim();
		if (!trimmed) return [];

		let res;
		try {
			res = await requestUrl({
				url: `${this.baseUrl()}/query`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(buildQueryBody(trimmed, options)),
				throw: false,
			});
		} catch (error) {
			throw new Error(
				`qmd daemon not reachable at ${this.baseUrl()} ` +
				`(${error instanceof Error ? error.message : String(error)}). ` +
				"Is qmd running? Check the qmd binary path in Lantern settings."
			);
		}

		if (res.status !== 200) {
			throw new Error(
				`qmd query failed (HTTP ${res.status}): ${truncate(res.text ?? "", 200)}`
			);
		}

		// `res.json` is a getter that can throw on a non-JSON body.
		let results: RawQmdResult[];
		try {
			const body = res.json as { results?: RawQmdResult[] } | undefined;
			results = body?.results ?? [];
		} catch {
			throw new Error(
				`qmd returned a non-JSON response: ${truncate(res.text ?? "", 200)}`
			);
		}
		return results.map(mapResult);
	}

	/** Start the qmd HTTP daemon as a detached process. */
	private spawnDaemon(): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const args = ["mcp", "--http", "--port", String(this.config.port), "--daemon"];

			const child = spawn(resolveCommand(this.config.binaryPath), args, {
				detached: true,
				stdio: "ignore",
				env: commandEnv(),
			});

			child.once("error", (err: Error) => {
				if (settled) return;
				settled = true;
				reject(
					new Error(
						`Failed to start qmd daemon ("${this.config.binaryPath} ${args.join(" ")}"): ${err.message}`
					)
				);
			});

			child.once("spawn", () => {
				child.unref();
				if (settled) return;
				settled = true;
				resolve();
			});
		});
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
