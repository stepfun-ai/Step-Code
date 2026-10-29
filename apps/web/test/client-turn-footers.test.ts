import assert from "node:assert/strict";
import test from "node:test";
import { collectTurnFooters } from "../client/src/features/conversation/turn-footers.ts";
import type { MessageTimelineItem, SessionStatus, TimelineItem, ToolTimelineItem } from "../client/src/state/types.ts";

function message(id: string, role: string, content = id): MessageTimelineItem {
	return { itemId: id, entryId: id, kind: "message", role, content };
}

function tool(id: string, state: ToolTimelineItem["state"] = "completed"): ToolTimelineItem {
	return { itemId: id, kind: "tool", toolName: "read", state, inputSummary: "", outputSummary: "" };
}

const multiTool: readonly TimelineItem[] = [
	message("u1", "user"),
	message("a1", "assistant", "First I will read."),
	tool("t1"),
	message("a2", "assistant", "Now checking the next file."),
	tool("t2"),
	message("a3", "assistant", "Done."),
];

test("one settled turn has one footer after all narration and tools", () => {
	const [footer, ...extra] = collectTurnFooters(multiTool, "completed", false);
	assert.deepEqual(extra, []);
	assert.equal(footer?.turnId, "u1");
	assert.equal(footer?.lastIndex, 5);
	assert.deepEqual(footer?.messages.map((item) => item.entryId), ["a1", "a2", "a3"]);
	assert.deepEqual(footer?.messages.map((item) => item.content), [
		"First I will read.",
		"Now checking the next file.",
		"Done.",
	]);
});

test("individual messages and tools ending never finish a running turn", () => {
	for (let length = 1; length <= multiTool.length; length += 1) {
		assert.deepEqual(collectTurnFooters(multiTool.slice(0, length), "running", false), []);
	}
	assert.deepEqual(collectTurnFooters(multiTool, "waiting", false), []);
});

test("terminal status cannot expose a footer over live text, pending tools or approvals", () => {
	const unresolved: TimelineItem[] = [
		message("message-live", "assistant"),
		tool("pending", "pending"),
		{
			kind: "approval",
			itemId: "approval",
			approval: { id: "approval", sessionId: "s", toolName: "bash", message: "Approve", createdAt: 0 },
		},
	];
	for (const item of unresolved) {
		assert.deepEqual(collectTurnFooters([...multiTool, item], "completed", false), []);
		assert.deepEqual(collectTurnFooters([...multiTool, item], "running", true), []);
	}
});

test("historical turns keep one footer while the latest turn runs or waits", () => {
	const items = [...multiTool, message("u2", "user"), message("a4", "assistant"), tool("t3", "pending")];
	for (const status of ["running", "waiting"] as const) {
		const footers = collectTurnFooters(items, status, false);
		assert.equal(footers.length, 1);
		assert.equal(footers[0]?.lastIndex, 5);
	}
	assert.equal(collectTurnFooters([...multiTool, message("u2", "user", "")], "running", false).length, 1);
});

test("a pending prompt belongs after the previous turn, including during startup", () => {
	assert.equal(collectTurnFooters(multiTool, "running", true).length, 1);
	assert.equal(collectTurnFooters(multiTool, "completed", true).length, 1);
	assert.deepEqual(collectTurnFooters([], "running", true), []);
});

test("restored history has a single footer per response, including trailing tools", () => {
	const items = [...multiTool, message("u2", "user"), message("a4", "assistant"), tool("t3")];
	assert.deepEqual(
		collectTurnFooters(items, "idle", false).map((footer) => [footer.turnId, footer.lastIndex]),
		[["u1", 5], ["u2", 8]],
	);
});

test("stopped or failed turns retain response actions after their last row", () => {
	const items = [...multiTool, tool("failed", "failed")];
	for (const status of ["idle", "failed", "completed"] as const) {
		assert.equal(collectTurnFooters(items, status, false)[0]?.lastIndex, 6);
	}
});

test("unknown status, empty replies and error-only turns have no footer", () => {
	assert.deepEqual(collectTurnFooters(multiTool, undefined, false), []);
	for (const status of ["completed", "failed", "idle"] satisfies SessionStatus[]) {
		assert.deepEqual(collectTurnFooters([message("u", "user")], status, false), []);
		assert.deepEqual(collectTurnFooters([message("a", "assistant", "")], status, false), []);
		assert.deepEqual(
			collectTurnFooters([{ ...message("a", "assistant"), error: "request failed" }], status, false),
			[],
		);
	}
});

test("metadata includes one final error without adding an error-only action footer", () => {
	const first = { ...message("error-first", "assistant", ""), error: "first failure", timestamp: "2026-10-26T03:12:00Z" };
	const last = { ...message("error-last", "assistant", ""), error: "last failure", timestamp: "2026-10-26T03:14:00Z" };
	const items = [message("u", "user"), first, last, tool("trailing")];
	assert.deepEqual(collectTurnFooters(items, "failed", false), []);
	const metadata = collectTurnFooters(items, "failed", false, true);
	assert.equal(metadata.length, 1);
	assert.equal(metadata[0]?.messages.at(-1), last);
	assert.equal(metadata[0]?.lastIndex, 3);
	for (const status of ["running", "waiting", undefined] as const)
		assert.deepEqual(collectTurnFooters(items, status, false, true), []);
	assert.deepEqual(collectTurnFooters([...items, tool("pending", "pending")], "idle", false, true), []);
});

test("a final record with missing time is not replaced by an earlier recorded clock", () => {
	const earlier = { ...message("earlier", "assistant"), timestamp: "2026-10-26T03:12:00Z" };
	const final = message("final", "assistant");
	const [footer] = collectTurnFooters([message("u", "user"), earlier, tool("t"), final], "idle", false, true);
	assert.equal(footer?.messages.at(-1), final);
	assert.equal(footer?.messages.at(-1)?.timestamp, undefined);
});

test("an interrupted historical turn is bounded by the next prompt, not tool success", () => {
	const items = [...multiTool, tool("stopped", "pending"), message("u2", "user"), message("a4", "assistant")];
	assert.deepEqual(collectTurnFooters(items, "running", false).map((footer) => footer.lastIndex), [6]);
});
