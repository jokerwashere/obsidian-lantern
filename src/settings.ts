/**
 * Plugin settings.
 *
 * The plugin delegates search to a locally-installed `qmd`, so settings
 * configure how to reach and drive it rather than an in-browser engine.
 */

import type { ReasoningEffort, LlmClientConfig } from "./agent/LlmClient";
import type { QmdServiceConfig } from "./qmd/QmdService";

export interface ChatTemplate {
	name: string;
	prompt: string;
}

export interface LanternSettings {
	/** Path to the qmd binary (e.g. "qmd" or "/Users/you/Library/pnpm/qmd"). */
	qmdBinaryPath: string;
	/** Port the qmd HTTP daemon listens on. */
	qmdPort: number;
	/** qmd collection name that mirrors this vault (auto-derived if empty). */
	vaultCollection: string;
	/** Start the qmd daemon automatically if it isn't already running. */
	autoStartDaemon: boolean;
	/** Stop the qmd daemon when the plugin unloads (off = leave it warm). */
	stopDaemonOnUnload: boolean;
	/** Re-index the vault in qmd (debounced) when files change. */
	autoUpdateOnChange: boolean;

	/** Default to hybrid (text + semantic) search; false = text-only. */
	defaultSemantic: boolean;
	/** Run qmd's cross-encoder reranker (slower, higher precision). */
	rerank: boolean;
	/** Minimum relevance score to show a result (0–1). */
	minScore: number;
	/** Number of results to request. */
	resultsPerPage: number;
	/** Additional qmd collections to search alongside the vault (by name). */
	searchExternalCollections: string[];
	/** Default disambiguation intent sent with every qmd query ("" = none). */
	searchIntent: string;
	/**
	 * Human-written summary of what this vault contains, attached to the qmd
	 * collection root (`qmd context add`) to improve ranking. "" = none.
	 * Applied to qmd on demand (settings button), not on every save.
	 */
	vaultContext: string;
	/** Re-rank search results with a recency boost (the "Recent" chip). */
	boostRecent: boolean;
	/** Pinned queries for the search pane's bookmark menu (max 12). */
	savedSearches: string[];

	// --- Chat / agent (local LLM) ---
	/** OpenAI-compatible base URL incl. path, e.g. http://localhost:8080/v1 (llama-server). */
	llmBaseUrl: string;
	/** API key (optional; local servers usually ignore it). */
	llmApiKey: string;
	/** Model name (llama-server ignores it; LM Studio uses it). */
	llmModel: string;
	/** LLM context window in tokens; 0 = auto-detect from the server. */
	llmContextSize: number;
	/** Sampling temperature for the chat model. */
	llmTemperature: number;
	/** Max tool-use iterations per question. */
	agentMaxIterations: number;
	/** Max bytes (UTF-8) returned by the read_file tool before truncation. */
	agentMaxReadBytes: number;
	/** Results per search_vault call (kept small — local context windows). */
	agentSearchLimit: number;
	/**
	 * Relevance floor for the agent's search_vault calls (0–0.7). Decoupled from
	 * the Search pane's `minScore`: the agent reads and filters, so it favors
	 * recall (lower floor) over the pane's precision.
	 */
	agentMinScore: number;
	/** Reasoning/thinking strength for chat (default: off). */
	reasoningEffort: ReasoningEffort;
	/**
	 * Pass each turn's reasoning back to the server during tool use (llama.cpp
	 * webui default; Qwen/GLM/Kimi-style templates need it for consistent
	 * think-state). Off saves context for models that ignore it (DeepSeek-R1)
	 * or strict servers that reject the field.
	 */
	passReasoningBack: boolean;
	/** Vault note whose contents REPLACE the system prompt; empty = the built-in default. */
	systemPromptNote: string;
	/**
	 * Per-prompt user overrides, keyed by PromptId (see agent/promptRegistry).
	 * Overrides-only: a blank/absent entry means "use the bundled default", so
	 * untouched prompts track shipped improvements and "reset" = clear the entry.
	 */
	promptOverrides: Record<string, string>;
	/** Reusable chat prompts ({{date}} → today's date at insert time). */
	chatTemplates: ChatTemplate[];
	/** Enable the gated write tools (create_note / append_to_daily_note). */
	enableWriteTools: boolean;
	/** The only folder create_note may write into. */
	inboxFolder: string;
	/** Persist chat threads to disk (opt-in; off = in-memory only). */
	persistChatThreads: boolean;
	/** Max chats to keep when persisting; 0 = unlimited. Oldest pruned first. */
	maxPersistedThreads: number;

	// --- Web search (Perplexity / Exa) ---
	/** Enable the gated web_search tool. Default off. */
	enableWebSearch: boolean;
	/** Web search provider: "perplexity" (key required) or "exa" (key optional — keyless free MCP fallback). */
	webSearchProvider: "perplexity" | "exa";
	/** Perplexity API key (Bearer). Empty = Perplexity web search unavailable. */
	perplexityApiKey: string;
	/** Exa API key (x-api-key). Optional — empty uses Exa's free keyless MCP endpoint. */
	exaApiKey: string;
	/** Web results requested per web_search call (1–20). */
	webSearchMaxResults: number;
}

export const DEFAULT_SETTINGS: LanternSettings = {
	qmdBinaryPath: "qmd",
	qmdPort: 8181,
	vaultCollection: "",
	autoStartDaemon: true,
	stopDaemonOnUnload: false,
	autoUpdateOnChange: false,

	defaultSemantic: true,
	rerank: true,
	// 0.65 with rerank on = high-precision results out of the box; lower it
	// for more recall. Applies to both the search pane and agent searches.
	minScore: 0.65,
	resultsPerPage: 20,
	searchExternalCollections: [],
	searchIntent: "",
	vaultContext: "",
	boostRecent: false,
	savedSearches: [],

	llmBaseUrl: "http://localhost:8080/v1",
	llmApiKey: "",
	llmModel: "",
	llmContextSize: 0,
	llmTemperature: 0.2,
	agentMaxIterations: 6,
	agentMaxReadBytes: 8000,
	agentSearchLimit: 6,
	// Lower than the pane's 0.65: the agent reads candidates and filters, so it
	// favors recall. With rerank on, 0.4 keeps useful-but-not-top hits in play.
	agentMinScore: 0.4,
	reasoningEffort: "off",
	passReasoningBack: true,
	systemPromptNote: "",
	promptOverrides: {},
	chatTemplates: [
		{
			name: "Weekly review",
			prompt:
				"Review my week (today is {{date}}): read my daily notes from the last 7 days and check my recently edited notes, then summarize what happened, key decisions, and list every open task or loose end as an action item with its source.",
		},
		{
			name: "Daily standup",
			prompt:
				"Prepare my standup for {{date}}: from yesterday's and today's daily notes and recent edits — what did I do yesterday, what's planned for today, and are there any blockers?",
		},
		{
			name: "Open questions",
			prompt:
				"Find open questions, undecided points, and unresolved follow-ups across my notes from the last 14 days. Group them by topic and cite each source.",
		},
	],
	enableWriteTools: false,
	inboxFolder: "Lantern Inbox",
	persistChatThreads: false,
	maxPersistedThreads: 10,
	enableWebSearch: false,
	webSearchProvider: "perplexity",
	perplexityApiKey: "",
	exaApiKey: "",
	webSearchMaxResults: 5,
};

/**
 * Derive a safe default qmd collection name from a vault name.
 * e.g. "My Notes" -> "obsidian-my-notes".
 */
export function defaultCollectionName(vaultName: string): string {
	const slug = vaultName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `obsidian-${slug || "vault"}`;
}

/**
 * Valid qmd collection name as Lantern enforces it. qmd itself accepts any
 * string verbatim (verified in its source), so this guards against names that
 * would break downstream: a leading "-" (parsed as a CLI flag), whitespace or
 * "(" (breaks `collection list` parsing), "/" (breaks `qmd://name/path`
 * splitting).
 */
export function isValidCollectionName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

/**
 * Map settings → QmdService config. Pure (no `this`/app access) so it can be
 * unit-tested; `main.ts` is excluded from coverage. When extra reference
 * collections are configured, search spans the vault + those collections.
 */
export function toServiceConfig(s: LanternSettings): QmdServiceConfig {
	return {
		binaryPath: s.qmdBinaryPath,
		port: s.qmdPort,
		vaultCollection: s.vaultCollection,
		autoStartDaemon: s.autoStartDaemon,
		rerank: s.rerank,
		minScore: s.minScore,
		searchIntent: s.searchIntent || undefined,
		searchCollections:
			s.searchExternalCollections.length > 0
				? [s.vaultCollection, ...s.searchExternalCollections]
				: undefined,
	};
}

/** Map settings → LlmClient config. Pure (see toServiceConfig). */
export function toLlmConfig(s: LanternSettings): LlmClientConfig {
	return {
		baseUrl: s.llmBaseUrl,
		apiKey: s.llmApiKey || undefined,
		model: s.llmModel || undefined,
		temperature: s.llmTemperature,
		reasoningEffort: s.reasoningEffort,
	};
}
