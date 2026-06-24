/**
 * Daily-note resolution from Obsidian's CORE daily-notes plugin config.
 *
 * The config lives at `<configDir>/daily-notes.json` with optional `folder`
 * and `format` (moment format) keys; Obsidian's defaults are the vault root
 * and "YYYY-MM-DD" (verified against this machine's vault config, which sets
 * only `folder`). Periodic-Notes-plugin formats are out of scope.
 */

import { moment, type App } from "obsidian";

export interface DailyNotesConfig {
	folder: string;
	format: string;
}

export const DEFAULT_DAILY_FORMAT = "YYYY-MM-DD";

/** Parse the JSON text of daily-notes.json (tolerant of junk/missing keys). */
export function parseDailyNotesConfig(jsonText: string | null): DailyNotesConfig {
	let folder = "";
	let format = DEFAULT_DAILY_FORMAT;
	if (jsonText) {
		try {
			const parsed = JSON.parse(jsonText) as { folder?: unknown; format?: unknown };
			if (typeof parsed.folder === "string") folder = parsed.folder;
			if (typeof parsed.format === "string" && parsed.format.trim()) format = parsed.format;
		} catch {
			/* corrupt config → defaults */
		}
	}
	return { folder: folder.replace(/^\/+|\/+$/g, ""), format };
}

/** Read the core daily-notes config ({} defaults when absent/unreadable). */
export async function readDailyNotesConfig(app: App): Promise<DailyNotesConfig> {
	const path = `${app.vault.configDir}/daily-notes.json`;
	try {
		return parseDailyNotesConfig(await app.vault.adapter.read(path));
	} catch {
		return parseDailyNotesConfig(null);
	}
}

/** Vault-relative path of the daily note for a moment instance. */
export function dailyNotePath(config: DailyNotesConfig, m: ReturnType<typeof moment>): string {
	const name = m.format(config.format);
	return config.folder ? `${config.folder}/${name}.md` : `${name}.md`;
}

/**
 * Resolve a user/model-supplied date word to a moment, or null when invalid.
 * Accepts "today", "yesterday", or an exact YYYY-MM-DD.
 */
export function resolveDateWord(word: string | undefined, now: () => ReturnType<typeof moment> = moment): ReturnType<typeof moment> | null {
	const w = (word ?? "today").trim().toLowerCase();
	if (w === "" || w === "today") return now();
	if (w === "yesterday") return now().subtract(1, "day");
	const parsed = moment(w, "YYYY-MM-DD", true);
	return parsed.isValid() ? parsed : null;
}
