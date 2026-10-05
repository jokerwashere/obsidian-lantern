/**
 * Lantern — local search + grounded chat for your Obsidian vault.
 *
 * Delegates search to a locally-installed `qmd` (which runs the real GGUF
 * models — EmbeddingGemma, Qwen3-Reranker, fine-tuned query expansion — via
 * llama.cpp) instead of reimplementing search in the browser. The plugin
 * registers the vault as a qmd collection and queries qmd's warm HTTP daemon.
 */

import {
	Plugin,
	Notice,
	TAbstractFile,
	TFile,
	FileSystemAdapter,
	normalizePath,
	debounce,
	setIcon,
	setTooltip,
	type Debouncer,
	type Editor,
} from "obsidian";
import { LanternView, VIEW_TYPE_LANTERN } from "./ui/SearchView";
import { LanternSettingTab } from "./ui/SettingsTab";
import {
	DEFAULT_SETTINGS,
	defaultCollectionName,
	isValidCollectionName,
	toServiceConfig,
	toLlmConfig,
	type LanternSettings,
} from "./settings";
import { QmdService, type QmdSearchOptions, type QmdVersionInfo, type ReindexResult } from "./qmd/QmdService";
import type { QmdResult } from "./qmd/QmdClient";
import { LlmClient, type ChatMessage, type ModelLoadState } from "./agent/LlmClient";
import { AgentLoop, type AgentEvent, type AgentRunResult } from "./agent/AgentLoop";
import { buildTools, referenceToolsPrompt } from "./agent/tools";
import { type WriteRequest } from "./agent/writes";
import { searchWeb } from "./agent/webSearch";
import { resolvePrompt, missingRequiredPrompts, PROMPT_DEFS } from "./agent/promptRegistry";
import { registerLanternIcon, LANTERN_ICON } from "./ui/lanternIcon";
import { errorMessage } from "./util";
import { IndexTracker, describeIndexStatus } from "./qmd/indexStatus";
import { embedLockHolder } from "./qmd/qmdConfig";

/**
 * Debounce window for auto re-indexing after file changes. `qmd update` is
 * global (it re-scans every collection — qmd has no per-collection update),
 * so don't fire on every keystroke pause.
 */
const AUTO_UPDATE_DEBOUNCE_MS = 30_000;

/** What the setup card needs to know. */
export type SetupState = "ok" | "no-binary" | "no-daemon" | "unregistered";
/** Chat needs qmd ready AND a reachable local LLM. */
export type ChatReadiness = SetupState | "no-llm-url" | "llm-unreachable";

export default class LanternPlugin extends Plugin {
	settings: LanternSettings = DEFAULT_SETTINGS;
	qmd!: QmdService;
	private llm!: LlmClient;
	agent!: AgentLoop;
	/** Warn once (not per question) when the configured system-prompt note is missing. */
	private warnedMissingPromptNote = false;

	private autoUpdate: Debouncer<[], Promise<void>> | null = null;
	/** Auto-update already told the user an embed was skipped (cleared once one isn't). */
	private embedBusyNotified = false;
	/** Vault index freshness (status bar + settings overview). */
	indexTracker!: IndexTracker;
	private statusBarEl: HTMLElement | null = null;
	/** Last rendered status-bar state, so the 1 s tick only touches the DOM on change. */
	private statusBarKey = "";

	async onload(): Promise<void> {
		registerLanternIcon(); // custom tab/ribbon icon (Lucide has no lantern)
		await this.loadSettings();

		// Derive a default vault collection name on first run.
		if (!this.settings.vaultCollection) {
			this.settings.vaultCollection = defaultCollectionName(this.app.vault.getName());
			await this.saveSettings();
		}

		this.qmd = new QmdService(toServiceConfig(this.settings));
		this.indexTracker = new IndexTracker(this.settings.lastIndexedAt);
		this.qmd.setRunListener({
			onStart: () => this.indexTracker.beginRun(Date.now()),
			onPhase: (phase) => this.indexTracker.setPhase(phase, Date.now()),
			onDone: (result) => {
				this.indexTracker.finishRun(result);
				this.settings.lastIndexedAt = this.indexTracker.status.lastIndexedAt;
				void this.saveData(this.settings); // state only — no applySettings()
			},
			onError: (error) => this.indexTracker.failRun(errorMessage(error)),
		});
		const vaultPath = this.getVaultPath();
		if (vaultPath) {
			this.qmd.setVaultPath(vaultPath);
		}

		this.llm = new LlmClient(toLlmConfig(this.settings));
		this.agent = this.buildAgent();

		this.registerView(VIEW_TYPE_LANTERN, (leaf) => new LanternView(leaf, this));

		// Left-ribbon button (custom lantern icon) → open the Lantern pane.
		this.addRibbonIcon(LANTERN_ICON, "Open Lantern", () => {
			void this.activateView("search");
		});

		this.addCommand({
			id: "open-search",
			name: "Open search",
			callback: () => this.activateView("search"),
		});

		this.addCommand({
			id: "open-chat",
			name: "Open chat",
			callback: () => this.activateView("chat"),
		});

		this.addCommand({
			id: "new-chat",
			name: "New chat",
			callback: async () => (await this.activateView("chat"))?.startNewChat(),
		});

		this.addCommand({
			id: "new-search",
			name: "New search",
			callback: async () => (await this.activateView("search"))?.startNewSearch(),
		});

		this.addCommand({
			id: "update-index",
			name: "Update qmd index for this vault",
			callback: () => this.updateIndex(),
		});

		this.addCommand({
			id: "register-vault",
			name: "Register vault with qmd",
			callback: () => this.registerVault(),
		});

		this.addCommand({
			id: "search-selection",
			name: "Search selection",
			editorCheckCallback: (checking, editor) => {
				const selection = editor.getSelection().trim();
				if (!selection) return false;
				if (!checking) void this.searchText(selection);
				return true;
			},
		});

		this.addCommand({
			id: "ask-selection",
			name: "Ask about selection",
			editorCheckCallback: (checking, editor) => {
				const selection = editor.getSelection().trim();
				if (!selection) return false;
				if (!checking) void this.askInChat(this.selectionPrefill(selection));
				return true;
			},
		});

		this.addCommand({
			id: "ask-note",
			name: "Ask about this note",
			editorCallback: () => void this.askInChat(this.notePrefill()),
		});

		// Same three actions on the editor's right-click menu.
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor: Editor) => {
				const selection = editor.getSelection().trim();
				if (selection) {
					menu.addItem((item) =>
						item
							.setTitle("Search selection")
							.setIcon("search")
							.onClick(() => void this.searchText(selection))
					);
					menu.addItem((item) =>
						item
							.setTitle("Ask about selection")
							.setIcon("message-circle")
							.onClick(() => void this.askInChat(this.selectionPrefill(selection)))
					);
				} else {
					menu.addItem((item) =>
						item
							.setTitle("Ask about this note")
							.setIcon("message-circle")
							.onClick(() => void this.askInChat(this.notePrefill()))
					);
				}
			})
		);

		this.addSettingTab(new LanternSettingTab(this.app, this));

		this.autoUpdate = debounce(() => this.runAutoUpdate(), AUTO_UPDATE_DEBOUNCE_MS, true);

		this.setupIndexStatus();

		this.app.workspace.onLayoutReady(() => {
			// File events MUST be registered after layout-ready: Obsidian fires
			// `create` for every existing file during vault load, which used to
			// trigger a full reindex on every app start.
			this.registerFileEvents();
			this.markOfflineChanges();

			// Best-effort: get the daemon warming in the background. Once it settles,
			// re-probe open setup cards — the first probe at view-open can race a cold
			// daemon/index and leave a stale "register" card up.
			void this.qmd
				.ensureDaemon()
				.catch((error) => {
					console.warn("[Lantern] qmd daemon not available on startup:", error);
				})
				.finally(() => this.refreshSetupCards());
			void this.warnIfQmdOutdated();
		});
	}

	/** One notice per load when the installed qmd is older than Lantern supports. */
	private async warnIfQmdOutdated(): Promise<void> {
		try {
			const info = await this.qmd.getVersion();
			if (info.supported) return;
			new Notice(
				`Lantern: qmd ${info.version} is older than ${info.minimum}. Result paths come back ` +
				"slugified and may not open. Update with: npm install -g @tobilu/qmd",
				15000
			);
		} catch {
			// Binary missing — the setup card covers that.
		}
	}

	/** Installed qmd version vs the supported minimum (settings overview). */
	async getQmdVersion(): Promise<QmdVersionInfo | null> {
		try {
			return await this.qmd.getVersion();
		} catch {
			return null;
		}
	}

	onunload(): void {
		// Settings are saved on every change — no save needed during teardown.
		// Cancel any pending debounced auto-update so it can't fire after unload.
		this.autoUpdate?.cancel();
		if (this.settings.stopDaemonOnUnload) {
			void this.qmd.stopDaemon().catch((error) => console.warn("[Lantern] Failed to stop qmd daemon:", error));
		}
	}

	private buildAgent(): AgentLoop {
		this.warnedMissingPromptNote = false; // re-evaluate the prompt note after any settings change
		const writesEnabled = this.settings.enableWriteTools;
		const references = this.settings.searchExternalCollections;
		const webProvider = this.settings.webSearchProvider;
		const webKey = (webProvider === "exa" ? this.settings.exaApiKey : this.settings.perplexityApiKey).trim();
		// Exa works keyless (free MCP), so it only needs the toggle; Perplexity needs a key.
		const web =
			this.settings.enableWebSearch && (webProvider === "exa" || webKey.length > 0)
				? { provider: webProvider, apiKey: webKey, maxResults: this.settings.webSearchMaxResults }
				: undefined;
		const tools = buildTools(this.app, this.qmd, {
			maxReadBytes: this.settings.agentMaxReadBytes,
			searchLimit: this.settings.agentSearchLimit,
			searchMinScore: this.settings.agentMinScore,
			writes: writesEnabled
				? {
						inboxFolder: this.settings.inboxFolder,
						confirm: (request) => this.confirmWrite(request),
					}
				: undefined,
			references:
				references.length > 0
					? {
							configured: references,
							getEnabled: () => this.getChatReferences(),
						}
					: undefined,
			web,
		});
		const overrides = this.settings.promptOverrides;
		const appendix = [
			references.length > 0
				? referenceToolsPrompt(references, resolvePrompt("reference-libraries", overrides))
				: "",
			writesEnabled ? resolvePrompt("write-tools", overrides) : "",
			web ? resolvePrompt("web-search", overrides) : "",
		]
			.filter(Boolean)
			.join("\n\n");
		return new AgentLoop(this.llm, tools, {
			maxIterations: this.settings.agentMaxIterations,
			resolveSystemPrompt: () => this.resolveSystemPrompt(),
			systemPrompt: resolvePrompt("system", overrides),
			datetimeTemplate: resolvePrompt("datetime-context", overrides),
			finalAnswerPrompt: resolvePrompt("final-answer", overrides),
			promptAppendix: appendix || undefined,
			passReasoningBack: this.settings.passReasoningBack,
			contextTokensOverride: this.settings.llmContextSize,
		});
	}

	/** References enabled for the current chat (view picker; default: all configured). */
	private getChatReferences(): string[] {
		return this.getLanternView()?.getChatReferences() ?? this.settings.searchExternalCollections;
	}

	/** Route a write-tool confirmation to the open Lantern view (deny if none). */
	private confirmWrite(request: WriteRequest): Promise<boolean> {
		const view = this.getLanternView();
		if (!view) return Promise.resolve(false);
		return view.confirmWrite(request);
	}

	private getLanternView(): LanternView | null {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_LANTERN)) {
			if (leaf.view instanceof LanternView) return leaf.view;
		}
		return null;
	}

	/** Re-run the setup-card probe on every open Lantern view (after the daemon warms). */
	private refreshSetupCards(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_LANTERN)) {
			if (leaf.view instanceof LanternView) leaf.view.refreshSetup();
		}
	}

	/** Open the search pane with a query (editor command / context menu). */
	async searchText(query: string): Promise<void> {
		const view = await this.activateView("search");
		view?.setQuery(query.slice(0, 500));
	}

	/** Open the chat pane with a prefilled (not sent) question. */
	async askInChat(prefill: string): Promise<void> {
		const view = await this.activateView("chat");
		view?.setChatInput(prefill);
	}

	private selectionPrefill(selection: string): string {
		const path = this.app.workspace.getActiveFile()?.path;
		const quoted = selection.replace(/\s+/g, " ").slice(0, 400);
		return path ? `Regarding [[${path}]] — "${quoted}": ` : `Regarding "${quoted}": `;
	}

	private notePrefill(): string {
		const path = this.app.workspace.getActiveFile()?.path;
		return path ? `Regarding [[${path}]]: ` : "";
	}

	/** Push current settings into the live services and open views. */
	applySettings(): void {
		this.qmd.updateConfig(toServiceConfig(this.settings));
		const vaultPath = this.getVaultPath();
		if (vaultPath) this.qmd.setVaultPath(vaultPath);
		this.llm.updateConfig(toLlmConfig(this.settings));
		this.agent = this.buildAgent();
		this.syncAutoUpdate();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_LANTERN)) {
			if (leaf.view instanceof LanternView) leaf.view.onSettingsChanged();
		}
	}

	/** Absolute on-disk path of the vault, or "" if not a local filesystem vault. */
	private getVaultPath(): string {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
	}

	/**
	 * Vault file events feed the index tracker (always) and auto-update (when
	 * enabled — the setting is read per event, so toggling needs no reload).
	 * Only called after layout-ready — see onload.
	 */
	private registerFileEvents(): void {
		const onChange = (file: TAbstractFile) => {
			if (!file.path.endsWith(".md")) return;
			this.indexTracker.markChanged(file.path);
			this.scheduleAutoUpdate();
		};
		this.registerEvent(this.app.vault.on("modify", onChange));
		this.registerEvent(this.app.vault.on("create", onChange));
		this.registerEvent(this.app.vault.on("delete", onChange));
		this.registerEvent(this.app.vault.on("rename", onChange));
	}

	/** Arm the debounced auto-update (no-op when the setting is off). */
	private scheduleAutoUpdate(): void {
		if (!this.settings.autoUpdateOnChange) return;
		this.autoUpdate?.();
		this.indexTracker.setScheduled(Date.now() + AUTO_UPDATE_DEBOUNCE_MS);
	}

	/** Disarm a pending auto-update when the setting is switched off. */
	private syncAutoUpdate(): void {
		if (this.settings.autoUpdateOnChange) return;
		this.autoUpdate?.cancel();
		this.indexTracker.setScheduled(null);
	}

	/**
	 * Notes modified while Obsidian was closed (sync, git pull, other editors)
	 * — mtime newer than the last index run. Skipped until one run has been
	 * recorded, since there is nothing to compare against.
	 */
	private markOfflineChanges(): void {
		const since = this.settings.lastIndexedAt;
		if (since <= 0) return;
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (file.stat.mtime > since) this.indexTracker.markChanged(file.path);
		}
		if (this.indexTracker.status.dirty > 0) this.scheduleAutoUpdate();
	}

	/**
	 * Status-bar item for the vault index: shown only while something is
	 * pending or running; click runs Update index. A 1 s tick drives the
	 * countdown/elapsed text and, every third tick, checks qmd's embed lock
	 * for an embed Lantern didn't start.
	 */
	private setupIndexStatus(): void {
		const el = this.addStatusBarItem();
		el.addClass("lantern-index-status");
		el.addEventListener("click", () => {
			const view = describeIndexStatus(this.indexTracker.status, Date.now());
			if (view.actionable) void this.updateIndex();
		});
		this.statusBarEl = el;
		this.register(this.indexTracker.subscribe(() => this.renderIndexStatus()));
		let tick = 0;
		this.registerInterval(
			window.setInterval(() => {
				if (++tick % 3 === 0) {
					const ownEmbed = this.indexTracker.status.phase === "embedding";
					this.indexTracker.setExternalEmbed(!ownEmbed && embedLockHolder() !== null);
				}
				this.renderIndexStatus();
			}, 1000)
		);
		this.renderIndexStatus();
	}

	private renderIndexStatus(): void {
		const el = this.statusBarEl;
		if (!el) return;
		const view = describeIndexStatus(this.indexTracker.status, Date.now());
		const key = `${view.level}|${view.short}|${view.detail}`;
		if (key === this.statusBarKey) return;
		this.statusBarKey = key;
		el.empty();
		el.toggleClass("lantern-hidden", view.short === "");
		el.toggleClass("mod-clickable", view.actionable);
		el.setAttr("data-level", view.level);
		setTooltip(el, `Lantern — ${view.detail}`, { placement: "top" });
		// The lantern stands in for a "Lantern:" label; its tint carries the level,
		// and a spinner follows it while a run is in progress.
		setIcon(el.createSpan({ cls: "lantern-index-status-icon" }), LANTERN_ICON);
		if (view.level === "running") setIcon(el.createSpan({ cls: "lantern-index-status-spinner" }), "loader");
		el.createSpan({ text: view.short });
	}

	private async runAutoUpdate(): Promise<void> {
		this.indexTracker.setScheduled(null);
		try {
			const result = await this.qmd.reindexVault();
			console.debug("[Lantern] Auto-update complete");
			// Auto-update is otherwise silent, but a skipped embed leaves new notes
			// without vectors. Say so once per busy stretch: the debounced update
			// re-fires on every edit burst while another `qmd embed` holds the lock.
			if (!result.embedBusy) {
				this.embedBusyNotified = false;
			} else if (!this.embedBusyNotified) {
				this.embedBusyNotified = true;
				new Notice(LanternPlugin.reindexMessage(result), 10000);
			}
			// Edits made during the run (or a run this call merely joined) are still
			// dirty — queue another pass instead of leaving them unindexed.
			if (this.indexTracker.status.dirty > 0) this.scheduleAutoUpdate();
		} catch (error) {
			console.error("[Lantern] Auto-update failed:", error);
		}
	}

	async activateView(pane: "search" | "chat" = "search"): Promise<LanternView | null> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_LANTERN)[0];
		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				await rightLeaf.setViewState({ type: VIEW_TYPE_LANTERN, active: true });
				leaf = rightLeaf;
			}
		}
		if (leaf) {
			await workspace.revealLeaf(leaf);
			const view = leaf.view;
			if (view instanceof LanternView) {
				view.setPane(pane);
				return view;
			}
		}
		return null;
	}

	/** Run a search via qmd, ensuring the daemon is up first. */
	async search(query: string, options: QmdSearchOptions): Promise<QmdResult[]> {
		await this.qmd.ensureDaemon();
		return this.qmd.search(query, options);
	}

	/** Answer a question agentically via the local LLM + qmd/vault tools. */
	async chat(
		question: string,
		onEvent: (event: AgentEvent) => void,
		history: ChatMessage[] = [],
		signal?: AbortSignal,
		wrapUpSignal?: AbortSignal
	): Promise<AgentRunResult> {
		// Safety net: refuse to run if a REQUIRED prompt resolves blank. A blanked
		// override reverts to the bundled default, so this can only fire if the
		// shipped bundled prompt were itself empty — a build/ship integrity failure.
		const missing = missingRequiredPrompts(this.settings.promptOverrides);
		if (missing.length > 0) {
			const labels = missing.map((id) => PROMPT_DEFS.find((d) => d.id === id)?.label ?? id).join(", ");
			throw new Error(`Required prompt is empty: ${labels}. Reset it in Settings → Lantern → Edit prompts.`);
		}
		// Warm qmd so the search_vault tool works; non-fatal if unreachable
		// (the tool will report a clear error and the model can adapt).
		try {
			await this.qmd.ensureDaemon();
		} catch (error) {
			console.warn("[Lantern] qmd daemon not ready for chat:", error);
		}
		return this.agent.run(question, onEvent, history, signal, wrapUpSignal);
	}

	/** Human-readable summary of a reindex outcome. */
	private static reindexMessage(result: ReindexResult): string {
		if (result.embedBusy) {
			return (
				`Lantern: ${result.registered ? "Vault registered and text-indexed" : "Text index updated"}; ` +
				"embedding skipped — another qmd embed is running. Run Update index again once it finishes."
			);
		}
		if (result.registered) return "Lantern: Vault registered and embedded.";
		if (result.counts && !result.embedded) return "Lantern: Index already up to date.";
		if (result.counts) {
			const changed = result.counts.added + result.counts.updated;
			const parts: string[] = [];
			if (changed > 0) parts.push(`${changed} file${changed === 1 ? "" : "s"} re-indexed`);
			if (result.counts.removed > 0) parts.push(`${result.counts.removed} removed`);
			return `Lantern: Index updated — ${parts.join(", ") || "no content changes"}.`;
		}
		return "Lantern: Index updated.";
	}

	/** Re-index this vault in qmd (update + embed when needed). */
	async updateIndex(): Promise<void> {
		const notice = new Notice("Lantern: Updating index (this can take a while)...", 0);
		try {
			const result = await this.qmd.reindexVault();
			notice.setMessage(LanternPlugin.reindexMessage(result));
			window.setTimeout(() => notice.hide(), 4000);
		} catch (error) {
			notice.hide();
			console.error("[Lantern] Update index failed:", error);
			new Notice(`Lantern: Update failed — ${errorMessage(error)}`);
		}
	}

	/** Push the configured vault context to qmd (or clear it when blank). */
	async applyVaultContext(): Promise<void> {
		if (!isValidCollectionName(this.settings.vaultCollection)) {
			new Notice(`Lantern: "${this.settings.vaultCollection}" is not a valid collection name. Fix it in settings.`);
			return;
		}
		try {
			await this.qmd.setVaultContext(this.settings.vaultContext);
			new Notice(
				this.settings.vaultContext.trim()
					? "Lantern: Vault context applied to qmd."
					: "Lantern: Vault context cleared."
			);
		} catch (error) {
			console.error("[Lantern] Apply vault context failed:", error);
			new Notice(`Lantern: Could not set vault context — ${errorMessage(error)}`);
		}
	}

	/** Register the vault as a qmd collection and embed it. */
	async registerVault(): Promise<void> {
		if (!this.getVaultPath()) {
			new Notice("Lantern: This vault is not on the local filesystem; cannot register with qmd.");
			return;
		}
		if (!isValidCollectionName(this.settings.vaultCollection)) {
			new Notice(
				`Lantern: "${this.settings.vaultCollection}" is not a valid collection name ` +
				"(letters/digits, then letters/digits/._-). Fix it in settings."
			);
			return;
		}
		const notice = new Notice("Lantern: Registering vault with qmd (first run indexes and embeds — this can take a while)...", 0);
		try {
			const result = await this.qmd.ensureVaultIndexed();
			notice.setMessage(
				result.registered || result.embedBusy
					? LanternPlugin.reindexMessage(result)
					: "Lantern: Vault was already registered."
			);
			window.setTimeout(() => notice.hide(), 4000);
		} catch (error) {
			notice.hide();
			console.error("[Lantern] Register vault failed:", error);
			new Notice(`Lantern: Registration failed — ${errorMessage(error)}`);
		}
	}

	/** What the setup card should show (binary → daemon → registration). */
	async getSetupState(): Promise<SetupState> {
		if (!(await this.qmd.isBinaryAvailable())) return "no-binary";
		if (!(await this.isDaemonRunning())) {
			if (!this.settings.autoStartDaemon) return "no-daemon";
			try {
				await this.qmd.ensureDaemon();
			} catch {
				return "no-daemon";
			}
		}
		// Probe via the throwing call directly: a genuinely unregistered vault
		// returns false, but a transient CLI failure (the just-started daemon still
		// warming the index, or a slow cold first `qmd collection list`) throws.
		// Swallowing that as false used to show a misleading "register" card on
		// startup even though the vault was indexed — so on error assume OK here
		// (binary + daemon are up); the post-warm re-probe will correct if wrong.
		try {
			const registered = await this.qmd.isVaultIndexed();
			this.indexTracker.setRegistered(registered);
			return registered ? "ok" : "unregistered";
		} catch {
			return "ok";
		}
	}

	/**
	 * Whether chat can actually run: qmd ready (binary → daemon → registration)
	 * AND a local LLM that is configured and reachable. Used to gate the chat send
	 * button and show a clear "set up X" card instead of failing on send.
	 */
	async getChatReadiness(): Promise<ChatReadiness> {
		const setup = await this.getSetupState();
		if (setup !== "ok") return setup;
		if (!this.settings.llmBaseUrl.trim()) return "no-llm-url";
		return (await this.pingLlm()).ok ? "ok" : "llm-unreachable";
	}

	/**
	 * Lightweight LLM reachability probe (GET /models). Does not run the model,
	 * so it's cheap enough to call automatically when settings open.
	 */
	async pingLlm(): Promise<{ ok: boolean; detail: string }> {
		try {
			const models = await this.llm.listModels();
			const name = this.settings.llmModel || models[0] || "";
			return { ok: true, detail: name ? `Reachable · ${name}` : "Reachable" };
		} catch (error) {
			return { ok: false, detail: errorMessage(error) };
		}
	}

	/** Context-window tokens to budget against (override setting, else detected, else fallback). */
	async resolveContextTokens(): Promise<number> {
		return this.llm.resolveContextTokens(this.settings.llmContextSize);
	}

	/**
	 * Base system prompt for a question. A configured note (read fresh, so edits
	 * apply immediately) REPLACES the built-in; no note — or a missing note
	 * (warned once) — returns null = the built-in default (applied in AgentLoop).
	 */
	private async resolveSystemPrompt(): Promise<string | null> {
		const path = this.settings.systemPromptNote.trim();
		if (!path) return null; // no note → built-in default
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (file instanceof TFile) {
			this.warnedMissingPromptNote = false;
			return await this.app.vault.cachedRead(file);
		}
		if (!this.warnedMissingPromptNote) {
			new Notice(`Lantern: system-prompt note "${path}" not found — using the built-in prompt.`);
			this.warnedMissingPromptNote = true;
		}
		return null;
	}

	/** Served model ids from the LLM server ([] when unreachable). */
	async listLlmModels(): Promise<string[]> {
		try {
			return await this.llm.listModels();
		} catch {
			return [];
		}
	}

	/** Served models with their load state (loaded/sleeping/…) for the settings picker ([] when unreachable). */
	async listLlmModelStatuses(): Promise<Array<{ id: string; state: ModelLoadState }>> {
		try {
			return await this.llm.listModelStatuses();
		} catch {
			return [];
		}
	}

	/** All qmd collection names ([] when the binary is missing/unreadable). */
	async listQmdCollections(): Promise<string[]> {
		try {
			return await this.qmd.listCollections();
		} catch {
			return [];
		}
	}

	/** Quick reachability/auth check for the configured web-search provider (one request). */
	async testWebSearch(): Promise<string> {
		const provider = this.settings.webSearchProvider;
		const key = (provider === "exa" ? this.settings.exaApiKey : this.settings.perplexityApiKey).trim();
		if (provider === "perplexity" && !key) return "✗ No Perplexity API key set.";
		try {
			const results = await searchWeb({ provider, apiKey: key, maxResults: 1 }, "Lantern connectivity test", {});
			const mode = provider === "exa" && !key ? "exa, keyless" : provider;
			return `✓ Connected (${mode}) — returned ${results.length} result(s).`;
		} catch (error) {
			return `✗ ${errorMessage(error)}`;
		}
	}

	/** Quick reachability check for the configured LLM server. */
	async testLlm(): Promise<string> {
		try {
			const res = await this.llm.chat([{ role: "user", content: "Reply with the single word: OK" }]);
			const reply = (res.content ?? "").trim();
			return reply ? `✓ Connected — replied "${reply.slice(0, 40)}"` : "✓ Connected (empty reply)";
		} catch (error) {
			return `✗ ${errorMessage(error)}`;
		}
	}

	async isDaemonRunning(): Promise<boolean> {
		try {
			return await this.qmd.isDaemonRunning();
		} catch {
			return false;
		}
	}

	async isVaultIndexed(): Promise<boolean> {
		try {
			return await this.qmd.isVaultIndexed();
		} catch {
			return false;
		}
	}

	async loadSettings(): Promise<void> {
		// Deep-clone the defaults so reference-typed fields absent from saved data
		// (e.g. promptOverrides, chatTemplates) don't ALIAS the shared DEFAULT_SETTINGS
		// singletons — the settings UI mutates these in place.
		this.settings = Object.assign({}, structuredClone(DEFAULT_SETTINGS), (await this.loadData()) as Partial<LanternSettings>);
		// Retire the old inline systemPrompt (superseded by systemPromptNote) so a
		// stale copy can't shadow the built-in default; cleared from disk on next save.
		delete (this.settings as LanternSettings & { systemPrompt?: string }).systemPrompt;
		// Normalize the legacy chat-template date placeholder {date} → {{date}} to match
		// the prompt-placeholder convention. Idempotent (the lookarounds skip an already
		// double-braced {{date}}); the inserter still accepts {date} regardless.
		for (const t of this.settings.chatTemplates) {
			t.prompt = t.prompt.replace(/(?<!\{)\{date\}(?!\})/g, "{{date}}");
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		if (this.qmd) this.applySettings();
	}
}
