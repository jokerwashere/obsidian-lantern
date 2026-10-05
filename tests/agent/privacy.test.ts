/**
 * Privacy invariants for hosted providers.
 *
 * Lantern's pitch is local-first: pointing chat at a hosted API already sends
 * note excerpts to that provider, so the least Lantern can do is send NOTHING
 * that opts into keeping them, and nothing that ties them to a person.
 *
 * These are allowlist tests on purpose. A new body field added anywhere in the
 * request path fails here until someone states what it is — which is the point,
 * because every field on this list would otherwise have slipped in quietly:
 *
 *  - `store` / `previous_response_id` / `conversation`: ask the provider to keep
 *    the exchange server-side. Chat completions defaults `store` to false, so
 *    the invariant is that we never flip it on.
 *  - `cache_control` (Anthropic): opt-in prompt caching, which parks a copy of
 *    the prompt — vault content included — on their infrastructure for 5m–1h.
 *    Declining it costs latency and money; that's the trade Lantern makes.
 *  - `user` / `safety_identifier` / `metadata`: attach an end-user handle to the
 *    request, turning API-key-level traffic into per-person traffic.
 *  - `logprobs`: not privacy per se, but it enlarges what's logged for nothing
 *    Lantern uses.
 *
 * What these tests CANNOT enforce is in the README: both providers retain
 * inputs for abuse monitoring (~30 days) regardless of any request parameter,
 * and OpenAI's implicit prompt caching is automatic. Neither is client-settable
 * — only an org-level zero-retention agreement changes them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import { requestUrl } from "obsidian";
import { LlmClient, type ChatMessage, type ToolDef } from "../../src/agent/LlmClient";

const mockRequestUrl = vi.mocked(requestUrl);

/** Fields that hand a provider more than the question itself. */
const FORBIDDEN = [
	"store",
	"previous_response_id",
	"conversation",
	"user",
	"safety_identifier",
	"metadata",
	"prompt_cache_key",
	"logprobs",
	"top_logprobs",
];

const tools: ToolDef[] = [
	{
		type: "function",
		function: {
			name: "search_vault",
			description: "Search the user's notes.",
			parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		},
	},
];

const history: ChatMessage[] = [
	{ role: "system", content: "You answer from the vault." },
	{ role: "user", content: "What did I write about the migration?" },
	{
		role: "assistant",
		content: null,
		tool_calls: [{ id: "call_1", type: "function", function: { name: "search_vault", arguments: '{"query":"x"}' } }],
		reasoning_content: "thinking…",
		reasoning_blocks: [{ transport: "messages", data: { type: "thinking", thinking: "t", signature: "sig" } }],
	},
	{ role: "tool", tool_call_id: "call_1", name: "search_vault", content: "Work/Migration.md: blocked on SSO" },
];

async function bodySentTo(baseUrl: string): Promise<{ raw: string; body: Record<string, unknown> }> {
	// Cleared per call, not per test: several tests inspect more than one provider.
	mockRequestUrl.mockReset();
	mockRequestUrl.mockResolvedValue({ status: 200, json: { choices: [{ message: { content: "ok" } }] } } as never);
	const client = new LlmClient({ baseUrl, apiKey: "k", model: "m", reasoningEffort: "medium", temperature: 0.2 });
	await client.chat(history, tools);
	const raw = (mockRequestUrl.mock.calls[0][0] as { body: string }).body;
	return { raw, body: JSON.parse(raw) as Record<string, unknown> };
}

describe("hosted-provider privacy invariants", () => {
	beforeEach(() => vi.clearAllMocks());

	it.each([
		["OpenAI", "https://api.openai.com/v1"],
		["Anthropic", "https://api.anthropic.com/v1"],
		["a local server", "http://localhost:8080/v1"],
	])("sends %s nothing that opts into retention or identifies a user", async (_name, baseUrl) => {
		const { body } = await bodySentTo(baseUrl);
		for (const field of FORBIDDEN) {
			expect({ field, present: field in body }).toEqual({ field, present: false });
		}
	});

	it("never asks Anthropic to cache the prompt on their side", async () => {
		// cache_control can appear on tools, system, or any message block — so this
		// checks the serialized request, not just its top level.
		const { raw } = await bodySentTo("https://api.anthropic.com/v1");
		expect(raw).not.toContain("cache_control");
		expect(raw).not.toContain("ephemeral");
	});

	it("keeps every request self-contained — no server-side conversation state", async () => {
		// The whole transcript is re-sent each turn and lives in the vault. Nothing
		// accumulates provider-side that a later request could refer back to.
		for (const url of ["https://api.openai.com/v1", "https://api.anthropic.com/v1"]) {
			const { body } = await bodySentTo(url);
			const conversation = body.messages ?? body.input;
			expect(Array.isArray(conversation), `${url} must carry the full conversation inline`).toBe(true);
		}
	});

	it("holds the line on the exact top-level fields each provider receives", async () => {
		// An allowlist, so a new field is a deliberate decision rather than a leak.
		const openai = await bodySentTo("https://api.openai.com/v1");
		expect(Object.keys(openai.body).sort()).toEqual(
			["max_completion_tokens", "messages", "model", "reasoning_effort", "stream", "temperature", "tool_choice", "tools"].sort()
		);

		const anthropic = await bodySentTo("https://api.anthropic.com/v1");
		expect(Object.keys(anthropic.body).sort()).toEqual(
			["max_tokens", "messages", "model", "output_config", "stream", "system", "thinking", "tool_choice", "tools"].sort()
		);
		// Note what is NOT there: temperature is omitted whenever thinking is on
		// (the API requires it), so nothing extra is invented to fill the gap.
		expect(anthropic.body.temperature).toBeUndefined();
	});

	it("does not leak another provider's opaque reasoning blob sideways", async () => {
		// The history above carries an Anthropic thinking block. Sending it to
		// OpenAI would both fail and hand them reasoning from a different vendor.
		const { raw } = await bodySentTo("https://api.openai.com/v1");
		expect(raw).not.toContain("signature");
		expect(raw).not.toContain("thinking");
	});
});
