import { describe, it, expect } from "vitest";
import { compactHistory } from "../../src/agent/history";
import type { ChatMessage } from "../../src/agent/LlmClient";

const toolCall = (id: string) => ({
	id,
	type: "function" as const,
	function: { name: "search_vault", arguments: "{}" },
});

/** One full turn: question → tool round-trip → answer. */
function turn(n: number, toolContent = `tool result ${n}`): ChatMessage[] {
	return [
		{ role: "user", content: `question ${n}` },
		{ role: "assistant", content: null, tool_calls: [toolCall(`c${n}`)] },
		{ role: "tool", tool_call_id: `c${n}`, name: "search_vault", content: toolContent },
		{ role: "assistant", content: `answer ${n}` },
	];
}

describe("compactHistory", () => {
	it("returns [] for empty history", () => {
		expect(compactHistory([])).toEqual([]);
	});

	it("keeps the latest turn's tool traffic, truncated", () => {
		const long = "x".repeat(2000);
		const out = compactHistory(turn(1, long), { maxToolChars: 100 });
		const tool = out.find((m) => m.role === "tool");
		expect(tool?.content).toHaveLength(100 + "…[truncated]".length);
		expect(out.find((m) => m.tool_calls)).toBeDefined();
	});

	it("reduces older turns to question + answer, keeping pairing valid", () => {
		const out = compactHistory([...turn(1), ...turn(2)], { maxToolChars: 50 });

		// Turn 1: only user + final assistant remain.
		expect(out.filter((m) => m.content?.includes("1")).map((m) => m.role)).toEqual([
			"user",
			"assistant",
		]);
		// No orphan tool messages: every tool message's call id has a matching
		// assistant tool_calls entry that is still present.
		const keptCallIds = new Set(
			out.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id))
		);
		for (const msg of out.filter((m) => m.role === "tool")) {
			expect(keptCallIds.has(msg.tool_call_id ?? "")).toBe(true);
		}
		// Turn 2 keeps its tool round-trip.
		expect(out.some((m) => m.role === "tool" && m.content?.includes("tool result 2"))).toBe(true);
	});

	it("does not modify short tool results", () => {
		const out = compactHistory(turn(1, "short"), { maxToolChars: 100 });
		expect(out.find((m) => m.role === "tool")?.content).toBe("short");
	});

	it("drops oldest turns when over the message cap, keeping the latest", () => {
		const turns = [...turn(1), ...turn(2), ...turn(3), ...turn(4)];
		const out = compactHistory(turns, { maxMessages: 6, maxToolChars: 50 });
		expect(out.some((m) => m.content === "question 1")).toBe(false);
		expect(out.some((m) => m.content === "question 4")).toBe(true);
		// Latest turn survives whole even if it alone exceeds the cap.
		const single = compactHistory(turn(9), { maxMessages: 2 });
		expect(single.length).toBe(4);
	});

	it("drops oldest turns when over the character budget (under the message cap)", () => {
		const big = "y".repeat(3000);
		const turns = [...turn(1), ...turn(2), ...turn(3, big)];
		// Message count is well under maxMessages; the char budget drives eviction.
		const out = compactHistory(turns, { maxMessages: 100, maxToolChars: 4000, maxHistoryChars: 200 });
		expect(out.some((m) => m.content === "question 3")).toBe(true); // latest kept whole
		expect(out.some((m) => m.content === "question 1")).toBe(false); // oldest evicted
	});

	it("strips reasoning_content from stored history (fresh chain per question)", () => {
		const msgs: ChatMessage[] = [
			{ role: "user", content: "q" },
			{ role: "assistant", content: null, tool_calls: [toolCall("c9")], reasoning_content: "thinking…" },
			{ role: "tool", tool_call_id: "c9", name: "search_vault", content: "r" },
			{ role: "assistant", content: "a", reasoning_content: "more thinking" },
		];
		const out = compactHistory(msgs);
		expect(out.every((m) => m.reasoning_content === undefined)).toBe(true);
		expect(out.find((m) => m.tool_calls)?.tool_calls).toHaveLength(1); // rest intact
	});

	it("handles a tool-free conversation unchanged", () => {
		const msgs: ChatMessage[] = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
			{ role: "user", content: "more" },
			{ role: "assistant", content: "sure" },
		];
		expect(compactHistory(msgs)).toEqual(msgs);
	});
});
