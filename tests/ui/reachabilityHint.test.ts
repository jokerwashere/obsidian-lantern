/**
 * The chat error line's "is the LLM server running?" tail.
 *
 * Small, but it is the first thing a user reads when chat breaks, and pointing
 * them at connectivity when the server already answered sends them debugging
 * the wrong thing entirely — while hiding the message that names the real cause.
 */
import { describe, it, expect } from "vitest";
import { reachabilityHint } from "../../src/ui/errorHint";
import { HttpStatusError, abortError } from "../../src/agent/LlmClient";
import { WireStreamError } from "../../src/agent/wire/types";

const URL = "https://api.anthropic.com/v1";

describe("reachabilityHint", () => {
	it("stays silent when the server answered with a status error", () => {
		// The 400 body names the rejected parameter; burying it under a
		// connectivity question is what made the original OpenAI failure opaque.
		expect(reachabilityHint(new HttpStatusError(400, '{"error":{"message":"Unknown parameter"}}'), URL)).toBe("");
		expect(reachabilityHint(new HttpStatusError(401, "bad key"), URL)).toBe("");
	});

	it("stays silent for an error delivered inside a 200 stream", () => {
		// Anthropic reports overload this way, where a non-streaming call would
		// have been HTTP 529. The connection was made and the server replied.
		expect(reachabilityHint(new WireStreamError("overloaded_error", "Overloaded"), URL)).toBe("");
	});

	it("still asks when nothing answered", () => {
		for (const err of [
			new Error("connect ECONNREFUSED 127.0.0.1:8080"),
			new Error("getaddrinfo ENOTFOUND api.example.test"),
			new Error("LLM stream stalled (no data for 300s)"),
			abortError(),
			"not an error at all",
		]) {
			expect(reachabilityHint(err, URL)).toBe(` — is the LLM server running at ${URL}?`);
		}
	});
});
