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

function reviews(entries: readonly SessionEntry[], pendingPlanHash?: string) {
	return timelineFromEntries(entries, undefined, pendingPlanHash).flatMap((item) =>
		item.kind === "tool" && item.planReview ? [{ tool: item.toolName, review: item.planReview }] : [],
	);
}

test("a persisted proposal keeps its review card after a snapshot refresh", () => {
	const found = reviews(call("exit_plan_mode", { details }), details.planHash);
	assert.equal(found.length, 1);
	assert.deepEqual(found[0]?.review, {
		planFilePath: details.planFilePath,
		planContents: details.planContents,
		planHash: details.planHash,
		outcome: "external_approval_required",
		pending: true,
	});
});

test("only the proposal the kernel is waiting on is actionable", () => {
	// `pending` comes from the session fact, not from the transcript: a question
	// typed after the proposal is not consent, and an answered one is not pending.
	const waiting = reviews([...call("exit_plan_mode", { details })], details.planHash);
	assert.equal(waiting[0]?.review.pending, true);

	const answered = reviews([...call("exit_plan_mode", { details })], undefined);
	assert.equal(answered[0]?.review.pending, false);

	const superseded = reviews([...call("exit_plan_mode", { details })], "f".repeat(64));
	assert.equal(superseded[0]?.review.pending, false);
});

test("a newer proposal supersedes the older one", () => {
	const second = {
		...details,
		planContents: "# Plan\n\n1. Write README.md\n2. Write CHANGELOG.md\n",
		planHash: "b".repeat(64),
	};
	const entries = [...call("exit_plan_mode", { details }), ...call("exit_plan_mode", { details: second })];
	// Exactly one card answers the pending hash; the record of the earlier round
	// stays in the transcript as a handled card.
	assert.deepEqual(
		reviews(entries, second.planHash).map((item) => item.review.pending),
		[false, true],
	);
});

test("an answered proposal leaves its record and stops blocking the page", () => {
	// After a decision the card must still be visible as history — it just stops
	// offering buttons — and nothing waits any more.
	const items = timelineFromEntries(call("exit_plan_mode", { details }), undefined, undefined);
	const card = items.flatMap((item) => (item.kind === "tool" && item.planReview ? [item.planReview] : []));
	assert.equal(card.length, 1);
	assert.equal(card[0]?.pending, false);
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
