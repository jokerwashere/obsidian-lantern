/**
 * QmdService — orchestrates the qmd backend for the plugin.
 *
 * Composes the HTTP query client (QmdClient) and the indexing CLI (QmdCli),
 * and exposes the high-level operations main.ts needs: ensure the daemon is up,
 * register/refresh the vault as a qmd collection, and run searches scoped to it.
 *
 * Note on freshness: the qmd (≥2.5.3) daemon reads its SQLite index per query
 * — verified empirically (a collection added/removed via the CLI is visible to
 * a long-running daemon immediately) — so no daemon restart is needed after
 * indexing, and the warm models survive reindexes.
 */

import { QmdClient, type QmdResult, type QmdSearchMode } from "./QmdClient";
import { QmdCli, parseUpdateOutput, hasChanges, type UpdateCounts } from "./QmdCli";

export interface QmdServiceConfig {
	/** Path to the qmd binary. */
	binaryPath: string;
	/** Port the qmd HTTP daemon listens on. */
	port: number;
	/** Name of the qmd collection that mirrors this vault. */
	vaultCollection: string;
	/** Start the daemon automatically if it isn't already running. */
	autoStartDaemon: boolean;
	/** Run qmd's cross-encoder reranker on queries. */
	rerank: boolean;
	/** Minimum relevance score (0–1). */
	minScore: number;
	/** Default disambiguation intent sent with every query ("" = none). */
	searchIntent?: string;
	/**
	 * Collections to search. Defaults to just the vault collection; set this to
	 * also search qmd's other collections (docs, etc.).
	 */
	searchCollections?: string[];
}

export interface QmdSearchOptions {
	mode?: QmdSearchMode;
	limit?: number;
	intent?: string;
	/** Distinct lexical-keyword text for the BM25 sub-query (else `query` is reused). */
	lex?: string;
	/** Caller-written hypothetical answer passage (qmd `hyde` sub-query). */
	hyde?: string;
	/** Alternatives OR-ed via independent lex sub-queries ("any of these"). */
	anyOf?: string[];
	/** Per-call collection override (default: configured searchCollections). */
	collections?: string[];
	/** Per-call relevance floor (default: configured minScore). */
	minScore?: number;
}

export interface QmdServiceDeps {
	client?: QmdClient;
	cli?: QmdCli;
}

/** Outcome of an indexing operation, for user-facing status messages. */
export interface ReindexResult {
	/** True when the vault collection was registered for the first time. */
	registered: boolean;
	/** Per-run counts for the vault collection (null when not reported). */
	counts: UpdateCounts | null;
	/** True when an embed pass ran (false = skipped, nothing changed). */
	embedded: boolean;
}

export class QmdService {
	private config: QmdServiceConfig;
	private client: QmdClient;
	private cli: QmdCli;
	private vaultPath: string | null = null;
	/** In-flight indexing op; concurrent register/reindex requests share it. */
	private indexingOp: Promise<ReindexResult> | null = null;

	constructor(config: QmdServiceConfig, deps: QmdServiceDeps = {}) {
		this.config = config;
		this.client =
			deps.client ??
			new QmdClient({ port: config.port, binaryPath: config.binaryPath });
		this.cli = deps.cli ?? new QmdCli({ binaryPath: config.binaryPath });
	}

	/** Absolute on-disk path of the vault (set by main on load). */
	setVaultPath(path: string): void {
		this.vaultPath = path;
	}

	updateConfig(partial: Partial<QmdServiceConfig>): void {
		this.config = { ...this.config, ...partial };
		this.client.updateConfig({ port: this.config.port, binaryPath: this.config.binaryPath });
		this.cli.updateConfig({ binaryPath: this.config.binaryPath });
	}

	get collectionName(): string {
		return this.config.vaultCollection;
	}

	/** Ensure the qmd daemon is reachable, starting it if auto-start is enabled. */
	async ensureDaemon(): Promise<void> {
		if (this.config.autoStartDaemon) {
			await this.client.ensureRunning();
			return;
		}
		if (!(await this.client.isRunning())) {
			throw new Error(
				`qmd daemon is not running on port ${this.config.port}. ` +
				"Start it with `qmd mcp --http --daemon`, or enable auto-start in settings."
			);
		}
	}

	async isVaultIndexed(): Promise<boolean> {
		return this.cli.hasCollection(this.config.vaultCollection);
	}

	/** All collection names qmd knows about (CLI `collection list`; throws on failure). */
	async listCollections(): Promise<string[]> {
		return this.cli.listCollectionNames();
	}

	/** True when the qmd binary itself is runnable (used for setup guidance). */
	async isBinaryAvailable(): Promise<boolean> {
		try {
			const res = await this.cli.version();
			return res.code === 0;
		} catch {
			return false;
		}
	}

	/** Register the vault as a qmd collection (if needed) and embed it. */
	ensureVaultIndexed(): Promise<ReindexResult> {
		return this.runExclusiveIndexing(() => this.doEnsureVaultIndexed());
	}

	/**
	 * Refresh the vault index: re-scan (text) and embed when anything changed.
	 * Registers the collection first if it doesn't exist yet. The embed pass is
	 * skipped when `qmd update` reports the vault collection unchanged.
	 */
	reindexVault(): Promise<ReindexResult> {
		return this.runExclusiveIndexing(() => this.doReindexVault());
	}

	private runExclusiveIndexing(fn: () => Promise<ReindexResult>): Promise<ReindexResult> {
		if (!this.indexingOp) {
			this.indexingOp = fn().finally(() => {
				this.indexingOp = null;
			});
		}
		return this.indexingOp;
	}

	private async doEnsureVaultIndexed(): Promise<ReindexResult> {
		this.requireVaultPath();
		if (await this.cli.hasCollection(this.config.vaultCollection)) {
			// The collection is registered, but its embeddings may be missing —
			// a prior embed could have failed or been interrupted, leaving search
			// broken with no obvious recovery via this command. Re-embed to heal
			// it; `qmd embed` is a cheap no-op when nothing is pending.
			await this.embedVault();
			return { registered: false, counts: null, embedded: true };
		}
		const add = await this.cli.addCollection(this.vaultPath!, this.config.vaultCollection);
		if (add.code !== 0) {
			throw new Error(`qmd collection add failed: ${(add.stderr || add.stdout).trim()}`);
		}
		await this.embedVault();
		return { registered: true, counts: null, embedded: true };
	}

	private async doReindexVault(): Promise<ReindexResult> {
		this.requireVaultPath();
		if (!(await this.cli.hasCollection(this.config.vaultCollection))) {
			return this.doEnsureVaultIndexed();
		}
		const update = await this.cli.update();
		if (update.code !== 0) {
			throw new Error(`qmd update failed: ${(update.stderr || update.stdout).trim()}`);
		}
		const counts = parseUpdateOutput(update.stdout)[this.config.vaultCollection] ?? null;
		// Embed when the vault changed — or when the output couldn't be parsed
		// (format drift): embedding is a cheap no-op if nothing is pending.
		const needsEmbed = counts === null || hasChanges(counts);
		if (needsEmbed) {
			await this.embedVault();
		}
		return { registered: false, counts, embedded: needsEmbed };
	}

	private async embedVault(): Promise<void> {
		const embed = await this.cli.embed(this.config.vaultCollection);
		if (embed.code !== 0) {
			throw new Error(`qmd embed failed: ${(embed.stderr || embed.stdout).trim()}`);
		}
	}

	/** Run a search, scoped to the configured (or per-call overridden) collections. */
	async search(text: string, options: QmdSearchOptions = {}): Promise<QmdResult[]> {
		const collections =
			options.collections && options.collections.length > 0
				? options.collections
				: this.config.searchCollections && this.config.searchCollections.length > 0
					? this.config.searchCollections
					: [this.config.vaultCollection];

		return this.client.query(text, {
			collections,
			rerank: this.config.rerank,
			minScore: options.minScore ?? this.config.minScore,
			mode: options.mode,
			limit: options.limit,
			intent: options.intent ?? (this.config.searchIntent || undefined),
			lex: options.lex,
			hyde: options.hyde,
			anyOf: options.anyOf,
		});
	}

	/**
	 * Set (or clear, when text is blank) the human-written context summary on the
	 * vault collection root via `qmd context add/rm`. qmd stores it in its index
	 * and applies it at query time (no re-embed needed). Best-effort on clear.
	 */
	async setVaultContext(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) {
			await this.cli.removeContext(this.config.vaultCollection).catch(() => {
				/* nothing to remove — fine */
			});
			return;
		}
		const res = await this.cli.setContext(this.config.vaultCollection, trimmed);
		if (res.code !== 0) {
			throw new Error(`qmd context add failed: ${(res.stderr || res.stdout).trim()}`);
		}
	}

	async isDaemonRunning(): Promise<boolean> {
		return this.client.isRunning();
	}

	/** Start the daemon regardless of the auto-start setting (setup-card action). */
	async startDaemon(): Promise<void> {
		await this.client.ensureRunning();
	}

	async stopDaemon(): Promise<void> {
		await this.cli.stopServer();
	}

	private requireVaultPath(): void {
		if (!this.vaultPath) {
			throw new Error("Vault path not set on QmdService");
		}
	}
}
