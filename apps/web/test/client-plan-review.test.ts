/**
 * The plan review card comes from the persisted `exit_plan_mode` result.
 *
 * It used to be projected only from the live `tool_execution_end` event. Every
 * finished message refreshes the snapshot, and `timelineFromEntries` had no
 * `planReview`, so the card vanished right after it appeared: the Web/Desktop
 * user had nothing to approve, and a reloaded session never showed the card.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { timelineFromEntries } from "../client/src/state/session.ts";
import type { SessionEntry } from "../client/src/state/types.ts";

const details = {
	planFilePath: "/w/.stepcode/plans/session-s1.md",
	planContents: "# Plan\n\n1. Write README.md\n",
	planHash: "a".repeat(64),
	outcome: "external_approval_required",
	approvalSource: "external",
	planModeExited: true,
};

let seq = 0;

/** An assistant tool call followed by its persisted result. */
function call(name: string, result: { details?: unknown; text?: string }): SessionEntry[] {
	seq += 1;
	const id = `call-${seq}`;
	return [
		{
			id: `entry-${id}`,
			type: "message",
			timestamp: "2026-10-22T00:00:00.000Z",
			message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }] },
		},
		{
			id: `entry-${id}-result`,
			type: "message",
			timestamp: "2026-10-22T00:00:01.000Z",
			message: {
				role: "toolResult",
				toolCallId: id,
				toolName: name,
				content: [{ type: "text", text: result.text ?? "ok" }],
				...(result.details ? { details: result.details } : {}),
			},
		},
	];
}

function userEntry(text: string): SessionEntry {
	seq += 1;
	return {
		id: `entry-user-${seq}`,
		type: "message",
		timestamp: "2026-10-22T00:00:02.000Z",
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

function reviews(entries: readonly SessionEntry[]) {
	return timelineFromEntries(entries).flatMap((item) =>
		item.kind === "tool" && item.planReview ? [{ tool: item.toolName, review: item.planReview }] : [],
	);
}

test("a persisted proposal keeps its review card after a snapshot refresh", () => {
	const found = reviews(call("exit_plan_mode", { details }));
	assert.equal(found.length, 1);
	assert.deepEqual(found[0]?.review, {
		planFilePath: details.planFilePath,
		planContents: details.planContents,
		planHash: details.planHash,
		outcome: "external_approval_required",
		pending: true,
	});
});

test("a decision (an ordinary user message after it) settles the card", () => {
	const found = reviews([...call("exit_plan_mode", { details }), userEntry("同意执行，请按这份计划开始实现。")]);
	assert.equal(found[0]?.review.pending, false);
	assert.equal(found[0]?.review.outcome, "external_approval_required");
});

test("only the newest proposal is actionable", () => {
	const second = {
		...details,
		planContents: "# Plan\n\n1. Write README.md\n2. Write CHANGELOG.md\n",
		planHash: "b".repeat(64),
	};
	const found = reviews([...call("exit_plan_mode", { details }), ...call("exit_plan_mode", { details: second })]);
	assert.deepEqual(
		found.map((item) => item.review.pending),
		[false, true],
	);
	// A later decision settles the newest proposal too.
	const decided = reviews([
		...call("exit_plan_mode", { details }),
		...call("exit_plan_mode", { details: second }),
		userEntry("计划需要修改：\n\nsplit the README step"),
	]);
	assert.deepEqual(
		decided.map((item) => item.review.pending),
		[false, false],
	);
});

test("guard results (no proposal details) stay plain tool rows", () => {
	for (const result of [
		{ text: "Plan mode is already off, so there is nothing to submit or leave." },
		{ details: { planFilePath: details.planFilePath }, text: "Cannot review the plan: it is empty" },
	]) {
		const found = reviews(call("exit_plan_mode", result));
		assert.deepEqual(found, []);
	}
});
