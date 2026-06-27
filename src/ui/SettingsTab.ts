/**
 * Settings tab for the lantern-backed plugin.
 *
 * Layout: a status overview card at the top (qmd daemon + LLM server, with
 * one-click tests), then grouped sections for connection, indexing, search,
 * and chat. Styling is scoped under `.lantern-settings` so it never leaks into
 * other plugins' settings.
 */

import {
	App,
	ExtraButtonComponent,
	Menu,
	Notice,
	normalizePath,
	PluginSettingTab,
	Setting,
	TextAreaComponent,
	TextComponent,
	TFile,
} from "obsidian";
import type { ReasoningEffort } from "../agent/LlmClient";
import { DEFAULT_SYSTEM_PROMPT } from "../agent/AgentLoop";
import { PROMPT_DEFS, resolvePrompt, missingPlaceholders, type PromptDef } from "../agent/promptRegistry";
import { isValidCollectionName } from "../settings";
import type LanternPlugin from "../main";

type StatState = "idle" | "checking" | "ok" | "fail";

interface StatRow {
	button: HTMLButtonElement;
	set(state: StatState, detail: string): void;
}

export class LanternSettingTab extends PluginSettingTab {
	plugin: LanternPlugin;

	/** Re-probe the qmd overview row; set while the overview is mounted. */
	private refreshQmdStat: (() => Promise<void>) | null = null;
	/** Status line under the system-prompt-note setting. */
	private promptStatusEl: HTMLElement | null = null;
	/** Which screen is showing: the main tab, or a sub-editor reached via a button. */
	private screen: "main" | "prompts" | "templates" = "main";

	constructor(app: App, plugin: LanternPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("lantern-settings");
		if (this.screen === "prompts") return void this.renderPromptsScreen(containerEl);
		if (this.screen === "templates") return void this.renderTemplatesScreen(containerEl);
		this.renderMain(containerEl);
	}

	/** Reset to the main screen when the settings tab is (re)opened. */
	hide(): void {
		this.screen = "main";
	}

	/** Switch screen and re-render — scrolling to the top so a sub-screen never
	 *  inherits the scroll offset of the button that opened it. */
	private goToScreen(screen: "main" | "prompts" | "templates"): void {
		this.screen = screen;
		this.display();
		this.containerEl.scrollTop = 0;
	}

	/** The main settings screen — everything except the prompt + chat-template editors. */
	private renderMain(containerEl: HTMLElement): void {
		this.renderOverview(containerEl);

		// ---- qmd connection ----
		this.section(containerEl, "qmd connection", "How the plugin reaches and drives your local qmd.");

		new Setting(containerEl)
			.setName("qmd binary path")
			.setDesc('Path to the qmd executable. Use a full path if "qmd" is not on Obsidian\'s PATH.')
			.addText((text) =>
				text
					.setPlaceholder("qmd")
					.setValue(this.plugin.settings.qmdBinaryPath)
					.onChange(async (value) => {
						this.plugin.settings.qmdBinaryPath = value.trim() || "qmd";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Daemon port")
			.setDesc("Port for qmd's HTTP server (qmd default: 8181).")
			.addText((text) =>
				this.numberInput(text, this.plugin.settings.qmdPort, 1, 65535, async (port) => {
					this.plugin.settings.qmdPort = port;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Auto-start daemon")
			.setDesc("Start the qmd HTTP daemon automatically if it isn't already running.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoStartDaemon).onChange(async (value) => {
					this.plugin.settings.autoStartDaemon = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Stop daemon on unload")
			.setDesc("Stop the qmd daemon when the plugin unloads (off keeps it warm for next time).")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.stopDaemonOnUnload).onChange(async (value) => {
					this.plugin.settings.stopDaemonOnUnload = value;
					await this.plugin.saveSettings();
				})
			);

		// ---- Indexing ----
		this.section(containerEl, "Indexing", "Register this vault as a qmd collection and keep it fresh.");

		new Setting(containerEl)
			.setName("Vault collection name")
			.setDesc("Name of the qmd collection that mirrors this vault (letters/digits, then letters/digits/._-).")
			.addText((text) =>
				text.setValue(this.plugin.settings.vaultCollection).onChange(async (value) => {
					const name = value.trim();
					const valid = isValidCollectionName(name);
					text.inputEl.toggleClass("lantern-input-invalid", !valid);
					if (!valid) return; // keep the last valid value until fixed
					this.plugin.settings.vaultCollection = name;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Auto-update on change")
			.setDesc("Re-index the vault in qmd after file changes (debounced 30 s; qmd re-scans all collections).")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoUpdateOnChange).onChange(async (value) => {
					this.plugin.settings.autoUpdateOnChange = value;
					await this.plugin.saveSettings(); // re-registers file events live
				})
			);

		new Setting(containerEl)
			.setName("Register / update")
			.setDesc("Register this vault as a qmd collection, or refresh its index and embeddings.")
			.addButton((button) =>
				button.setButtonText("Register vault").onClick(async () => {
					button.setDisabled(true);
					await this.plugin.registerVault();
					button.setDisabled(false);
					void this.refreshQmdStat?.();
				})
			)
			.addButton((button) =>
				button.setButtonText("Update index").onClick(async () => {
					button.setDisabled(true);
					await this.plugin.updateIndex();
					button.setDisabled(false);
					void this.refreshQmdStat?.();
				})
			);

		// ---- Search ----
		this.section(containerEl, "Search", "How results are retrieved and ranked.");

		new Setting(containerEl)
			.setName("Default to hybrid search")
			.setDesc("Use text + semantic search by default (off = text-only / BM25).")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.defaultSemantic).onChange(async (value) => {
					this.plugin.settings.defaultSemantic = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Rerank results")
			.setDesc("Use qmd's cross-encoder reranker (Qwen3-Reranker) — higher precision, ~2–4s per query.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.rerank).onChange(async (value) => {
					this.plugin.settings.rerank = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Minimum relevance score")
			.setDesc("Hide results below this score (0–0.7).")
			.addSlider((slider) =>
				slider
					.setLimits(0, 0.7, 0.05)
					.setValue(this.plugin.settings.minScore)					.onChange(async (value) => {
						this.plugin.settings.minScore = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Results per page")
			.setDesc("Number of results to request (5–50).")
			.addText((text) =>
				this.numberInput(text, this.plugin.settings.resultsPerPage, 5, 50, async (num) => {
					this.plugin.settings.resultsPerPage = num;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Search intent")
			.setDesc("Optional context sent with every query to disambiguate results (e.g. 'my personal notes, not code docs').")
			.addText((text) =>
				text
					.setPlaceholder("(none)")
					.setValue(this.plugin.settings.searchIntent)
					.onChange(async (value) => {
						this.plugin.settings.searchIntent = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Vault context")
			.setDesc(
				"A short description of what this vault holds, attached to the qmd collection to improve ranking " +
				"(e.g. 'Personal notes: projects, daily journal, meeting notes, reference clippings'). " +
				"Saved here; click Apply to push it to qmd. Empty + Apply clears it."
			)
			.addTextArea((text) =>
				text
					.setPlaceholder("Personal notes: projects, daily journal, meeting notes…")
					.setValue(this.plugin.settings.vaultContext)
					.onChange(async (value) => {
						this.plugin.settings.vaultContext = value;
						await this.plugin.saveSettings();
					})
			)
			.addButton((button) =>
				button.setButtonText("Apply").onClick(async () => {
					button.setDisabled(true);
					await this.plugin.applyVaultContext();
					button.setDisabled(false);
					void this.refreshQmdStat?.();
				})
			);

		let collText: TextComponent;
		const refreshColls = (): void => {
			collText.setValue(this.plugin.settings.searchExternalCollections.join(", "));
		};
		new Setting(containerEl)
			.setName("Also search collections")
			.setDesc(
				"qmd collections to search alongside your vault. Click the list icon to pick from qmd's collections; the choice is shown read-only here. (In chat, the library chip toggles these per conversation.)"
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("list")
					.setTooltip("Pick from qmd's collections")
					.onClick(() => {
						void (async () => {
							const available = await this.plugin.listQmdCollections();
							const vault = this.plugin.settings.vaultCollection;
							// Offer every qmd collection except the vault, plus any already-selected
							// (possibly stale) name so it stays visible/removable.
							const options = Array.from(
								new Set([...available, ...this.plugin.settings.searchExternalCollections])
							)
								.filter((c) => c && c !== vault)
								.sort((a, b) => a.localeCompare(b));
							if (options.length === 0) {
								new Notice("Lantern: qmd reports no other collections besides this vault.");
								return;
							}
							this.showCollectionsMenu(btn.extraSettingsEl, options, refreshColls);
						})();
					})
			)
			.addText((text) => {
				collText = text;
				text.inputEl.readOnly = true;
				text.inputEl.addClass("lantern-readonly-input");
				text.setPlaceholder("(none — click the list icon)").setValue(this.plugin.settings.searchExternalCollections.join(", "));
			});

		// ---- Chat (local LLM) ----
		this.section(containerEl, "Chat (local LLM)", "Local LLM that answers questions grounded in your notes.");

		new Setting(containerEl)
			.setName("LLM base URL")
			.setDesc('OpenAI-compatible endpoint incl. path. llama-server: http://localhost:8080/v1 (run it with --jinja for tool calling). LM Studio: http://localhost:1234/v1.')
			.addText((text) =>
				text
					.setPlaceholder("http://localhost:8080/v1")
					.setValue(this.plugin.settings.llmBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.llmBaseUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		let modelText: TextComponent;
		new Setting(containerEl)
			.setName("Model")
			.setDesc("Model name. Required by multi-model servers (llama-server router, LM Studio); single-model llama-server ignores it. Empty = auto-pick from the server's model list.")
			.addExtraButton((btn) =>
				btn
					.setIcon("list")
					.setTooltip("Pick from the server's model list")
					.onClick(async () => {
						const models = await this.plugin.listLlmModelStatuses();
						if (models.length === 0) {
							new Notice("Lantern: the LLM server reported no models (is it running?).");
							return;
						}
						const menu = new Menu();
						for (const { id, state } of models) {
							// Show the load state (router mode) so a cold pick is no surprise.
							const title = state === "unknown" ? id : `${id}  —  ${state}`;
							menu.addItem((item) =>
								item
									.setTitle(title)
									.setChecked(id === this.plugin.settings.llmModel)
									.onClick(async () => {
										this.plugin.settings.llmModel = id;
										modelText.setValue(id);
										await this.plugin.saveSettings();
									})
							);
						}
						const rect = btn.extraSettingsEl.getBoundingClientRect();
						menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
					})
			)
			.addText((text) => {
				modelText = text;
				text
					.setPlaceholder("(auto)")
					.setValue(this.plugin.settings.llmModel)
					.onChange(async (value) => {
						this.plugin.settings.llmModel = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Optional — local servers usually ignore it.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(this.plugin.settings.llmApiKey).onChange(async (value) => {
					this.plugin.settings.llmApiKey = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Context size")
			.setDesc(
				"LLM context window in tokens. 0 = auto-detect from the server (llama-server reports it; router mode is read from the model's launch args). Set it manually for servers that don't report it (e.g. LM Studio). Lantern sizes its tool-result budget and history compaction to fit."
			)
			.addText((text) =>
				this.numberInput(text, this.plugin.settings.llmContextSize, 0, 1048576, async (n) => {
					this.plugin.settings.llmContextSize = n;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Temperature")
			.setDesc("Sampling temperature (0 = focused, 2 = wild; OpenAI-compatible range).")
			.addSlider((slider) =>
				slider
					.setLimits(0, 2, 0.05)
					.setValue(this.plugin.settings.llmTemperature)					.onChange(async (value) => {
						this.plugin.settings.llmTemperature = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default reasoning effort")
			.setDesc("Thinking strength for chat (also switchable per-question from the chat bar). Higher = more deliberate but slower; needs a reasoning-capable model.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ off: "Off", low: "Low", medium: "Medium", high: "High" })
					.setValue(this.plugin.settings.reasoningEffort)
					.onChange(async (value) => {
						this.plugin.settings.reasoningEffort = value as ReasoningEffort;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Pass reasoning back during tool use")
			.setDesc("Re-send each step's reasoning to the model within a question (llama.cpp webui default; Qwen/GLM/Kimi-style templates need it). Turn off to save context with models that ignore it (e.g. DeepSeek-R1).")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.passReasoningBack).onChange(async (value) => {
					this.plugin.settings.passReasoningBack = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Max tool iterations")
			.setDesc("How many search/read steps the agent may take per question (1–20).")
			.addText((text) =>
				this.numberInput(text, this.plugin.settings.agentMaxIterations, 1, 20, async (n) => {
					this.plugin.settings.agentMaxIterations = n;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Agent search results")
			.setDesc("Results per search_vault call (2–20). Small keeps a local model's context lean; the Search pane has its own page size.")
			.addText((text) =>
				this.numberInput(text, this.plugin.settings.agentSearchLimit, 2, 20, async (n) => {
					this.plugin.settings.agentSearchLimit = n;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Agent minimum score")
			.setDesc("Relevance floor for the agent's search_vault calls (0–0.7). Lower than the Search pane's, so the agent sees more candidates to read and filter.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 0.7, 0.05)
					.setValue(this.plugin.settings.agentMinScore)					.onChange(async (value) => {
						this.plugin.settings.agentMinScore = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max file read size")
			.setDesc("UTF-8 bytes the read_file tool returns before truncating (1000–50000). Larger = more context per file, more tokens.")
			.addText((text) =>
				this.numberInput(text, this.plugin.settings.agentMaxReadBytes, 1000, 50000, async (n) => {
					this.plugin.settings.agentMaxReadBytes = n;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Persist chat threads")
			.setDesc("Save conversations to disk and restore them across reloads (a Previous-chats menu appears in the chat bar; the + button starts a new one). Off = chats stay in memory only.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.persistChatThreads).onChange(async (value) => {
					this.plugin.settings.persistChatThreads = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Max persisted chats")
			.setDesc("How many chats to keep on disk (0 = unlimited). When over the limit, the chats with the oldest last interaction are removed first.")
			.addText((text) =>
				this.numberInput(text, this.plugin.settings.maxPersistedThreads, 0, 1000, async (n) => {
					this.plugin.settings.maxPersistedThreads = n;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Chat templates")
			.setDesc("Reusable chat prompts for the ⚡ menu in the chat bar ({{date}} = today). Edit them on a separate screen.")
			.addButton((button) =>
				button.setButtonText("Edit chat templates…").onClick(() => this.goToScreen("templates"))
			);

		// ---- Web search (Perplexity / Exa, gated) ----
		this.section(
			containerEl,
			"Web search",
			"Let the agent search the public web when the vault can't answer. Off by default — enabling it sends queries (derived from your notes) to the selected provider's servers. Search only: results are returned for the local model to read and cite; pages are never fetched."
		);

		new Setting(containerEl)
			.setName("Enable web search")
			.setDesc("Adds a web_search tool. The agent searches your vault first and reaches the web only when the answer needs current or outside information.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableWebSearch).onChange(async (value) => {
					this.plugin.settings.enableWebSearch = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Search provider")
			.setDesc("Perplexity (API key required) or Exa (API key optional — without one it uses Exa's free keyless endpoint). The Test button checks the selected provider.")
			.addDropdown((dd) =>
				dd
					.addOption("perplexity", "Perplexity")
					.addOption("exa", "Exa")
					.setValue(this.plugin.settings.webSearchProvider)
					.onChange(async (value) => {
						this.plugin.settings.webSearchProvider = value === "exa" ? "exa" : "perplexity";
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("plug-zap")
					.setTooltip("Test the selected provider (uses one request)")
					.onClick(async () => {
						new Notice("Lantern: testing web search…");
						new Notice(`Lantern: ${await this.plugin.testWebSearch()}`);
					})
			);

		new Setting(containerEl)
			.setName("Perplexity API key")
			.setDesc("From perplexity.ai → Settings → API. A Pro subscription is NOT API access — it includes a $5/month API credit, then pay-as-you-go. Stored in this vault's plugin data.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("pplx-…")
					.setValue(this.plugin.settings.perplexityApiKey)
					.onChange(async (value) => {
						this.plugin.settings.perplexityApiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Exa API key (optional)")
			.setDesc("From exa.ai → Dashboard → API Keys. Optional: leave blank to use Exa's free keyless endpoint (rate-limited); a key raises the limits. Stored in this vault's plugin data.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("blank = free keyless")
					.setValue(this.plugin.settings.exaApiKey)
					.onChange(async (value) => {
						this.plugin.settings.exaApiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Web results per search")
			.setDesc("How many results web_search requests (1–20). Fewer = leaner context and lower cost.")
			.addText((text) =>
				this.numberInput(text, this.plugin.settings.webSearchMaxResults, 1, 20, async (n) => {
					this.plugin.settings.webSearchMaxResults = n;
					await this.plugin.saveSettings();
				})
			);

		// ---- Write tools (gated) ----
		this.section(
			containerEl,
			"Write tools",
			"Let the agent capture notes for you. Every write shows an Apply/Deny card in the chat before anything is changed."
		);

		new Setting(containerEl)
			.setName("Enable write tools")
			.setDesc("Adds create_note (inbox folder only) and append_to_daily_note to the agent. Off = the agent stays strictly read-only.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableWriteTools).onChange(async (value) => {
					this.plugin.settings.enableWriteTools = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Inbox folder")
			.setDesc("The only folder create_note may write into (created on first use).")
			.addText((text) =>
				text
					.setPlaceholder("Lantern Inbox")
					.setValue(this.plugin.settings.inboxFolder)
					.onChange(async (value) => {
						this.plugin.settings.inboxFolder = value.trim() || "Lantern Inbox";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Prompts")
			.setDesc(
				"Tune the agent's prompts — the system prompt plus the gated appendices (web / write / references), the date-context and final-answer messages — each editable and resettable to the bundled default. Includes the optional system-prompt note. Edit them on a separate screen."
			)
			.addButton((button) =>
				button.setButtonText("Edit prompts…").onClick(() => this.goToScreen("prompts"))
			);
	}

	/** The system-prompt NOTE row (overrides the inline System prompt when set). */
	private renderSystemPromptNoteSetting(containerEl: HTMLElement): void {
		let promptNoteText: TextComponent;
		new Setting(containerEl)
			.setName("System prompt note")
			.setDesc(
				"Optional: a vault note whose contents REPLACE the System prompt above (read fresh on every question, so you can edit it in Obsidian). Empty = use the System prompt editor / built-in. Takes precedence over the inline editor."
			)
			.addText((text) => {
				promptNoteText = text;
				text
					.setPlaceholder("e.g. Lantern/System Prompt.md")
					.setValue(this.plugin.settings.systemPromptNote)
					.onChange(async (value) => {
						this.plugin.settings.systemPromptNote = value.trim();
						await this.plugin.saveSettings();
						this.refreshPromptStatus();
					});
			})
			.addExtraButton((btn) =>
				btn
					.setIcon("pencil")
					.setTooltip("Open the note")
					.onClick(() => this.openPromptNote())
			)
			.addExtraButton((btn) =>
				btn
					.setIcon("file-plus")
					.setTooltip("Create the note, seeded with the built-in prompt")
					.onClick(() => {
						void this.createPromptNote((path) => {
							promptNoteText.setValue(path);
						});
					})
			);
		this.promptStatusEl = containerEl.createDiv({ cls: "lantern-prompt-status setting-item-description" });
		this.refreshPromptStatus();
	}

	/** A "← Back to settings" link that returns to the main screen. */
	private renderBackLink(containerEl: HTMLElement): void {
		const back = containerEl.createEl("a", {
			cls: "lantern-settings-back",
			text: "← Back to settings",
			attr: { role: "button", tabindex: "0" },
		});
		const go = () => this.goToScreen("main");
		back.addEventListener("click", (e) => {
			e.preventDefault();
			go();
		});
		back.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				go();
			}
		});
	}

	/** Sub-screen: per-prompt editors (overrides-only) + the system-prompt note. */
	private renderPromptsScreen(containerEl: HTMLElement): void {
		this.renderBackLink(containerEl);
		this.section(
			containerEl,
			"Edit prompts",
			"Blank = use the bundled default (so untouched prompts keep improving with updates). Edits are saved as overrides; the reset button restores the bundled default. Keep any {{placeholders}} noted below each prompt."
		);
		for (const def of PROMPT_DEFS) this.renderPromptEditor(containerEl, def);
		this.section(containerEl, "System prompt note", "An alternative way to set the system prompt (overrides the editor above).");
		this.renderSystemPromptNoteSetting(containerEl);
	}

	/** Sub-screen: the chat-template editor. */
	private renderTemplatesScreen(containerEl: HTMLElement): void {
		this.renderBackLink(containerEl);
		this.renderTemplateEditor(containerEl);
	}

	/** One prompt's editor: label (+ customized flag), description, reset, textarea, placeholder warning. */
	private renderPromptEditor(containerEl: HTMLElement, def: PromptDef): void {
		const overrides = this.plugin.settings.promptOverrides;
		const isCustomized = () => (overrides[def.id]?.trim().length ?? 0) > 0;

		// One block per prompt so the textarea + warning are visibly separated from
		// the next prompt's header.
		const block = containerEl.createDiv({ cls: "lantern-prompt-block" });
		let resetBtn: ExtraButtonComponent;
		const setting = new Setting(block)
			.setDesc(def.description)
			.addExtraButton((btn) => {
				resetBtn = btn;
				btn
					.setIcon("rotate-ccw")
					.setTooltip("Reset to the bundled default")
					.onClick(async () => {
						delete overrides[def.id];
						await this.plugin.saveSettings();
						this.display(); // re-render: textarea reverts to bundled + flag clears
					});
			});

		// Live affordance: label "· customized" + Reset enabled track the override.
		const updateAffordance = () => {
			const customized = isCustomized();
			setting.setName(customized ? `${def.label} · customized` : def.label);
			resetBtn.setDisabled(!customized);
		};
		updateAffordance();

		const area = new TextAreaComponent(block);
		area.setValue(resolvePrompt(def.id, overrides)); // override if set, else bundled
		area.inputEl.rows = 12;
		area.inputEl.addClass("lantern-prompt-editor");

		const warn = block.createDiv({ cls: "lantern-prompt-status setting-item-description" });
		const refreshWarn = (text: string) => {
			warn.empty();
			const missing = missingPlaceholders(def.id, text);
			if (missing.length > 0) {
				warn.createSpan({
					cls: "lantern-prompt-missing",
					text: `Missing placeholder(s): ${missing.join(", ")} — the feature may not work without them.`,
				});
			} else if (def.placeholders.length > 0) {
				warn.setText(`Keep these placeholders: ${def.placeholders.join(", ")}.`);
			}
		};
		refreshWarn(area.getValue());

		area.onChange(async (value) => {
			// Blank reverts to the bundled default (overrides-only); else save the override.
			if (value.trim().length === 0) delete overrides[def.id];
			else overrides[def.id] = value;
			await this.plugin.saveSettings();
			refreshWarn(value.trim().length === 0 ? def.bundled : value);
			updateAffordance(); // reflect customized/Reset state without a re-render
		});
	}

	/** Update the status line under the system-prompt-note setting. */
	private refreshPromptStatus(): void {
		if (!this.promptStatusEl) return;
		this.promptStatusEl.empty();
		const path = this.plugin.settings.systemPromptNote.trim();
		if (!path) {
			this.promptStatusEl.setText("Using the built-in prompt.");
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (file instanceof TFile) {
			this.promptStatusEl.setText(`Using ${path} — replaces the built-in prompt.`);
		} else {
			this.promptStatusEl.createSpan({
				cls: "lantern-prompt-missing",
				text: `"${path}" not found — using the built-in prompt. Click + to create it.`,
			});
		}
	}

	/** Open the configured system-prompt note (if it exists). */
	private async openPromptNote(): Promise<void> {
		const path = this.plugin.settings.systemPromptNote.trim();
		const file = path ? this.app.vault.getAbstractFileByPath(normalizePath(path)) : null;
		if (file instanceof TFile) {
			await this.app.workspace.getLeaf(true).openFile(file);
		} else {
			new Notice(
				path
					? `"${path}" doesn't exist yet — use the + button to create it.`
					: "Set a note path first, or click + to create one."
			);
		}
	}

	/** Create the system-prompt note seeded with the built-in default, then open it. */
	private async createPromptNote(onPath: (path: string) => void): Promise<void> {
		let path = this.plugin.settings.systemPromptNote.trim() || "Lantern/System Prompt.md";
		if (!/\.md$/i.test(path)) path += ".md";
		path = normalizePath(path);

		let file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			const slash = path.lastIndexOf("/");
			const folder = slash > 0 ? path.slice(0, slash) : "";
			if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
				try {
					await this.app.vault.createFolder(folder);
				} catch {
					/* folder may already exist */
				}
			}
			file = await this.app.vault.create(path, `${DEFAULT_SYSTEM_PROMPT}\n`);
		}
		this.plugin.settings.systemPromptNote = path;
		await this.plugin.saveSettings();
		onPath(path);
		this.refreshPromptStatus();
		if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
		new Notice(`Lantern: system-prompt note ready at ${path}.`);
	}

	/** A section header (accented title + sub-description), scoped to this tab. */
	private section(containerEl: HTMLElement, title: string, desc: string): void {
		new Setting(containerEl).setName(title).setDesc(desc).setHeading();
	}

	/**
	 * Multi-select menu of qmd collections (options fetched once by the caller).
	 * Toggling a collection updates searchExternalCollections and reopens the menu
	 * so several can be picked without reopening each time. The vault collection is
	 * never included (it is always searched).
	 */
	private showCollectionsMenu(anchor: HTMLElement, options: string[], onChange: () => void): void {
		const selected = new Set(this.plugin.settings.searchExternalCollections);
		const vault = this.plugin.settings.vaultCollection;
		const menu = new Menu();
		for (const name of options) {
			menu.addItem((item) =>
				item
					.setTitle(name)
					.setChecked(selected.has(name))
					.onClick(async () => {
						const set = new Set(this.plugin.settings.searchExternalCollections);
						if (set.has(name)) set.delete(name);
						else set.add(name);
						this.plugin.settings.searchExternalCollections = [...set].filter((c) => c && c !== vault);
						await this.plugin.saveSettings();
						onChange();
						this.showCollectionsMenu(anchor, options, onChange); // reopen for multi-select
					})
			);
		}
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
	}

	/** Editable list of chat prompt templates ({{date}} → today at insert time). */
	private renderTemplateEditor(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Chat templates")
			.setDesc("Reusable chat prompts, available from the ⚡ menu in the chat bar. {{date}} becomes today's date.")
			.addButton((button) =>
				button.setButtonText("Add template").onClick(async () => {
					this.plugin.settings.chatTemplates.push({ name: "New template", prompt: "" });
					await this.plugin.saveSettings();
					this.display(); // re-render the rows
				})
			);

		// Custom two-column layout (not a Setting row): delete button pinned
		// top-left in its own column, name + prompt fields stacked on the right.
		this.plugin.settings.chatTemplates.forEach((template, index) => {
			const row = containerEl.createDiv({ cls: "lantern-template-row" });

			const delCol = row.createDiv({ cls: "lantern-template-delete" });
			new ExtraButtonComponent(delCol)
				.setIcon("trash-2")
				.setTooltip("Remove template")
				.onClick(async () => {
					this.plugin.settings.chatTemplates.splice(index, 1);
					await this.plugin.saveSettings();
					this.display();
				});

			const fields = row.createDiv({ cls: "lantern-template-fields" });
			const name = new TextComponent(fields);
			name
				.setPlaceholder("Name")
				.setValue(template.name)
				.onChange(async (value) => {
					template.name = value;
					await this.plugin.saveSettings();
				});
			name.inputEl.addClass("lantern-template-name");

			const area = new TextAreaComponent(fields);
			area
				.setPlaceholder("Prompt… ({{date}} = today)")
				.setValue(template.prompt)
				.onChange(async (value) => {
					template.prompt = value;
					await this.plugin.saveSettings();
				});
			area.inputEl.rows = 3;
			area.inputEl.addClass("lantern-template-prompt");
		});
	}

	/**
	 * Numeric text input that CLAMPS out-of-range values instead of silently
	 * ignoring them. Over-max clamps immediately; under-min waits for blur so
	 * multi-digit values can still be typed (e.g. "5000" with min 1000).
	 */
	private numberInput(
		text: TextComponent,
		initial: number,
		min: number,
		max: number,
		apply: (value: number) => Promise<void>
	): void {
		text.inputEl.type = "number";
		text.setValue(String(initial)).onChange(async (value) => {
			const parsed = parseInt(value, 10);
			if (isNaN(parsed)) return; // still typing
			if (parsed > max) {
				text.setValue(String(max));
				await apply(max);
			} else if (parsed >= min) {
				await apply(parsed);
			} // below min: wait for blur
		});
		text.inputEl.addEventListener("blur", () => {
			void (async () => {
				const parsed = parseInt(text.inputEl.value, 10);
				if (isNaN(parsed) || parsed < min) {
					const fallback = isNaN(parsed) ? Math.min(max, Math.max(min, initial)) : min;
					text.setValue(String(fallback));
					await apply(fallback);
				}
			})();
		});
	}

	/** Render the top status overview: qmd daemon + LLM server, each testable. */
	private renderOverview(containerEl: HTMLElement): void {
		const card = containerEl.createDiv({ cls: "lantern-overview" });

		// --- qmd daemon ---
		const qmd = this.statRow(card, "qmd daemon", "Test");
		const checkQmd = async (): Promise<void> => {
			qmd.set("checking", "Checking…");
			const running = await this.plugin.isDaemonRunning();
			if (!running) {
				qmd.set("fail", `Not reachable on port ${this.plugin.settings.qmdPort}`);
				return;
			}
			const indexed = await this.plugin.isVaultIndexed();
			qmd.set(
				"ok",
				`Running on port ${this.plugin.settings.qmdPort} · ${indexed ? "vault indexed" : "vault not registered"}`
			);
		};
		qmd.button.addEventListener("click", () => void checkQmd());
		this.refreshQmdStat = checkQmd;

		// --- LLM server ---
		const llm = this.statRow(card, "LLM server", "Test");
		llm.set("idle", hostLabel(this.plugin.settings.llmBaseUrl));
		const testLlm = async (): Promise<void> => {
			llm.set("checking", "Sending a test message…");
			const msg = await this.plugin.testLlm();
			llm.set(msg.startsWith("✓") ? "ok" : "fail", msg.replace(/^[✓✗]\s*/, ""));
		};
		llm.button.addEventListener("click", () => void testLlm());

		// Cheap auto-probe on open: qmd /health and LLM /models (no model load).
		void checkQmd();
		void (async () => {
			llm.set("checking", "Checking…");
			const ping = await this.plugin.pingLlm();
			llm.set(ping.ok ? "ok" : "fail", ping.detail);
		})();
	}

	/** Build one status row (dot + label + detail + action button). */
	private statRow(parent: HTMLElement, label: string, buttonText: string): StatRow {
		const row = parent.createDiv({ cls: "lantern-stat" });
		const dot = row.createSpan({ cls: "lantern-stat-dot is-idle" });
		const text = row.createDiv({ cls: "lantern-stat-text" });
		text.createDiv({ cls: "lantern-stat-label", text: label });
		const detail = text.createDiv({ cls: "lantern-stat-detail", text: "—" });
		const button = row.createEl("button", { cls: "lantern-stat-btn", text: buttonText });

		return {
			button,
			set(state: StatState, detailText: string): void {
				dot.className = `lantern-stat-dot is-${state}`;
				detail.setText(detailText);
				detail.title = detailText;
			},
		};
	}
}

/** Compact "host:port" label from a base URL, falling back to the raw string. */
function hostLabel(url: string): string {
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}
