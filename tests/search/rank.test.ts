import { describe, it, expect } from "vitest";
import { recencyFactor, applyRecencyBoost, recencyFetchLimit } from "../../src/search/rank";

const DAY = 86_400_000;

describe("recencyFactor", () => {
	it("is 1.0 today and decays toward the 0.5 floor", () => {
		expect(recencyFactor(0)).toBe(1);
		expect(recencyFactor(30)).toBeCloseTo(0.5 + 0.5 / Math.E, 5);
		expect(recencyFactor(3650)).toBeGreaterThanOrEqual(0.5); // float-converged floor
		expect(recencyFactor(3650)).toBeLessThan(0.501);
	});

	it("clamps negative ages (future mtimes)", () => {
		expect(recencyFactor(-5)).toBe(1);
	});
});

describe("applyRecencyBoost", () => {
	const now = 1_000_000 * DAY;

	it("lets a good recent note beat a slightly better old one", () => {
		const results = [
			{ id: "old", score: 0.9 },
			{ id: "new", score: 0.8 },
		];
		const mtimes: Record<string, number> = { old: now - 365 * DAY, new: now - 1 * DAY };
		const out = applyRecencyBoost(results, (r) => mtimes[r.id], now);
		expect(out.map((r) => r.id)).toEqual(["new", "old"]);
	});

	it("never buries a much stronger old match (0.5 floor)", () => {
		const results = [
			{ id: "weak-new", score: 0.3 },
			{ id: "strong-old", score: 0.9 },
		];
		const mtimes: Record<string, number> = { "weak-new": now, "strong-old": now - 1000 * DAY };
		const out = applyRecencyBoost(results, (r) => mtimes[r.id], now);
		expect(out[0].id).toBe("strong-old");
	});

	it("gives factor 1.0 to results without recency semantics", () => {
		const results = [
			{ id: "external", score: 0.85 },
			{ id: "vault-old", score: 0.86 },
		];
		const out = applyRecencyBoost(results, (r) => (r.id === "external" ? null : now - 400 * DAY), now);
		expect(out[0].id).toBe("external");
	});
});

describe("recencyFetchLimit", () => {
	it("doubles with a cap of 50", () => {
		expect(recencyFetchLimit(20)).toBe(40);
		expect(recencyFetchLimit(40)).toBe(50);
	});
});
