import { describe, it, expect } from "vitest";
import { truncate, errorMessage } from "../src/util";

describe("truncate", () => {
	it("returns the string unchanged when within the limit (incl. boundary)", () => {
		expect(truncate("hello", 10)).toBe("hello");
		expect(truncate("hello", 5)).toBe("hello");
	});
	it("cuts and appends an ellipsis when over the limit", () => {
		expect(truncate("hello world", 5)).toBe("hello…");
	});
});

describe("errorMessage", () => {
	it("uses .message for Error instances", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
	});
	it("stringifies non-Error values", () => {
		expect(errorMessage("nope")).toBe("nope");
		expect(errorMessage(42)).toBe("42");
	});
});
