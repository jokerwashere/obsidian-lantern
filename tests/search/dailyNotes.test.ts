import { describe, it, expect } from "vitest";
import { moment } from "obsidian";
import {
	parseDailyNotesConfig,
	dailyNotePath,
	resolveDateWord,
	DEFAULT_DAILY_FORMAT,
} from "../../src/search/dailyNotes";

describe("parseDailyNotesConfig", () => {
	it("reads folder and format, trimming slashes", () => {
		expect(parseDailyNotesConfig('{"folder": "/Daily Notes/", "format": "YYYY/MM/DD"}')).toEqual({
			folder: "Daily Notes",
			format: "YYYY/MM/DD",
		});
	});

	it("defaults match Obsidian (root folder, YYYY-MM-DD) — the user's real config sets only folder", () => {
		expect(parseDailyNotesConfig('{"folder": "Daily Notes"}')).toEqual({
			folder: "Daily Notes",
			format: DEFAULT_DAILY_FORMAT,
		});
		expect(parseDailyNotesConfig(null)).toEqual({ folder: "", format: DEFAULT_DAILY_FORMAT });
	});

	it("tolerates corrupt JSON", () => {
		expect(parseDailyNotesConfig("{nope")).toEqual({ folder: "", format: DEFAULT_DAILY_FORMAT });
	});
});

describe("dailyNotePath", () => {
	it("joins folder and formatted name", () => {
		const m = moment("2026-06-12", "YYYY-MM-DD", true);
		expect(dailyNotePath({ folder: "Daily Notes", format: "YYYY-MM-DD" }, m)).toBe(
			"Daily Notes/2026-06-12.md"
		);
		expect(dailyNotePath({ folder: "", format: "YYYY-MM-DD" }, m)).toBe("2026-06-12.md");
	});

	it("supports formats containing slashes (deeper paths)", () => {
		const m = moment("2026-06-12", "YYYY-MM-DD", true);
		expect(dailyNotePath({ folder: "J", format: "YYYY/MM-DD" }, m)).toBe("J/2026/06-12.md");
	});
});

describe("resolveDateWord", () => {
	const fixedNow = () => moment("2026-06-12", "YYYY-MM-DD", true);

	it("resolves today / yesterday / explicit dates", () => {
		expect(resolveDateWord("today", fixedNow)!.format("YYYY-MM-DD")).toBe("2026-06-12");
		expect(resolveDateWord(undefined, fixedNow)!.format("YYYY-MM-DD")).toBe("2026-06-12");
		expect(resolveDateWord("yesterday", fixedNow)!.format("YYYY-MM-DD")).toBe("2026-06-11");
		expect(resolveDateWord("2026-01-05", fixedNow)!.format("YYYY-MM-DD")).toBe("2026-01-05");
	});

	it("rejects garbage (strict parsing)", () => {
		expect(resolveDateWord("next tuesday", fixedNow)).toBeNull();
		expect(resolveDateWord("2026-13-99", fixedNow)).toBeNull();
	});
});
