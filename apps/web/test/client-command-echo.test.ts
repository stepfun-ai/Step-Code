/**
 * The client's projection of the host's command echo: the custom entry becomes
 * one `command` timeline row carrying the typed line, and every other custom
 * entry stays invisible to the timeline.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { goalStatusNotice, timelineFromEntries } from "../client/src/state/session.ts";

const ENTRY = {
	id: "e1",
	type: "custom",
	customType: "stepcode-web.command-echo",
	command: "/goal 梳理一下本地文件夹",
	timestamp: "2026-10-23T06:26:26.000Z",
};

test("a command echo becomes one command row with the typed line", () => {
	const items = timelineFromEntries([ENTRY]);
	assert.equal(items.length, 1);
	assert.deepEqual(items[0], {
		itemId: "command-e1",
		kind: "command",
		entryId: "e1",
		command: "/goal 梳理一下本地文件夹",
		timestamp: "2026-10-23T06:26:26.000Z",
	});
});

test("a command that journals its own identical message shows once, with the badge", () => {
	// `/plan <task>`: the kernel sends the task as a user message right after
	// the host's echo of the command; the duplicate text is dropped.
	const items = timelineFromEntries([
		ENTRY,
		{
			id: "m-plan",
			type: "message",
			message: { role: "user", content: [{ type: "text", text: " 梳理一下本地文件夹 " }] },
		},
		{
			id: "m-next",
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "好的" }] },
		},
	]);
	assert.equal(items.filter((item) => item.kind === "message").length, 1);
	assert.equal(items[0]?.kind, "command");
	// A different message after the echo is kept.
	const kept = timelineFromEntries([
		ENTRY,
		{
			id: "m-kept",
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "另一件事" }] },
		},
	]);
	assert.equal(kept.filter((item) => item.kind === "message").length, 1);
});

test("goal lifecycle notices are dropped: the goal panel owns that state", () => {
	assert.equal(goalStatusNotice("Goal set: 梳理一下本地文件夹"), true);
	assert.equal(goalStatusNotice("Goal paused."), true);
	assert.equal(goalStatusNotice("Goal commands: /goal status · /goal pause"), true);
	assert.equal(goalStatusNotice("Goal: active (iteration 2)\nObjective: x"), true);
	assert.equal(goalStatusNotice("Stopped a queued goal turn (goal is paused). Run /goal resume to continue it."), true);
	assert.equal(goalStatusNotice("Goal abc123 is paused; this message runs as a normal turn."), true);
	assert.equal(goalStatusNotice("Bash command failed"), false);
});

test("other custom entries and empty echoes stay out of the timeline", () => {
	assert.deepEqual(
		timelineFromEntries([{ id: "g1", type: "custom", customType: "step-goal", data: { objective: "x" } }]),
		[],
	);
	assert.deepEqual(
		timelineFromEntries([{ id: "g2", type: "custom", customType: "stepcode-web.command-echo", command: "" }]),
		[],
	);
	// An echo between messages keeps document order.
	const items = timelineFromEntries([
		ENTRY,
		{
			id: "m1",
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		},
	]);
	assert.equal(items[0]?.kind, "command");
	assert.equal(items[1]?.kind, "message");
});

test("a goal continuation becomes a round separator, numbered from the entry", () => {
	const items = timelineFromEntries([
		{
			id: "c1",
			type: "custom_message",
			customType: "step-goal",
			goalRound: 2,
			timestamp: "2026-10-26T08:00:00.000Z",
		},
	]);
	assert.deepEqual(items, [
		{ itemId: "goal-round-c1", kind: "goal-round", round: 2, timestamp: "2026-10-26T08:00:00.000Z" },
	]);
	// A continuation without a usable number still counts its own position:
	// the first separator is the second round (round 1 is the user's own turn).
	const fallback = timelineFromEntries([{ id: "c2", type: "custom_message", customType: "step-goal" }]);
	assert.deepEqual(fallback, [{ itemId: "goal-round-c2", kind: "goal-round", round: 2 }]);
	// A malformed number must not invent an earlier round.
	const malformed = timelineFromEntries([{ id: "c3", type: "custom_message", customType: "step-goal", goalRound: 0 }]);
	assert.deepEqual(malformed, [{ itemId: "goal-round-c3", kind: "goal-round", round: 2 }]);
});
