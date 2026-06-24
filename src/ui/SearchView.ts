/**
 * Lantern side pane — one view, switchable between Search (qmd) and Chat (agent).
 *
 * Modern unified input box at the bottom (à la llama-server's webui): a rounded
 * container with a textarea on top and an actions bar — Search/Chat toggle on
 * the left, mode-specific controls in the middle, circular submit on the right.
 *
 * Chat streams: answer text renders live as it arrives (think-filtered in the
 * agent layer), reasoning collapses into the trace, and the send button turns
 * into Stop while a run is in flight.
 */

import {
	ItemView,
	WorkspaceLeaf,
	TFile,
	Notice,
	Menu,
	debounce,
	setIcon,
	MarkdownRenderer,
} from "obsidian";
import { LANTERN_ICON } from "./lanternIcon";
import type LanternPlugin from "../main";
import type { QmdResult, QmdSearchMode } from "../qmd/QmdClient";
import { resolveVaultPath, resolveVaultPaths } from "../qmd/vaultPath";
import { readCollectionRoots, resolveWithinRoot } from "../qmd/qmdConfig";
import { parseScopeTokens, describeScope, scopeCandidates, scopedFetchLimit } from "../search/scope";
import { decodeUriSafe, errorMessage } from "../util";
import { applyRecencyBoost, recencyFetchLimit } from "../search/rank";
import type { ChatMessage, ReasoningEffort } from "../agent/LlmClient";
import { isAbortError } from "../agent/LlmClient";
import { compactHistory } from "../agent/history";
import { deriveContextBudget } from "../agent/contextBudget";
import type { AgentEvent } from "../agent/AgentLoop";
import type { WriteRequest } from "../agent/writes";
import { ThreadStore, newThreadId, formatRelativeTime } from "./threads";
import { LanternInputSuggest } from "./InputSuggest";
import {
	toolIconName,
	friendlyToolLabel,
	toolOutcome,
	prettyJson,
	safeParseArgs,
	parseToolResult,
	parseQmdHref,
	externalRefFromPath,
	type SearchHitData,
} from "./traceFormat";

export const VIEW_TYPE_LANTERN = "lantern-view";

/** Public setup guide the "no-go" cards link to (works once the repo is published). */
const SETUP_GUIDE_URL = "https://github.com/jokerwashere/obsidian-lantern#requirements";

/** How often to re-check for an externally-started service while a no-go card is up. */
const READINESS_POLL_MS = 3000;

type Pane = "search" | "chat";

/** Per-assistant-message render state for streamed events. */
interface ChatRenderCtx {
	block: HTMLElement;
	statusEl: HTMLElement;
	traceEl: HTMLElement;
	answerEl: HTMLElement;
	streamEl: HTMLElement | null;
	reasoningPre: HTMLElement | null;
	reasoningOutcome: HTMLElement | null;
	reasoningChars: number;
	usageEl: HTMLElement | null;
	/** Bottom row holding the context usage (left) + action icons (right). */
	footerEl: HTMLElement | null;
	/** The question that produced this turn + the history before it — for Retry. */
	question: string;
	historyBefore: ChatMessage[];
}

export class LanternView extends ItemView {
	plugin: LanternPlugin;
	private mode: Pane = "search";
	private searchType: QmdSearchMode = "hybrid";

	// content
	private contentRootEl: HTMLElement | null = null;
	private setupCardEl: HTMLElement | null = null;
	/** Cached readiness for the gate (block-send): updated by refreshSetupCard. */
	private searchReady = false;
	private chatReady = false;
	/** Monotonic token so overlapping setup-card probes can't stack/orphan cards. */
	private setupGen = 0;
	/** Interval that re-checks for an externally-started qmd daemon / LLM (cleared when ready). */
	private readinessTimer: number | null = null;
	private searchResultsEl: HTMLElement | null = null;
	private chatTranscriptEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;

	// input box
	private inputEl: HTMLTextAreaElement | null = null;
	private sendBtn: HTMLElement | null = null;
	private searchTabEl: HTMLElement | null = null;
	private chatTabEl: HTMLElement | null = null;
	private searchControlsEl: HTMLElement | null = null;
	private chatControlsEl: HTMLElement | null = null;
	/** Global (per-conversation) context meter shown in the chat bar. */
	private globalMeterEl: HTMLElement | null = null;
	private sessionCompletionTokens = 0;
	private lastContextFill: { used: number; max: number } | null = null;
	private rerankChip: HTMLElement | null = null;
	private inputSuggest: LanternInputSuggest | null = null;

	// state
	private currentQuery = "";
	private chatHistory: ChatMessage[] = [];
	private chatBusy = false;
	private chatAbort: AbortController | null = null;
	private activeChatCtx: ChatRenderCtx | null = null;
	/** Externals included in the next search (per-view; default: all configured). */
	private activeExternal: Set<string> | null = null;
	private threadsChip: HTMLElement | null = null;
	private collectionsChip: HTMLElement | null = null;
	private referencesChip: HTMLElement | null = null;
	private webChip: HTMLElement | null = null;
	private writeChip: HTMLElement | null = null;
	/** References enabled for this chat (null = all configured). */
	private activeChatRefs: Set<string> | null = null;
	private threadStore: ThreadStore | null = null;
	private activeThreadId: string | null = null;
	/** Chat autoscroll: pin to bottom unless the user has scrolled up. */
	private stickToBottom = true;
	/** True once a search has returned — drops the model-warm-up hint. */
	private searchWarmedUp = false;
	/** Re-sync callbacks for settings-derived controls (labels, toggle states). */
	private controlRefreshers: Array<() => void> = [];

	constructor(leaf: WorkspaceLeaf, plugin: LanternPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.searchType = plugin.settings.defaultSemantic ? "hybrid" : "text";
	}

	getViewType(): string {
		return VIEW_TYPE_LANTERN;
	}
	getDisplayText(): string {
		return "Lantern";
	}
	getIcon(): string {
		return LANTERN_ICON;
	}

	async onOpen(): Promise<void> {
		const root = this.containerEl.children[1];
		root.empty();
		root.addClass("lantern-view");

		// Scrollable content area (results OR chat transcript)
		const content = root.createDiv({ cls: "lantern-content" });
		this.contentRootEl = content;
		this.searchResultsEl = content.createDiv({ cls: "lantern-search-results" });
		this.chatTranscriptEl = content.createDiv({ cls: "lantern-chat-transcript" });
		this.chatTranscriptEl.createDiv({
			cls: "lantern-chat-hint",
			text: "Ask a question about your vault — answers are grounded in your notes and cited. Requires a local LLM server (llama-server / LM Studio) at the URL in settings.",
		});

		// Make rendered citations ([[wikilinks]]) and external links actionable.
		content.addEventListener("click", (e) => this.handleLinkClick(e));

		// Track whether the chat is pinned to the bottom: stay stuck while the
		// user is at the bottom, release when they scroll up to read, re-stick
		// when they return. Streaming output then keeps the latest text visible.
		this.registerDomEvent(content as HTMLElement, "scroll", () => {
			const el = content as HTMLElement;
			this.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		});

		this.statusEl = root.createDiv({ cls: "lantern-statusbar" });

		this.buildInputBox(root as HTMLElement);
		this.applyMode();

		// First-run guidance: show a setup card until qmd is fully wired up.
		void this.refreshSetupCard();

		// Opt-in thread persistence: restore the active thread.
		if (this.plugin.settings.persistChatThreads) {
			void this.initThreads();
		}
	}

	async onClose(): Promise<void> {
		this.chatAbort?.abort();
		this.stopReadinessPoll();
	}

	// ------------------------------------------------------------- input box

	private buildInputBox(root: HTMLElement): void {
		const area = root.createDiv({ cls: "lantern-input-area" });
		const box = area.createDiv({ cls: "lantern-input-box" });

		this.inputEl = box.createEl("textarea", {
			cls: "lantern-input",
			attr: { rows: "1", placeholder: "Search your vault…" },
		});
		this.inputEl.addEventListener("input", () => {
			this.autoGrow();
			if (this.mode === "search") this.debouncedSearch();
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				// Enter never aborts a running chat (only the Stop button does).
				if (this.mode === "chat" && this.chatBusy) return;
				void this.submit();
			}
		});
		// #tag / [[link autocomplete (intercepts Enter/Tab/arrows when open).
		// addChild ties its DOM/vault listeners to this view's lifecycle (auto-unload).
		this.inputSuggest = new LanternInputSuggest(this.app, this.inputEl, area);
		this.addChild(this.inputSuggest);

		const actions = box.createDiv({ cls: "lantern-input-actions" });

		// Search/Chat segmented toggle (left)
		const seg = actions.createDiv({ cls: "lantern-seg" });
		this.searchTabEl = seg.createEl("button", { cls: "lantern-seg-btn", text: "Search" });
		this.chatTabEl = seg.createEl("button", { cls: "lantern-seg-btn", text: "Chat" });
		this.searchTabEl.addEventListener("click", () => this.setPane("search"));
		this.chatTabEl.addEventListener("click", () => this.setPane("chat"));

		// Mode-specific controls (middle, pushed right)
		const controls = actions.createDiv({ cls: "lantern-controls" });
		this.buildSearchControls(controls);
		this.buildChatControls(controls);

		// Submit / Stop (right)
		this.sendBtn = actions.createEl("button", { cls: "lantern-send", attr: { "aria-label": "Send" } });
		this.sendBtn.addEventListener("click", () => {
			if (this.mode === "chat" && this.chatBusy) {
				this.chatAbort?.abort();
				return;
			}
			void this.submit();
		});
	}

	private buildSearchControls(parent: HTMLElement): void {
		const wrap = parent.createDiv({ cls: "lantern-controls-group" });
		this.searchControlsEl = wrap;

		this.buildDropdown(
			wrap,
			[
				{ value: "hybrid", label: "Hybrid" },
				{ value: "text", label: "Text" },
				{ value: "vector", label: "Semantic" },
			],
			() => this.searchType,
			(v) => {
				this.searchType = v as QmdSearchMode;
				if (this.currentQuery) void this.performSearch();
			}
		);

		this.rerankChip = wrap.createEl("button", {
			cls: "lantern-chip lantern-toggle",
			text: "Rerank",
			attr: { type: "button", title: "Cross-encoder reranking (higher precision)" },
		});
		this.updateRerankChip();
		this.controlRefreshers.push(() => this.updateRerankChip());
		this.rerankChip.addEventListener("click", () => {
			void (async () => {
				this.plugin.settings.rerank = !this.plugin.settings.rerank;
				await this.plugin.saveSettings();
				if (this.currentQuery) void this.performSearch();
			})();
		});

		// "Recent" — recency-boosted re-ranking (persisted, like Rerank).
		const recentChip = wrap.createEl("button", {
			cls: "lantern-chip lantern-toggle",
			text: "Recent",
			attr: { type: "button", title: "Boost recently modified notes in the ranking" },
		});
		const refreshRecent = () => {
			recentChip.toggleClass("is-on", this.plugin.settings.boostRecent);
			recentChip.setAttr("aria-pressed", String(this.plugin.settings.boostRecent));
		};
		refreshRecent();
		this.controlRefreshers.push(refreshRecent);
		recentChip.addEventListener("click", () => {
			void (async () => {
				this.plugin.settings.boostRecent = !this.plugin.settings.boostRecent;
				await this.plugin.saveSettings();
				if (this.currentQuery) void this.performSearch();
			})();
		});

		// Saved searches (bookmark menu).
		const savedChip = wrap.createEl("button", {
			cls: "lantern-chip lantern-icon-chip",
			attr: { "aria-label": "Saved searches", title: "Saved searches", type: "button" },
		});
		setIcon(savedChip, "bookmark");
		savedChip.addEventListener("click", (evt) => this.openSavedSearchesMenu(evt));

		// Per-query external-library picker + on/off indicator. The vault is
		// always searched (so it's not listed); the chip lights up when ≥1
		// library is enabled. Visible only when libraries are configured.
		this.collectionsChip = wrap.createEl("button", {
			cls: "lantern-chip lantern-icon-chip lantern-toggle",
			attr: { "aria-label": "Libraries", type: "button" },
		});
		setIcon(this.collectionsChip, "library");
		this.collectionsChip.addEventListener("click", (evt) => this.openCollectionsMenu(evt));
		this.updateCollectionsChip();
		this.controlRefreshers.push(() => this.updateCollectionsChip());
	}

	private openSavedSearchesMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const saved = this.plugin.settings.savedSearches;
		const current = this.inputEl?.value.trim() ?? "";

		for (const query of saved) {
			menu.addItem((item) =>
				item
					.setTitle(query.length > 44 ? `${query.slice(0, 44)}…` : query)
					.setIcon("search")
					.onClick(() => this.setQuery(query))
			);
		}
		if (saved.length > 0) menu.addSeparator();
		if (current && !saved.includes(current)) {
			menu.addItem((item) =>
				item
					.setTitle("Save current query")
					.setIcon("bookmark-plus")
					.onClick(async () => {
						this.plugin.settings.savedSearches = [current, ...saved].slice(0, 12);
						await this.plugin.saveSettings();
					})
			);
		}
		if (current && saved.includes(current)) {
			menu.addItem((item) =>
				item
					.setTitle("Remove current from saved")
					.setIcon("bookmark-minus")
					.onClick(async () => {
						this.plugin.settings.savedSearches = saved.filter((q) => q !== current);
						await this.plugin.saveSettings();
					})
			);
		}
		if (saved.length === 0 && !current) {
			menu.addItem((item) => item.setTitle("Type a query, then save it here").setDisabled(true));
		}
		menu.showAtMouseEvent(evt);
	}

	private openCollectionsMenu(evt: MouseEvent): void {
		const configured = this.plugin.settings.searchExternalCollections;
		if (this.activeExternal === null) this.activeExternal = new Set(configured);
		const active = this.activeExternal;
		const menu = new Menu();
		// The vault is always searched, so it isn't listed — only the optional
		// external libraries are toggleable here.
		if (configured.length === 0) {
			menu.addItem((item) =>
				item.setTitle("Add libraries under Settings → Also search collections").setDisabled(true)
			);
		}
		for (const name of configured) {
			menu.addItem((item) =>
				item
					.setTitle(name)
					.setChecked(active.has(name))
					.onClick(() => {
						if (active.has(name)) active.delete(name);
						else active.add(name);
						this.updateCollectionsChip();
						if (this.currentQuery) void this.performSearch();
					})
			);
		}
		menu.showAtMouseEvent(evt);
	}

	/** References the agent may consult in this chat (picker selection). */
	getChatReferences(): string[] {
		const configured = this.plugin.settings.searchExternalCollections;
		if (this.activeChatRefs === null) return [...configured];
		return configured.filter((c) => this.activeChatRefs!.has(c));
	}

	/** Reflect references on/off on the chip (like web/write): on when ≥1 is enabled. */
	private updateReferencesChip(): void {
		if (!this.referencesChip) return;
		const total = this.plugin.settings.searchExternalCollections.length;
		const enabled = this.getChatReferences().length;
		const on = enabled > 0;
		this.referencesChip.toggleClass("is-on", on);
		this.referencesChip.setAttr("aria-pressed", String(on));
		this.referencesChip.setAttr(
			"title",
			on ? `Reference libraries: on (${enabled} of ${total})` : "Reference libraries: off"
		);
	}

	private openReferencesMenu(evt: MouseEvent): void {
		const configured = this.plugin.settings.searchExternalCollections;
		if (this.activeChatRefs === null) this.activeChatRefs = new Set(configured);
		const active = this.activeChatRefs;
		const menu = new Menu();
		if (configured.length === 0) {
			menu.addItem((item) =>
				item.setTitle("Add collections under Settings → Also search collections").setDisabled(true)
			);
		}
		for (const name of configured) {
			menu.addItem((item) =>
				item
					.setTitle(name)
					.setChecked(active.has(name))
					.onClick(() => {
						if (active.has(name)) active.delete(name);
						else active.add(name);
						this.updateReferencesChip();
					})
			);
		}
		menu.showAtMouseEvent(evt);
	}

	private buildChatControls(parent: HTMLElement): void {
		const wrap = parent.createDiv({ cls: "lantern-controls-group" });
		this.chatControlsEl = wrap;

		// Global context meter (latest conversation fill; updates per answer).
		this.globalMeterEl = wrap.createSpan({
			cls: "lantern-ctx-meter",
			attr: { "aria-label": "Conversation context usage" },
		});
		this.globalMeterEl.hide();

		// References picker: which external collections the AGENT may consult
		// in this chat (visible only when any are configured in settings).
		this.referencesChip = wrap.createEl("button", {
			cls: "lantern-chip lantern-icon-chip lantern-toggle",
			attr: { "aria-label": "Reference libraries", type: "button" },
		});
		setIcon(this.referencesChip, "library");
		this.referencesChip.addEventListener("click", (evt) => this.openReferencesMenu(evt));
		this.updateReferencesChip();
		this.controlRefreshers.push(() => this.updateReferencesChip());

		// Web search on/off (shown only when the provider is usable — see applyMode).
		this.webChip = wrap.createEl("button", {
			cls: "lantern-chip lantern-icon-chip lantern-toggle",
			attr: { type: "button", "aria-label": "Web search" },
		});
		setIcon(this.webChip, "globe");
		const refreshWeb = () => {
			const on = this.plugin.settings.enableWebSearch;
			const provider = this.plugin.settings.webSearchProvider === "exa" ? "Exa" : "Perplexity";
			this.webChip?.toggleClass("is-on", on);
			this.webChip?.setAttr("aria-pressed", String(on));
			this.webChip?.setAttr("title", `Web search (${provider}): ${on ? "on" : "off"}`);
		};
		refreshWeb();
		this.controlRefreshers.push(refreshWeb);
		this.webChip.addEventListener("click", () => {
			void (async () => {
				this.plugin.settings.enableWebSearch = !this.plugin.settings.enableWebSearch;
				await this.plugin.saveSettings(); // applySettings() rebuilds the agent + re-syncs chips
			})();
		});

		// Write tools on/off (every write still shows an Apply/Deny card).
		this.writeChip = wrap.createEl("button", {
			cls: "lantern-chip lantern-icon-chip lantern-toggle",
			attr: { type: "button", "aria-label": "Write tools" },
		});
		setIcon(this.writeChip, "square-pen");
		const refreshWrite = () => {
			const on = this.plugin.settings.enableWriteTools;
			this.writeChip?.toggleClass("is-on", on);
			this.writeChip?.setAttr("aria-pressed", String(on));
			this.writeChip?.setAttr("title", `Write tools — create / append, each confirmed: ${on ? "on" : "off"}`);
		};
		refreshWrite();
		this.controlRefreshers.push(refreshWrite);
		this.writeChip.addEventListener("click", () => {
			void (async () => {
				this.plugin.settings.enableWriteTools = !this.plugin.settings.enableWriteTools;
				await this.plugin.saveSettings();
			})();
		});

		// Chat templates ({{date}} → today, inserted but not auto-sent).
		const templatesChip = wrap.createEl("button", {
			cls: "lantern-chip lantern-icon-chip",
			attr: { "aria-label": "Prompt templates", title: "Prompt templates", type: "button" },
		});
		setIcon(templatesChip, "zap");
		templatesChip.addEventListener("click", (evt) => {
			const menu = new Menu();
			const templates = this.plugin.settings.chatTemplates;
			if (templates.length === 0) {
				menu.addItem((item) => item.setTitle("No templates — add them in settings").setDisabled(true));
			}
			for (const template of templates) {
				menu.addItem((item) =>
					item
						.setTitle(template.name)
						.setIcon("zap")
						.onClick(() => {
							const today = new Date().toISOString().slice(0, 10);
							// {{date}} is canonical (matches the prompt editors); {date} stays
								// supported for templates authored before the switch.
								this.setChatInput(
									template.prompt.replace(/\{\{date\}\}/g, today).replace(/\{date\}/g, today)
								);
						})
				);
			}
			menu.showAtMouseEvent(evt);
		});

		this.buildDropdown(
			wrap,
			[
				{ value: "off", label: "Off" },
				{ value: "low", label: "Low" },
				{ value: "medium", label: "Medium" },
				{ value: "high", label: "High" },
			],
			() => this.plugin.settings.reasoningEffort,
			(v) => {
				void (async () => {
					this.plugin.settings.reasoningEffort = v as ReasoningEffort;
					await this.plugin.saveSettings();
				})();
			},
			{ icon: "lightbulb", title: "Reasoning strength (for models that support thinking)" }
		);

		// Previous chats (visible only when persistence is enabled in settings).
		// Switching/managing only — starting fresh is the "+" button's job.
		this.threadsChip = wrap.createEl("button", {
			cls: "lantern-chip lantern-icon-chip",
			attr: { "aria-label": "Previous chats", title: "Previous chats", type: "button" },
		});
		setIcon(this.threadsChip, "messages-square");
		this.threadsChip.addEventListener("click", (evt) => this.openThreadsMenu(evt));

		const clearBtn = wrap.createEl("button", {
			cls: "lantern-chip lantern-icon-chip",
			attr: { "aria-label": "New chat", title: "New chat", type: "button" },
		});
		setIcon(clearBtn, "plus");
		clearBtn.addEventListener("click", () => this.clearChat());
	}

	/**
	 * A themed dropdown chip (label + caret) that opens an Obsidian Menu.
	 * The label re-syncs via controlRefreshers when settings change elsewhere
	 * (the settings tab and these chips share the same stored values).
	 */
	private buildDropdown(
		parent: HTMLElement,
		options: Array<{ value: string; label: string }>,
		getCurrent: () => string,
		onSelect: (value: string) => void,
		opts: { icon?: string; title?: string } = {}
	): void {
		const chip = parent.createEl("button", { cls: "lantern-chip lantern-dropdown", attr: { type: "button" } });
		if (opts.title) chip.setAttr("title", opts.title);
		if (opts.icon) setIcon(chip.createSpan({ cls: "lantern-dropdown-icon" }), opts.icon);
		const labelEl = chip.createSpan({ cls: "lantern-dropdown-label" });
		setIcon(chip.createSpan({ cls: "lantern-dropdown-caret" }), "chevron-down");

		const refresh = () => {
			const cur = getCurrent();
			labelEl.setText(options.find((o) => o.value === cur)?.label ?? cur);
		};
		refresh();
		this.controlRefreshers.push(refresh);

		chip.addEventListener("click", (evt) => {
			const cur = getCurrent();
			const menu = new Menu();
			for (const opt of options) {
				menu.addItem((item) =>
					item
						.setTitle(opt.label)
						.setChecked(opt.value === cur)
						.onClick(() => {
							onSelect(opt.value);
							refresh();
						})
				);
			}
			menu.showAtMouseEvent(evt);
		});
	}

	private updateRerankChip(): void {
		const on = this.plugin.settings.rerank;
		this.rerankChip?.toggleClass("is-on", on);
		this.rerankChip?.setAttr("aria-pressed", String(on));
	}

	private autoGrow(): void {
		const el = this.inputEl;
		if (!el) return;
		el.setCssStyles({ height: "auto" });
		el.setCssStyles({ height: `${Math.min(el.scrollHeight, 200)}px` });
	}

	// ----------------------------------------------------------------- modes

	setPane(pane: Pane): void {
		this.mode = pane;
		this.applyMode();
		void this.refreshSetupCard(); // re-probe readiness for the new mode (gate + card)
		this.inputEl?.focus();
	}

	private applyMode(): void {
		const isSearch = this.mode === "search";
		this.searchTabEl?.toggleClass("is-active", isSearch);
		this.chatTabEl?.toggleClass("is-active", !isSearch);
		this.searchTabEl?.setAttr("aria-pressed", String(isSearch));
		this.chatTabEl?.setAttr("aria-pressed", String(!isSearch));
		this.searchResultsEl?.toggle(isSearch);
		this.chatTranscriptEl?.toggle(!isSearch);
		this.searchControlsEl?.toggle(isSearch);
		this.chatControlsEl?.toggle(!isSearch);
		this.statusEl?.toggle(isSearch);
		// The setup/no-go card is rebuilt per mode by refreshSetupCard (it serves
		// both search and chat now), so applyMode no longer toggles it by mode.
		this.threadsChip?.toggle(!isSearch && this.plugin.settings.persistChatThreads);
		this.collectionsChip?.toggle(
			isSearch && this.plugin.settings.searchExternalCollections.length > 0
		);
		this.referencesChip?.toggle(
			!isSearch && this.plugin.settings.searchExternalCollections.length > 0
		);
		// Exa works keyless, so its chip shows whenever the provider is Exa; Perplexity needs a key.
		const webUsable =
			this.plugin.settings.webSearchProvider === "exa" ||
			this.plugin.settings.perplexityApiKey.trim().length > 0;
		this.webChip?.toggle(!isSearch && webUsable);
		this.writeChip?.toggle(!isSearch);

		if (this.inputEl) {
			this.inputEl.placeholder = isSearch ? "Search your vault…  (#tag scopes)" : "Ask your vault…";
		}
		this.updateSendButton();
	}

	private updateSendButton(): void {
		if (!this.sendBtn) return;
		this.sendBtn.empty();
		const stop = this.mode === "chat" && this.chatBusy;
		// Block-send for CHAT: disable until qmd + a reachable LLM are verified
		// (Stop always allowed). Search isn't button-blocked — scope-only listings
		// work offline; its qmd round-trip is gated inside performSearch instead.
		const blocked = this.mode === "chat" && !stop && !this.chatReady;
		setIcon(this.sendBtn, stop ? "square" : this.mode === "search" ? "search" : "arrow-up");
		this.sendBtn.setAttr("aria-label", stop ? "Stop" : "Send");
		this.sendBtn.toggleClass("is-stop", stop);
		this.sendBtn.toggleClass("is-disabled", blocked);
		if (blocked) this.sendBtn.setAttr("disabled", "true");
		else this.sendBtn.removeAttribute("disabled");
		this.sendBtn.setAttr("title", blocked ? "Chat isn't ready — see the setup card" : "");
	}

	private debouncedSearch = debounce(() => this.performSearch(), 400, true);

	private submit(): Promise<void> {
		// An explicit submit supersedes any pending debounced run of the same
		// query (each rerank pass costs seconds — never run it twice).
		this.debouncedSearch.cancel();
		return this.mode === "search" ? this.performSearch() : this.sendChat();
	}

	setQuery(query: string): void {
		this.setPane("search");
		if (this.inputEl) {
			this.inputEl.value = query;
			void this.performSearch();
		}
	}

	/**
	 * Called by the plugin after ANY settings change so chips, dropdown
	 * labels, and chip visibility reflect the settings tab immediately
	 * (the two surfaces edit the same stored values).
	 */
	onSettingsChanged(): void {
		for (const refresh of this.controlRefreshers) refresh();
		this.applyMode();
		// Re-probe: a settings change may have FIXED the gate (LLM URL set, qmd path
		// corrected) — otherwise the card + disabled send button would stay stale.
		void this.refreshSetupCard();
	}

	/** Re-evaluate the first-run setup card (e.g. after the daemon finishes warming). */
	refreshSetup(): void {
		void this.refreshSetupCard();
	}

	/** Start a fresh chat (command / hotkey): switch to chat, clear, focus. */
	startNewChat(): void {
		this.setPane("chat");
		this.clearChat();
		this.inputEl?.focus();
	}

	/** Start a fresh search (command / hotkey): switch to search, clear, focus. */
	startNewSearch(): void {
		this.setPane("search");
		if (this.inputEl) this.inputEl.value = "";
		this.autoGrow();
		this.searchResultsEl?.empty();
		this.currentQuery = "";
		this.setStatus("");
		this.inputEl?.focus();
	}

	/** Prefill the chat input (focused, caret at end, NOT auto-sent). */
	setChatInput(text: string): void {
		this.setPane("chat");
		if (!this.inputEl) return;
		this.inputEl.value = text;
		this.autoGrow();
		this.inputEl.focus();
		this.inputEl.setSelectionRange(text.length, text.length);
	}

	// ---------------------------------------------------------------- search

	private async performSearch(): Promise<void> {
		const raw = this.inputEl?.value.trim() ?? "";
		if (!raw) {
			this.searchResultsEl?.empty();
			this.setStatus("");
			this.currentQuery = "";
			return;
		}

		this.currentQuery = raw;
		const parsed = parseScopeTokens(raw);
		const scopeLabel = describeScope(parsed.scope);

		// Scope-only query (no free text) → instant metadata listing, no qmd round-trip.
		if (parsed.hasScope && parsed.rest.length === 0) {
			this.displayScopeListing(scopeCandidates(this.app, parsed.scope) ?? new Set<string>(), scopeLabel);
			return;
		}

		// Block the qmd-backed search until qmd is verified ready (the setup card
		// explains what's missing and links the setup guide).
		if (!this.searchReady) {
			this.setStatus("Search isn't ready — qmd isn't set up. See the setup card above.");
			void this.refreshSetupCard();
			return;
		}

		this.setStatus(
			this.searchWarmedUp ? "Searching…" : "Searching… (first query warms up qmd's models)"
		);
		try {
			const limit = this.plugin.settings.resultsPerPage;
			const boost = this.plugin.settings.boostRecent;
			const scope = parsed.hasScope ? (scopeCandidates(this.app, parsed.scope) ?? new Set<string>()) : null;
			const queryText = parsed.hasScope ? parsed.rest : raw;
			const externals = this.enabledSearchCollections();
			const suffixBits = [scopeLabel ? `in ${scopeLabel}` : "", boost ? "recent-boosted" : ""].filter(Boolean);
			const suffix = suffixBits.length > 0 ? ` · ${suffixBits.join(" · ")}` : "";

			// Vault group: scope + recency boost apply only here.
			const vaultResults = await this.searchVaultGroup(queryText, scope, boost, limit);
			this.searchWarmedUp = true; // models are loaded now
			if (raw !== this.currentQuery) return;

			if (externals.length === 0) {
				this.displayResults(vaultResults, suffix);
				return;
			}

			// Each external is ranked in its OWN qmd call (separate rank space), so
			// a big collection can't bury the vault. Scope tokens are vault metadata,
			// so externals just get the cleaned query text.
			const externalGroups = await Promise.all(
				externals.map((coll) =>
					this.plugin
						.search(queryText, { mode: this.searchType, limit, collections: [coll] })
						.then((results) => ({ label: coll, results }))
						.catch((error) => {
							console.error(`[Lantern] Search error in collection "${coll}":`, error);
							return { label: coll, results: [] as QmdResult[] };
						})
				)
			);
			if (raw !== this.currentQuery) return;

			this.displayGroupedResults(
				[{ label: "Vault", results: vaultResults }, ...externalGroups],
				suffix
			);
		} catch (error) {
			if (raw !== this.currentQuery) return; // stale failure — keep newer state
			console.error("[Lantern] Search error:", error);
			this.setStatus(`Search failed — ${errorMessage(error)}`);
			void this.refreshSetupCard();
		}
	}

	/** Search the vault collection, applying tag scope + recency boost. */
	private async searchVaultGroup(
		queryText: string,
		scope: Set<string> | null,
		boost: boolean,
		limit: number
	): Promise<QmdResult[]> {
		let fetchLimit = limit;
		if (scope) fetchLimit = scopedFetchLimit(limit);
		if (boost) fetchLimit = Math.max(fetchLimit, recencyFetchLimit(limit));

		const fetched = await this.plugin.search(queryText, {
			mode: this.searchType,
			limit: fetchLimit,
			collections: [this.plugin.settings.vaultCollection],
		});

		const resolution = resolveVaultPaths(this.app, fetched.map((r) => r.path));
		let results = scope
			? fetched.filter((r) => {
					const path = resolution.get(r.path);
					return path !== null && path !== undefined && scope.has(path);
				})
			: fetched;

		if (boost) {
			results = applyRecencyBoost(results, (r) => {
				const path = resolution.get(r.path);
				const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
				return file instanceof TFile ? file.stat.mtime : null;
			});
		}
		return results.slice(0, limit);
	}

	private displayResults(results: QmdResult[], statusSuffix = ""): void {
		const container = this.searchResultsEl;
		if (!container) return;
		container.empty();

		if (results.length === 0) {
			this.setStatus(`No results found${statusSuffix}`);
			container.createDiv({ cls: "lantern-no-results", text: "No matching documents found." });
			return;
		}
		this.setStatus(`${results.length} result${results.length === 1 ? "" : "s"}${statusSuffix}`);
		for (const result of results) this.renderResultCard(container, result);
	}

	/**
	 * Grouped rendering — one section per collection, each independently
	 * ranked. qmd's score is relative to the candidate batch (blended with
	 * fused rank), so a single cross-collection call lets a large collection's
	 * volume bury vault hits below minScore. Per-collection queries give each
	 * source its own rank space, so every group's real top hits survive.
	 */
	private displayGroupedResults(
		groups: Array<{ label: string; results: QmdResult[] }>,
		statusSuffix = ""
	): void {
		const container = this.searchResultsEl;
		if (!container) return;
		container.empty();

		const total = groups.reduce((n, g) => n + g.results.length, 0);
		if (total === 0) {
			this.setStatus(`No results found${statusSuffix}`);
			container.createDiv({ cls: "lantern-no-results", text: "No matching documents found." });
			return;
		}
		const sources = groups.filter((g) => g.results.length > 0).length;
		this.setStatus(`${total} result${total === 1 ? "" : "s"} across ${sources} source${sources === 1 ? "" : "s"}${statusSuffix}`);

		for (const group of groups) {
			if (group.results.length === 0) continue;
			container.createDiv({
				cls: "lantern-result-group",
				text: `${group.label} (${group.results.length})`,
			});
			for (const result of group.results) this.renderResultCard(container, result);
		}
	}

	private renderResultCard(container: HTMLElement, result: QmdResult): void {
		const el = container.createDiv({ cls: "lantern-result" });
		const header = el.createDiv({ cls: "lantern-result-header" });
		const title = header.createEl("span", { cls: "lantern-result-path", text: result.title || result.path });
		title.addEventListener("click", () => {
			void this.openResult(result);
		});

		const isVault = result.collection === this.plugin.settings.vaultCollection;
		el.createDiv({
			cls: "lantern-result-breadcrumb",
			text: isVault ? result.path : `${result.collection} › ${result.path}`,
		});
		el.createDiv({ cls: "lantern-result-score", text: `Score: ${(result.score * 100).toFixed(0)}` });
		if (result.snippet) el.createDiv({ cls: "lantern-result-snippet", text: result.snippet });
	}

	/** External collections enabled for the search pane (picker; null = all). */
	private enabledSearchCollections(): string[] {
		const configured = this.plugin.settings.searchExternalCollections;
		if (configured.length === 0) return [];
		if (this.activeExternal === null) return [...configured];
		return configured.filter((c) => this.activeExternal!.has(c));
	}

	/** Reflect enabled libraries on the chip (on when ≥1; the vault is always searched). */
	private updateCollectionsChip(): void {
		if (!this.collectionsChip) return;
		const total = this.plugin.settings.searchExternalCollections.length;
		const enabled = this.enabledSearchCollections().length;
		const on = enabled > 0;
		this.collectionsChip.toggleClass("is-on", on);
		this.collectionsChip.setAttr("aria-pressed", String(on));
		this.collectionsChip.setAttr(
			"title",
			on
				? `Also searching ${enabled} of ${total} ${total === 1 ? "library" : "libraries"} (+ vault)`
				: "Vault only — no libraries selected"
		);
	}

	/** Listing for scope-only queries (#tag / folder: / within: / key=value): matching notes, newest first. */
	private displayScopeListing(scope: Set<string>, label: string): void {
		const container = this.searchResultsEl;
		if (!container) return;
		container.empty();

		// The scope set already names the matching paths — resolve each by hash
		// lookup instead of rescanning the whole vault a second time.
		const files = [...scope]
			.map((p) => this.app.vault.getAbstractFileByPath(p))
			.filter((f): f is TFile => f instanceof TFile)
			.sort((a, b) => b.stat.mtime - a.stat.mtime)
			.slice(0, this.plugin.settings.resultsPerPage);

		if (files.length === 0) {
			this.setStatus(`No notes match ${label}`);
			container.createDiv({ cls: "lantern-no-results", text: `No notes match ${label}.` });
			return;
		}
		this.setStatus(`${scope.size} note${scope.size === 1 ? "" : "s"} match ${label}`);

		for (const file of files) {
			const el = container.createDiv({ cls: "lantern-result lantern-result-compact" });
			const header = el.createDiv({ cls: "lantern-result-header" });
			const title = header.createEl("span", { cls: "lantern-result-path", text: file.basename });
			title.addEventListener("click", () => {
				void this.app.workspace.getLeaf(false).openFile(file);
			});
			el.createDiv({ cls: "lantern-result-breadcrumb", text: file.path });
		}
		if (scope.size > files.length) {
			container.createDiv({
				cls: "lantern-no-results",
				text: `…and ${scope.size - files.length} more. Add search terms to rank within ${label}.`,
			});
		}
	}

	private async openResult(result: QmdResult): Promise<void> {
		if (result.collection !== this.plugin.settings.vaultCollection) {
			await this.openExternalResult(result);
			return;
		}
		const realPath = resolveVaultPath(this.app, result.path);
		const file = realPath ? this.app.vault.getAbstractFileByPath(realPath) : null;
		if (!(file instanceof TFile)) {
			new Notice(`File not found in vault: ${result.path}`);
			return;
		}
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file, { eState: { line: Math.max(0, result.line - 1) } });
	}

	private async openExternalResult(result: QmdResult): Promise<void> {
		await this.openExternalDoc(result.collection, result.path);
	}

	/**
	 * Open a reference document (a non-vault qmd collection) with the system
	 * default app, using the collection roots from qmd's config; fall back to
	 * copying the absolute path.
	 */
	private async openExternalDoc(collection: string, path: string): Promise<void> {
		// A qmd:// citation link is authored by the local LLM from untrusted
		// note/reference/web content. Only open collections the user actually
		// configured (never an arbitrary collection from qmd's global index.yml).
		if (!this.plugin.settings.searchExternalCollections.includes(collection)) {
			new Notice(`Reference "${collection}" isn't a configured collection.`);
			return;
		}
		const root = readCollectionRoots()[collection];
		if (!root) {
			new Notice(`Reference "${collection}" — its root folder isn't in qmd's index.yml, so it can't be opened.`);
			return;
		}
		// Refuse a path that escapes the collection root (e.g. an injected `..`).
		const absPath = resolveWithinRoot(root, path);
		if (!absPath) {
			new Notice(`Reference path "${path}" is invalid.`);
			return;
		}

		type ShellModule = { shell?: { openPath?: (path: string) => Promise<string> } };
		const electron = (window as unknown as { require?: (m: string) => ShellModule }).require?.("electron");
		const openPath = electron?.shell?.openPath;
		if (openPath) {
			const error = await openPath(absPath);
			if (!error) return;
		}
		try {
			await navigator.clipboard.writeText(absPath);
			new Notice(`Couldn't open externally — full path copied to clipboard.`);
		} catch {
			new Notice(absPath);
		}
	}

	/**
	 * Open citation links rendered in chat answers (Obsidian doesn't auto-wire
	 * them in a custom view). Reference-document links open externally;
	 * crucially, an internal link that doesn't resolve to an EXISTING vault
	 * note is NOT followed (openLinkText would create an empty note) — it is
	 * routed to the external opener when it names a reference collection, else
	 * reported.
	 */
	private handleLinkClick(evt: MouseEvent): void {
		const anchor = (evt.target as HTMLElement | null)?.closest("a");
		if (!anchor) return;
		const href = anchor.getAttribute("data-href") || anchor.getAttribute("href") || "";

		// Footnote ref/back-ref: an in-document anchor (#fn-… / #fnref-…). Obsidian
		// only wires these inside a reading view, so scroll it ourselves — scoped to
		// the clicked answer block, which also defeats duplicate footnote ids across
		// answers in the transcript (clicking always lands in the right answer).
		if (href.startsWith("#")) {
			evt.preventDefault();
			const id = decodeUriSafe(href.slice(1));
			if (!id) return;
			const scope = anchor.closest(".lantern-chat-msg") ?? this.chatTranscriptEl;
			const target = scope?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
			if (target) {
				target.scrollIntoView({ behavior: "smooth", block: "center" });
				target.classList.add("lantern-footnote-flash");
				window.setTimeout(() => target.classList.remove("lantern-footnote-flash"), 1200);
			}
			return;
		}

		// Reference document: explicit qmd:// scheme.
		const qmd = parseQmdHref(href);
		if (qmd) {
			evt.preventDefault();
			void this.openExternalDoc(qmd.collection, qmd.path);
			return;
		}

		if (anchor.classList.contains("internal-link")) {
			evt.preventDefault();
			if (!href) return;
			// Existing vault note → open it normally.
			const real = resolveVaultPath(this.app, decodeUriSafe(href).split("#")[0]);
			if (real && this.app.vault.getAbstractFileByPath(real) instanceof TFile) {
				const newLeaf = evt.ctrlKey || evt.metaKey || evt.button === 1;
				void this.app.workspace.openLinkText(href, "", newLeaf);
				return;
			}
			// A reference into a configured external collection → open externally.
			const ext = externalRefFromPath(href, this.plugin.settings.searchExternalCollections);
			if (ext) {
				void this.openExternalDoc(ext.collection, ext.path);
				return;
			}
			// Unresolvable: do NOT create an empty note.
			new Notice(`No note named "${href}" in your vault.`);
			return;
		}

		if (/^https?:\/\//i.test(href)) {
			evt.preventDefault();
			window.open(href, "_blank", "noopener");
		}
	}

	private setStatus(message: string): void {
		if (this.statusEl) this.statusEl.textContent = message;
	}

	// ------------------------------------------------------------ setup card

	/** First-run guidance: what is missing (binary / daemon / registration). */
	private stopReadinessPoll(): void {
		if (this.readinessTimer !== null) {
			window.clearInterval(this.readinessTimer);
			this.readinessTimer = null;
		}
	}

	/**
	 * Poll for a service the user starts OUTSIDE Obsidian (the qmd daemon or the
	 * LLM server) so the gate re-enables on its own when it comes up — no need to
	 * touch settings. Cheap and targeted: one probe of just the missing piece per
	 * tick; on success, a full re-probe re-evaluates the gate (and stops this poll).
	 */
	private startReadinessPoll(reason: "no-daemon" | "llm-unreachable"): void {
		this.stopReadinessPoll();
		this.readinessTimer = window.setInterval(() => {
			void (async () => {
				const up =
					reason === "llm-unreachable"
						? (await this.plugin.pingLlm()).ok
						: await this.plugin.isDaemonRunning();
				if (up) void this.refreshSetupCard(); // re-evaluate fully; flips/clears the poll
			})();
		}, READINESS_POLL_MS);
	}

	private async refreshSetupCard(): Promise<void> {
		// Token this run so a later probe (mode switch, settings change, daemon warm)
		// supersedes an in-flight one — otherwise overlapping probes stack/orphan cards.
		const gen = ++this.setupGen;
		// Rebuild for the CURRENT mode; drop any stale card up front so a mode
		// switch doesn't briefly show the previous mode's card during the probe.
		this.setupCardEl?.remove();
		this.setupCardEl = null;

		const isChat = this.mode === "chat";
		const state = isChat ? await this.plugin.getChatReadiness() : await this.plugin.getSetupState();
		if (gen !== this.setupGen) return; // a newer probe started — let it own the card/flags

		if (isChat) this.chatReady = state === "ok";
		else this.searchReady = state === "ok";
		this.updateSendButton(); // reflect readiness on the gate (block-send)

		// Auto-detect a daemon/LLM the user starts externally; config-level reasons
		// (no-binary / no-llm-url / unregistered) are fixed via settings/actions, not polling.
		if (state === "no-daemon" || state === "llm-unreachable") this.startReadinessPoll(state);
		else this.stopReadinessPoll();

		if (state === "ok" || !this.contentRootEl) return;

		const card = createDiv({ cls: "lantern-setup-card" });
		this.contentRootEl.prepend(card);
		this.setupCardEl = card;

		const head = card.createDiv({ cls: "lantern-setup-head" });
		setIcon(head.createSpan({ cls: "lantern-setup-icon" }), LANTERN_ICON);
		head.createSpan({ text: isChat ? "Set up chat" : "Set up Lantern" });

		const texts: Record<string, string> = {
			"no-binary":
				"qmd was not found. Install qmd — it needs a build newer than v2.5.3 — and set its full path in settings (see the setup guide).",
			"no-daemon": "The qmd daemon isn't running.",
			unregistered: "This vault isn't registered with qmd yet — register it to index and embed your notes.",
			"no-llm-url": "Chat needs a local LLM. Set the LLM base URL in settings (e.g. http://localhost:8080/v1).",
			"llm-unreachable":
				"The local LLM server isn't responding. Start it (llama-server with --jinja, or LM Studio) and check the base URL.",
		};
		card.createDiv({ cls: "lantern-setup-text", text: texts[state] ?? "Lantern isn't fully set up yet." });

		const row = card.createDiv({ cls: "lantern-setup-actions" });
		const action = async (label: string, fn: () => Promise<void>) => {
			const btn = row.createEl("button", { cls: "lantern-setup-btn", text: label });
			btn.addEventListener("click", () => {
				void (async () => {
					btn.setAttr("disabled", "true");
					try {
						await fn();
					} finally {
						void this.refreshSetupCard();
					}
				})();
			});
		};

		if (state === "no-daemon") {
			await action("Start daemon", async () => {
				try {
					await this.plugin.qmd.startDaemon();
				} catch (error) {
					new Notice(`Lantern: could not start the daemon — ${errorMessage(error)}`);
				}
			});
		}
		if (state === "unregistered") {
			await action("Register vault", async () => {
				await this.plugin.registerVault();
			});
		}
		const settingsBtn = row.createEl("button", { cls: "lantern-setup-btn", text: "Open settings" });
		settingsBtn.addEventListener("click", () => this.openLanternSettings());

		const guideBtn = row.createEl("button", {
			cls: "lantern-setup-btn lantern-setup-btn-ghost",
			text: "Setup guide ↗",
		});
		guideBtn.addEventListener("click", () => window.open(SETUP_GUIDE_URL, "_blank", "noopener"));
	}

	private openLanternSettings(): void {
		// `app.setting` is not in the public typings but is stable in practice.
		const appWithSettings = this.app as unknown as {
			setting?: { open(): void; openTabById(id: string): void };
		};
		appWithSettings.setting?.open();
		appWithSettings.setting?.openTabById("lantern");
	}

	// --------------------------------------------------------------- threads

	private async initThreads(): Promise<void> {
		const dir = this.plugin.manifest.dir;
		if (!dir) return;
		this.threadStore = new ThreadStore(this.app.vault.adapter, `${dir}/threads.json`);
		await this.threadStore.load();
		const active = this.threadStore.data.threads.find(
			(t) => t.id === this.threadStore?.data.activeId
		);
		if (active) {
			this.activeThreadId = active.id;
			this.chatHistory = active.messages;
			this.renderStoredTranscript(active.messages);
		}
	}

	private openThreadsMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const store = this.threadStore;
		if (!store) {
			menu.addItem((item) => item.setTitle("Thread persistence is starting…").setDisabled(true));
			menu.showAtMouseEvent(evt);
			void this.initThreads();
			return;
		}
		if (store.data.threads.length === 0) {
			menu.addItem((item) =>
				item.setTitle("No saved chats yet — finish a chat and it appears here").setDisabled(true)
			);
		}
		for (const thread of store.data.threads) {
			menu.addItem((item) =>
				item
					.setTitle(`${thread.title}  ·  ${formatRelativeTime(thread.updatedAt)}`)
					.setChecked(thread.id === this.activeThreadId)
					.onClick(async () => {
						this.activeThreadId = thread.id;
						this.chatHistory = thread.messages;
						this.renderStoredTranscript(thread.messages);
						await store.setActive(thread.id);
					})
			);
		}
		// No "new" item here: the adjacent "+" (New chat) button starts fresh.
		if (this.activeThreadId) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Delete this chat")
					.setIcon("trash-2")
					.onClick(() => void this.deleteActiveChat())
			);
		}
		menu.showAtMouseEvent(evt);
	}

	/** Re-render a restored thread (tool traces are not persisted). */
	private renderStoredTranscript(messages: ChatMessage[]): void {
		const t = this.chatTranscriptEl;
		if (!t) return;
		t.empty();
		messages.forEach((msg, index) => {
			if (msg.role === "user" && msg.content) {
				t.createDiv({ cls: "lantern-chat-msg lantern-chat-user", text: msg.content });
			} else if (msg.role === "assistant" && msg.content && !msg.tool_calls?.length) {
				const block = t.createDiv({ cls: "lantern-chat-msg lantern-chat-assistant" });
				const answerEl = block.createDiv({ cls: "lantern-chat-answer" });
				void MarkdownRenderer.render(this.app, msg.content, answerEl, "", this);
				// Restored turns persist no trace + no usage, so the footer holds just
				// the action icons (no "clear trace" brush); Retry rebuilds the turn.
				this.fillAnswerActions(block.createDiv({ cls: "lantern-chat-footer" }), {
					answer: msg.content,
					traceEl: null,
					onRetry: () => this.retryStored(block, messages, index),
				});
			}
		});
		this.scrollChat(true);
	}

	/** Persist the current conversation when thread persistence is on. */
	private async persistActiveThread(): Promise<void> {
		if (!this.plugin.settings.persistChatThreads || this.chatHistory.length === 0) return;
		if (!this.threadStore) await this.initThreads();
		if (!this.threadStore) return;
		if (!this.activeThreadId) this.activeThreadId = newThreadId();
		await this.threadStore.upsert(
			this.activeThreadId,
			this.chatHistory,
			this.plugin.settings.maxPersistedThreads
		);
	}

	// ----------------------------------------------------------- write tools

	/** Apply/Deny card for a gated write (resolves the tool's confirm()). */
	confirmWrite(request: WriteRequest): Promise<boolean> {
		const ctx = this.activeChatCtx;
		if (!ctx) return Promise.resolve(false);
		const signal = this.chatAbort?.signal;

		return new Promise<boolean>((resolve) => {
			const card = ctx.block.createDiv({ cls: "lantern-write-card" });
			const head = card.createDiv({ cls: "lantern-write-head" });
			setIcon(
				head.createSpan({ cls: "lantern-write-icon" }),
				request.action === "create" ? "file-plus" : "calendar-plus"
			);
			head.createSpan({
				text: request.action === "create" ? `Create ${request.path}?` : `Append to ${request.path}?`,
			});
			const preview =
				request.preview.length > 400 ? `${request.preview.slice(0, 400)}…` : request.preview;
			card.createEl("pre", { cls: "lantern-tool-pre lantern-write-preview", text: preview });

			let settled = false;
			const finish = (approved: boolean) => {
				if (settled) return;
				settled = true;
				if (signal) signal.removeEventListener("abort", onAbort);
				card.remove();
				resolve(approved);
			};
			const onAbort = () => finish(false);
			if (signal) signal.addEventListener("abort", onAbort, { once: true });

			const row = card.createDiv({ cls: "lantern-setup-actions" });
			const apply = row.createEl("button", { cls: "lantern-setup-btn mod-cta", text: "Apply" });
			apply.addEventListener("click", () => finish(true));
			const deny = row.createEl("button", { cls: "lantern-setup-btn", text: "Deny" });
			deny.addEventListener("click", () => finish(false));
			this.scrollChat();
		});
	}

	// ------------------------------------------------------------------ chat

	private clearChat(): void {
		this.chatAbort?.abort();
		this.chatHistory = [];
		this.activeThreadId = null;
		if (this.threadStore) void this.threadStore.setActive(null);
		if (this.chatTranscriptEl) {
			this.chatTranscriptEl.empty();
			this.chatTranscriptEl.createDiv({ cls: "lantern-chat-hint", text: "New conversation." });
		}
		this.sessionCompletionTokens = 0;
		this.lastContextFill = null;
		this.renderGlobalMeter();
	}

	/**
	 * Delete the current chat: drop its persisted thread from disk (when
	 * persistence is on and this chat was saved) so it does NOT reappear in the
	 * Previous-chats menu, then reset the view. With persistence off there is no
	 * saved thread, so this is just a view reset.
	 */
	private async deleteActiveChat(): Promise<void> {
		const id = this.activeThreadId;
		if (id && this.threadStore) await this.threadStore.remove(id);
		this.clearChat();
	}

	private async sendChat(questionArg?: string): Promise<void> {
		const question = (questionArg ?? this.inputEl?.value ?? "").trim();
		if (!question || this.chatBusy || !this.chatTranscriptEl) return;
		if (!this.chatReady) {
			// Block-send: also enforced here so the Enter key can't bypass the
			// disabled button. The setup card explains what's missing.
			new Notice("Lantern: chat isn't ready — set up qmd and a local LLM (see the setup card).");
			void this.refreshSetupCard();
			return;
		}

		this.chatBusy = true;
		this.chatAbort = new AbortController();
		this.updateSendButton();
		if (questionArg === undefined && this.inputEl) {
			this.inputEl.value = "";
			this.autoGrow();
		}

		this.chatTranscriptEl.createDiv({ cls: "lantern-chat-msg lantern-chat-user", text: question });
		const block = this.chatTranscriptEl.createDiv({ cls: "lantern-chat-msg lantern-chat-assistant" });
		const statusEl = block.createDiv({ cls: "lantern-chat-status", text: "Thinking…" });
		const traceEl = block.createDiv({ cls: "lantern-chat-trace" });
		const ctx: ChatRenderCtx = {
			block,
			statusEl,
			traceEl,
			answerEl: block.createDiv({ cls: "lantern-chat-answer" }),
			streamEl: null,
			reasoningPre: null,
			reasoningOutcome: null,
			reasoningChars: 0,
			usageEl: null,
			footerEl: null,
			question,
			historyBefore: this.chatHistory,
		};
		this.scrollChat(true);
		this.activeChatCtx = ctx;

		try {
			const { messages } = await this.plugin.chat(
				question,
				(event) => this.onAgentEvent(event, ctx),
				this.chatHistory,
				this.chatAbort.signal
			);
			const budget = deriveContextBudget(await this.plugin.resolveContextTokens());
			this.chatHistory = compactHistory(messages.slice(1), budget.compact);
			await this.persistActiveThread();
		} catch (error) {
			ctx.statusEl.remove();
			this.finishReasoning(ctx);
			if (isAbortError(error)) {
				// Keep whatever streamed; just mark the stop. Still offer the per-answer
				// actions (delete / clear trace / retry, + copy if any text streamed) —
				// stopping mid-reasoning should not hide them.
				ctx.answerEl.createDiv({ cls: "lantern-chat-stopped", text: "Stopped." });
				this.fillAnswerActions(this.chatFooter(ctx), {
					answer: ctx.streamEl?.textContent ?? "",
					traceEl: ctx.traceEl,
					onRetry: () => this.rewindAndResend(ctx.block, ctx.question, ctx.historyBefore),
				});
			} else {
				ctx.answerEl.createDiv({
					cls: "lantern-chat-error",
					text: `Error: ${errorMessage(error)} — is the LLM server running at ${this.plugin.settings.llmBaseUrl}?`,
				});
				const actions = ctx.block.createDiv({ cls: "lantern-chat-actions" });
				const retry = actions.createEl("button", { cls: "lantern-chip", text: "Retry" });
				retry.addEventListener("click", () => {
					ctx.block.previousElementSibling?.remove(); // the duplicate user bubble
					ctx.block.remove();
					void this.sendChat(question);
				});
			}
		} finally {
			this.chatBusy = false;
			this.chatAbort = null;
			this.activeChatCtx = null;
			this.updateSendButton();
			this.scrollChat();
		}
	}

	/**
	 * Re-run a turn in place: restore the history to before it, drop this answer
	 * and every later turn (they were built on the old answer), and re-ask. On the
	 * latest answer this is just "redo"; mid-conversation it rewinds to that point.
	 */
	private rewindAndResend(block: HTMLElement, question: string, historyBefore: ChatMessage[]): void {
		if (this.chatBusy || !question) return;
		this.chatHistory = historyBefore;
		const userBubble = block.previousElementSibling;
		for (let sib = block.nextElementSibling; sib; ) {
			const next = sib.nextElementSibling;
			sib.remove();
			sib = next;
		}
		block.remove();
		if (userBubble?.classList.contains("lantern-chat-user")) userBubble.remove();
		this.lastContextFill = null;
		this.renderGlobalMeter();
		void this.sendChat(question);
	}

	/**
	 * Retry a turn from a restored (persisted) transcript: walk back to the user
	 * message that produced this answer, rewind history to just before it, and
	 * re-ask. `index` is the assistant message's position in the stored list.
	 */
	private retryStored(block: HTMLElement, messages: ChatMessage[], index: number): void {
		let userIndex = -1;
		for (let j = index - 1; j >= 0; j--) {
			if (messages[j].role === "user") {
				userIndex = j;
				break;
			}
		}
		if (userIndex < 0) return;
		this.rewindAndResend(block, messages[userIndex].content ?? "", messages.slice(0, userIndex));
	}

	private onAgentEvent(event: AgentEvent, ctx: ChatRenderCtx): void {
		switch (event.type) {
			case "status":
				ctx.statusEl.setText(event.text);
				break;

			case "reasoning_delta": {
				if (!ctx.reasoningPre) {
					const details = ctx.traceEl.createEl("details", { cls: "lantern-tool lantern-reasoning" });
					const summary = details.createEl("summary", { cls: "lantern-tool-summary" });
					setIcon(summary.createSpan({ cls: "lantern-tool-caret" }), "chevron-right");
					setIcon(summary.createSpan({ cls: "lantern-tool-icon" }), "brain");
					summary.createSpan({ cls: "lantern-tool-label", text: "Reasoning" });
					ctx.reasoningOutcome = summary.createSpan({ cls: "lantern-tool-outcome", text: "…" });
					ctx.reasoningPre = details
						.createDiv({ cls: "lantern-tool-body" })
						.createEl("pre", { cls: "lantern-tool-pre lantern-reasoning-pre" });
					ctx.reasoningChars = 0;
				}
				ctx.reasoningChars += event.text.length;
				ctx.reasoningPre.appendText(event.text);
				ctx.reasoningOutcome?.setText(`${formatChars(ctx.reasoningChars)}…`);
				break;
			}

			case "answer_delta": {
				if (!ctx.streamEl) {
					ctx.streamEl = ctx.answerEl.createDiv({ cls: "lantern-chat-stream" });
					ctx.statusEl.setText("Writing…");
				}
				ctx.streamEl.appendText(event.text);
				break;
			}

			case "tool_call": {
				// Any streamed preamble belonged to the tool decision — drop it.
				ctx.streamEl?.remove();
				ctx.streamEl = null;
				this.finishReasoning(ctx);

				// Collapsed by default: a plain-language summary; the raw tool
				// name, arguments and result live inside, shown only when unfolded.
				const details = ctx.traceEl.createEl("details", { cls: "lantern-tool" });
				const summary = details.createEl("summary", { cls: "lantern-tool-summary" });
				setIcon(summary.createSpan({ cls: "lantern-tool-caret" }), "chevron-right");
				setIcon(summary.createSpan({ cls: "lantern-tool-icon" }), toolIconName(event.name));
				summary.createSpan({ cls: "lantern-tool-label", text: friendlyToolLabel(event.name, event.args) });
				summary.createSpan({ cls: "lantern-tool-outcome", text: "…" });

				const body = details.createDiv({ cls: "lantern-tool-body" });
				body.createDiv({ cls: "lantern-tool-tech", text: event.name });
				this.renderToolArgs(body, event.args);
				break;
			}

			case "tool_result": {
				const details = ctx.traceEl.lastElementChild as HTMLElement | null;
				if (!details) break;
				const isError = /^error\b/i.test(event.content.trim());
				const outcome = details.querySelector(".lantern-tool-outcome");
				if (outcome) {
					outcome.setText(toolOutcome(event.name, event.content));
					outcome.classList.toggle("is-error", isError);
				}
				const resultHost = details.querySelector(".lantern-tool-body");
				if (resultHost instanceof HTMLElement) {
					this.renderToolResult(resultHost, event.name, event.content);
				}
				break;
			}

			case "answer": {
				ctx.statusEl.remove();
				this.finishReasoning(ctx);
				ctx.streamEl?.remove();
				ctx.streamEl = null;
				ctx.answerEl.empty();
				// Markdown render is async — re-pin once it has laid out.
				void MarkdownRenderer.render(this.app, event.text || "_(no answer)_", ctx.answerEl, "", this).then(
					() => this.scrollChat()
				);
				this.addAnswerActions(ctx, event.text);
				break;
			}

			case "usage": {
				this.renderUsage(ctx, event);
				this.updateGlobalContext(event);
				break;
			}
		}
		this.scrollChat();
	}

	/** The answer's bottom row (created on demand): context usage left, action icons right. */
	private chatFooter(ctx: ChatRenderCtx): HTMLElement {
		if (!ctx.footerEl) ctx.footerEl = ctx.block.createDiv({ cls: "lantern-chat-footer" });
		return ctx.footerEl;
	}

	/** Per-answer context footer: tokens used vs context (+ cut-off warning). */
	private renderUsage(ctx: ChatRenderCtx, u: Extract<AgentEvent, { type: "usage" }>): void {
		ctx.usageEl?.remove();
		const el = createDiv({ cls: "lantern-chat-usage" });
		this.chatFooter(ctx).prepend(el); // keep usage on the left, regardless of event order
		const pct = u.maxContextTokens > 0 ? Math.round((u.contextTokens / u.maxContextTokens) * 100) : 0;
		const parts = [`peak context ${formatTokens(u.contextTokens)}/${formatTokens(u.maxContextTokens)} · ${pct}%`];
		if (u.completionTokens > 0) parts.push(`${formatTokens(u.completionTokens)} out`);
		el.createSpan({ text: parts.join(" · ") });
		if (u.finishReason === "length") {
			el.createSpan({ cls: "lantern-chat-usage-warn", text: " · ⚠ cut off (context limit)" });
		}
		ctx.usageEl = el;
	}

	/** Track + render the global (per-conversation) context meter in the chat bar. */
	private updateGlobalContext(u: Extract<AgentEvent, { type: "usage" }>): void {
		this.sessionCompletionTokens += u.completionTokens;
		// The persistent conversation footprint (system + tools + compacted
		// history), NOT the per-answer peak — this is what seeds the next
		// question and grows as the chat accumulates. (Peak is shown per-answer.)
		this.lastContextFill = { used: u.basePromptTokens || u.contextTokens, max: u.maxContextTokens };
		this.renderGlobalMeter();
	}

	private renderGlobalMeter(): void {
		const el = this.globalMeterEl;
		if (!el) return;
		const fill = this.lastContextFill;
		if (!fill || fill.max <= 0) {
			el.hide();
			return;
		}
		const pct = Math.round((fill.used / fill.max) * 100);
		el.show();
		el.style.setProperty("--lantern-ctx-pct", String(pct));
		el.toggleClass("is-high", pct >= 80);
		el.setAttr(
			"title",
			`Conversation uses ~${formatTokens(fill.used)} / ${formatTokens(fill.max)} tokens (${pct}%), ` +
				`${formatTokens(Math.max(0, fill.max - fill.used))} free. This is what's carried into your next ` +
				`question (system + tools + history); past turns' tool results are compacted out, so it can dip. ` +
				`${formatTokens(this.sessionCompletionTokens)} generated this chat.`
		);
	}

	/** Mark the current reasoning block as finished (keeps the char count). */
	private finishReasoning(ctx: ChatRenderCtx): void {
		if (ctx.reasoningPre && ctx.reasoningOutcome) {
			ctx.reasoningOutcome.setText(formatChars(ctx.reasoningChars));
		}
		ctx.reasoningPre = null;
		ctx.reasoningOutcome = null;
		ctx.reasoningChars = 0;
	}

	private addAnswerActions(ctx: ChatRenderCtx, answer: string): void {
		if (!answer) return;
		this.fillAnswerActions(this.chatFooter(ctx), {
			answer,
			traceEl: ctx.traceEl,
			onRetry: () => this.rewindAndResend(ctx.block, ctx.question, ctx.historyBefore),
		});
	}

	/**
	 * Render the hover-revealed action icons into an answer's footer row. Shared
	 * by live answers and restored transcripts; the "clear reasoning & tools"
	 * brush is omitted when there is no trace (restored turns don't persist one).
	 */
	private fillAnswerActions(
		footer: HTMLElement,
		opts: { answer: string; traceEl: HTMLElement | null; onRetry: () => void }
	): void {
		const actions = footer.createDiv({ cls: "lantern-chat-actions lantern-actions-hover" });
		const iconBtn = (icon: string, label: string, onClick: () => void): void => {
			const btn = actions.createEl("button", {
				cls: "lantern-chip lantern-icon-chip",
				attr: { "aria-label": label, title: label, type: "button" },
			});
			setIcon(btn, icon);
			btn.addEventListener("click", onClick);
		};

		iconBtn("trash-2", "Delete chat", () => void this.deleteActiveChat());
		if (opts.traceEl) {
			const traceEl = opts.traceEl;
			iconBtn("brush", "Clear reasoning & tools", () => traceEl.empty());
		}
		iconBtn("rotate-ccw", "Retry", opts.onRetry);
		// Copy only when there is text (a stop mid-reasoning may have none).
		if (opts.answer.trim()) {
			iconBtn("copy", "Copy answer", () => {
				navigator.clipboard.writeText(opts.answer).then(
					() => new Notice("Answer copied."),
					() => new Notice("Could not copy to clipboard.")
				);
			});
		}
	}

	// ------------------------------------------------------- trace rendering

	/** Labeled key/value rows for tool-call arguments (JSON pre as fallback). */
	private renderToolArgs(body: HTMLElement, rawArgs: string | undefined): void {
		const trimmed = rawArgs?.trim();
		if (!trimmed || trimmed === "{}") return;
		const args = safeParseArgs(trimmed);
		const entries = Object.entries(args);
		if (entries.length === 0) {
			body.createEl("pre", { cls: "lantern-tool-pre", text: prettyJson(trimmed) });
			return;
		}
		const list = body.createDiv({ cls: "lantern-arg-list" });
		for (const [key, value] of entries) {
			const row = list.createDiv({ cls: "lantern-arg-row" });
			row.createSpan({ cls: "lantern-arg-key", text: key });
			const text = typeof value === "string" ? value : JSON.stringify(value);
			row.createSpan({ cls: "lantern-arg-value", text, attr: { title: text } });
		}
	}

	/** Open a vault note from a trace row (loose resolution, jump to line). */
	private openTracePath(path: string, line?: number): void {
		const real = resolveVaultPath(this.app, path) ?? path;
		const file = this.app.vault.getAbstractFileByPath(real);
		if (!(file instanceof TFile)) {
			new Notice(`File not found in vault: ${path}`);
			return;
		}
		void this.app.workspace
			.getLeaf(false)
			.openFile(file, line ? { eState: { line: Math.max(0, line - 1) } } : undefined);
	}

	/** A clickable note-path link inside the trace. */
	private tracePathLink(parent: HTMLElement, path: string, line?: number, label?: string): void {
		const el = parent.createSpan({ cls: "lantern-trace-path", text: label ?? path, attr: { title: path } });
		el.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			this.openTracePath(path, line);
		});
	}

	/** Structured rendering of meta-tool JSON results; <pre> for everything else. */
	/** Render web_search results as title links + snippets (URLs open in the browser). */
	private renderWebResults(body: HTMLElement, content: string): void {
		let parsed: { results?: Array<{ title?: string; url?: string; snippet?: string; date?: string }> };
		try {
			parsed = JSON.parse(content) as {
				results?: Array<{ title?: string; url?: string; snippet?: string; date?: string }>;
			};
		} catch {
			body.createEl("pre", { cls: "lantern-tool-pre", text: content });
			return;
		}
		const results = Array.isArray(parsed.results) ? parsed.results : [];
		const host = body.createDiv({ cls: "lantern-trace-result" });
		if (results.length === 0) {
			host.createDiv({ cls: "lantern-trace-meta", text: "no results" });
			return;
		}
		for (const r of results) {
			if (!r.url) continue;
			const row = host.createDiv({ cls: "lantern-trace-row" });
			row.createEl("a", {
				cls: "lantern-trace-link",
				text: r.title || r.url,
				attr: { href: r.url, target: "_blank", rel: "noopener" },
			});
			if (r.date) row.createSpan({ cls: "lantern-trace-sub", text: r.date });
			if (r.snippet) host.createDiv({ cls: "lantern-trace-snippet", text: r.snippet });
		}
	}

	private renderToolResult(body: HTMLElement, name: string, content: string): void {
		if (name === "web_search") {
			this.renderWebResults(body, content);
			return;
		}
		const data = parseToolResult(name, content);
		if (!data) {
			body.createEl("pre", { cls: "lantern-tool-pre", text: prettyJson(content) });
			return;
		}
		const host = body.createDiv({ cls: "lantern-trace-result" });

		if (data.kind === "search") {
			if (data.scope) host.createDiv({ cls: "lantern-trace-meta", text: `scope: ${data.scope}` });
			if (data.note) host.createDiv({ cls: "lantern-trace-note", text: data.note });
			if (data.hits.length === 0) host.createDiv({ cls: "lantern-trace-meta", text: "no results" });
			for (const hit of data.hits) this.renderSearchHit(host, hit);
			return;
		}

		if (data.kind === "notes") {
			if (data.notes.length === 0) host.createDiv({ cls: "lantern-trace-meta", text: "no notes" });
			for (const note of data.notes) {
				const row = host.createDiv({ cls: "lantern-trace-row" });
				this.tracePathLink(row, note.path);
				const sub = note.modified ?? (note.title && note.title !== note.path ? note.title : "");
				if (sub) row.createSpan({ cls: "lantern-trace-sub", text: sub });
			}
			if (data.truncated || (data.total !== undefined && data.total > data.notes.length)) {
				host.createDiv({ cls: "lantern-trace-note", text: `…of ${data.total} total` });
			}
			return;
		}

		if (data.kind === "tasks") {
			if (data.total === 0) host.createDiv({ cls: "lantern-trace-meta", text: "no tasks" });
			for (const note of data.notes) {
				const group = host.createDiv({ cls: "lantern-trace-group" });
				const head = group.createDiv({ cls: "lantern-trace-row" });
				this.tracePathLink(head, note.path);
				if (note.modified) head.createSpan({ cls: "lantern-trace-sub", text: note.modified });
				for (const task of note.tasks) {
					const row = group.createDiv({ cls: "lantern-trace-task" });
					row.createSpan({
						cls: `lantern-task-box${task.status === "done" ? " is-done" : ""}`,
						text: task.status === "done" ? "✓" : "○",
					});
					row.createSpan({ cls: "lantern-trace-task-text", text: task.text });
					row.createSpan({ cls: "lantern-trace-badge", text: `L${task.line}` });
				}
			}
			if (data.note) host.createDiv({ cls: "lantern-trace-note", text: data.note });
			return;
		}

		// noteInfo
		const head = host.createDiv({ cls: "lantern-trace-row" });
		this.tracePathLink(head, data.path);
		if (data.properties && Object.keys(data.properties).length > 0) {
			const list = host.createDiv({ cls: "lantern-arg-list" });
			for (const [key, value] of Object.entries(data.properties)) {
				const row = list.createDiv({ cls: "lantern-arg-row" });
				row.createSpan({ cls: "lantern-arg-key", text: key });
				const text = typeof value === "string" ? value : JSON.stringify(value);
				row.createSpan({ cls: "lantern-arg-value", text, attr: { title: text } });
			}
		}
		if (data.tags.length > 0) {
			const tagRow = host.createDiv({ cls: "lantern-trace-tags" });
			for (const tag of data.tags) tagRow.createSpan({ cls: "lantern-trace-tag", text: tag });
		}
		if (data.headings && data.headings.list.length > 0) {
			const sec = host.createDiv({ cls: "lantern-trace-group" });
			sec.createDiv({ cls: "lantern-trace-meta", text: `headings (${data.headings.total})` });
			for (const heading of data.headings.list) {
				sec.createDiv({ cls: "lantern-trace-sub lantern-trace-heading", text: heading });
			}
		}
		for (const [label, links] of [
			["links out", data.linksOut],
			["backlinks", data.backlinks],
		] as const) {
			const sec = host.createDiv({ cls: "lantern-trace-group" });
			sec.createDiv({ cls: "lantern-trace-meta", text: `${label} (${links.total})` });
			for (const path of links.paths) {
				const row = sec.createDiv({ cls: "lantern-trace-row" });
				this.tracePathLink(row, path);
			}
		}
	}

	private renderSearchHit(host: HTMLElement, hit: SearchHitData): void {
		const row = host.createDiv({ cls: "lantern-trace-hit" });
		const top = row.createDiv({ cls: "lantern-trace-row" });
		if (hit.collection) top.createSpan({ cls: "lantern-trace-badge", text: hit.collection });
		if (hit.collection) {
			// Reference doc — opens externally (system app), like a search result.
			const collection = hit.collection;
			const link = top.createSpan({ cls: "lantern-trace-path", text: hit.title, attr: { title: hit.path } });
			link.addEventListener("click", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				void this.openExternalDoc(collection, hit.path);
			});
		} else {
			this.tracePathLink(top, hit.path, hit.line, hit.title);
		}
		top.createSpan({ cls: "lantern-trace-badge", text: hit.score.toFixed(2) });
		if (!hit.collection && hit.path !== hit.title) {
			row.createDiv({ cls: "lantern-trace-sub", text: hit.path });
		}
		if (hit.snippet) row.createDiv({ cls: "lantern-trace-snippet", text: hit.snippet });
	}

	/** Autoscroll, but never yank the view down while the user reads above. */
	/**
	 * Keep the chat pinned to the bottom while sticky. The scroller is
	 * `.lantern-content` (the overflow container) — NOT the transcript div,
	 * which doesn't scroll. `force` re-pins (new question / thread switch).
	 */
	private scrollChat(force = false): void {
		const s = this.contentRootEl;
		if (!s) return;
		if (force) this.stickToBottom = true;
		if (this.stickToBottom) s.scrollTop = s.scrollHeight;
	}
}

function formatChars(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k chars` : `${n} chars`;
}

/** Compact token count: 1234 → "1.2k", 12345 → "12k". */
function formatTokens(n: number): string {
	if (n >= 10000) return `${Math.round(n / 1000)}k`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}
