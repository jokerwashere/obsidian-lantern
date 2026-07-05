// Mock Obsidian API for testing

export class Plugin {
	app: App;
	manifest: PluginManifest;

	constructor(app: App, manifest: PluginManifest) {
		this.app = app;
		this.manifest = manifest;
	}

	addCommand(_command: Command): Command {
		return _command;
	}

	addSettingTab(_settingTab: PluginSettingTab): void {}

	registerView(
		_type: string,
		_viewCreator: (leaf: WorkspaceLeaf) => View
	): void {}

	loadData(): Promise<unknown> {
		return Promise.resolve({});
	}

	saveData(_data: unknown): Promise<void> {
		return Promise.resolve();
	}

	registerEvent(_eventRef: EventRef): void {}
}

export class PluginSettingTab {
	app: App;
	plugin: Plugin;
	containerEl: HTMLElement;

	constructor(app: App, plugin: Plugin) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = document.createElement("div");
	}

	display(): void {}
	hide(): void {}
}

export class ItemView {
	app: App;
	containerEl: HTMLElement;
	contentEl: HTMLElement;
	leaf: WorkspaceLeaf;

	constructor(leaf: WorkspaceLeaf) {
		this.leaf = leaf;
		this.app = leaf.app;
		this.containerEl = document.createElement("div");
		this.contentEl = document.createElement("div");
	}

	getViewType(): string {
		return "";
	}

	getDisplayText(): string {
		return "";
	}

	getIcon(): string {
		return "search";
	}

	onOpen(): Promise<void> {
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		return Promise.resolve();
	}
}

export class Setting {
	settingEl: HTMLElement;
	infoEl: HTMLElement;
	nameEl: HTMLElement;
	descEl: HTMLElement;
	controlEl: HTMLElement;

	constructor(_containerEl: HTMLElement) {
		this.settingEl = document.createElement("div");
		this.infoEl = document.createElement("div");
		this.nameEl = document.createElement("div");
		this.descEl = document.createElement("div");
		this.controlEl = document.createElement("div");
	}

	setName(_name: string): this {
		return this;
	}

	setDesc(_desc: string): this {
		return this;
	}

	addText(_cb: (component: TextComponent) => unknown): this {
		return this;
	}

	addToggle(_cb: (component: ToggleComponent) => unknown): this {
		return this;
	}

	addDropdown(_cb: (component: DropdownComponent) => unknown): this {
		return this;
	}

	addSlider(_cb: (component: SliderComponent) => unknown): this {
		return this;
	}
}

export class TextComponent {
	inputEl: HTMLInputElement;

	constructor(_containerEl: HTMLElement) {
		this.inputEl = document.createElement("input");
	}

	setValue(_value: string): this {
		return this;
	}

	setPlaceholder(_placeholder: string): this {
		return this;
	}

	onChange(_callback: (value: string) => unknown): this {
		return this;
	}
}

export class ToggleComponent {
	toggleEl: HTMLElement;

	constructor(_containerEl: HTMLElement) {
		this.toggleEl = document.createElement("div");
	}

	setValue(_value: boolean): this {
		return this;
	}

	onChange(_callback: (value: boolean) => unknown): this {
		return this;
	}
}

export class DropdownComponent {
	selectEl: HTMLSelectElement;

	constructor(_containerEl: HTMLElement) {
		this.selectEl = document.createElement("select");
	}

	addOption(_value: string, _display: string): this {
		return this;
	}

	setValue(_value: string): this {
		return this;
	}

	onChange(_callback: (value: string) => unknown): this {
		return this;
	}
}

export class SliderComponent {
	sliderEl: HTMLInputElement;

	constructor(_containerEl: HTMLElement) {
		this.sliderEl = document.createElement("input");
	}

	setLimits(_min: number, _max: number, _step: number): this {
		return this;
	}

	setValue(_value: number): this {
		return this;
	}

	setDynamicTooltip(): this {
		return this;
	}

	onChange(_callback: (value: number) => unknown): this {
		return this;
	}
}

export interface App {
	vault: Vault;
	workspace: Workspace;
	metadataCache: MetadataCache;
}

export interface Vault {
	getMarkdownFiles(): TFile[];
	read(file: TFile): Promise<string>;
	cachedRead(file: TFile): Promise<string>;
	adapter: DataAdapter;
	on(name: string, callback: (...args: unknown[]) => unknown): EventRef;
}

export interface DataAdapter {
	getBasePath(): string;
}

export interface Workspace {
	getLeaf(newLeaf?: boolean | string): WorkspaceLeaf;
	revealLeaf(leaf: WorkspaceLeaf): void;
	getLeavesOfType(type: string): WorkspaceLeaf[];
	on(name: string, callback: (...args: unknown[]) => unknown): EventRef;
}

export interface WorkspaceLeaf {
	app: App;
	view: View;
	openFile(file: TFile): Promise<void>;
}

export interface View {
	getViewType(): string;
}

export interface MetadataCache {
	getFileCache(file: TFile): CachedMetadata | null;
	on(name: string, callback: (...args: unknown[]) => unknown): EventRef;
}

export interface CachedMetadata {
	frontmatter?: Record<string, unknown>;
}

export interface TFile {
	path: string;
	name: string;
	basename: string;
	extension: string;
	stat: {
		mtime: number;
		ctime: number;
		size: number;
	};
}

export interface TAbstractFile {
	path: string;
	name: string;
}

export interface PluginManifest {
	id: string;
	name: string;
	version: string;
}

export interface Command {
	id: string;
	name: string;
	callback?: () => unknown;
	checkCallback?: (checking: boolean) => boolean | void;
}

export interface EventRef {
	// Empty interface for event references
}

export function debounce<T extends (...args: unknown[]) => unknown>(
	func: T,
	wait: number,
	_immediate?: boolean
): T {
	let timeout: NodeJS.Timeout | null = null;
	return function (this: unknown, ...args: unknown[]) {
		if (timeout) clearTimeout(timeout);
		timeout = setTimeout(() => func.apply(this, args), wait);
	} as T;
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

// The obsidian package re-exports moment; tests use the real library
// (a transitive dependency of the obsidian typings package).
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const moment = require("moment");

/**
 * Minimal WORKING requestUrl built on Node http(s) so live/E2E tests can hit
 * real local servers. Unit-test files that need canned responses override
 * this with their own vi.mock("obsidian", …).
 */
export async function requestUrl(params: {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	throw?: boolean;
}): Promise<{ status: number; text: string; json: unknown; headers: Record<string, string> }> {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const http = require("http") as typeof import("http");
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const https = require("https") as typeof import("https");
	const url = new URL(params.url);
	const lib = url.protocol === "https:" ? https : http;

	return new Promise((resolve, reject) => {
		const req = lib.request(
			url,
			{ method: params.method ?? "GET", headers: params.headers, agent: false },
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (c: string) => (text += c));
				res.on("end", () => {
					let json: unknown = undefined;
					try {
						json = JSON.parse(text);
					} catch {
						/* non-JSON body */
					}
					const status = res.statusCode ?? 0;
					if (params.throw !== false && status >= 400) {
						reject(new Error(`Request failed, status ${status}`));
						return;
					}
					resolve({ status, text, json, headers: {} });
				});
			}
		);
		req.on("error", reject);
		req.end(params.body);
	});
}
