/**
 * Which notices the transcript shows and which the composer's warning badge
 * holds (`state/notices.ts`). A warning that replies to the user's command stays
 * under that command; a warning nobody asked for only counts in the badge.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { badgeWarnings, isCommandText, transcriptNotices } from "../client/src/state/notices.ts";
import { dismissWarnings, pushNotice } from "../client/src/state/session.ts";
import { getState, setState } from "../client/src/state/store.ts";
import type { NoticeItem, SessionSnapshot } from "../client/src/state/types.ts";

const notice = (id: string, level: NoticeItem["level"], extra: Partial<NoticeItem> = {}): NoticeItem => ({
	id,
	sessionId: "s1",
	level,
	text: id,
	...extra,
});

test("ambient warnings leave the transcript for the badge; replies and other levels stay", () => {
	const notices = [
		notice("info", "info"),
		notice("ambient", "warning"),
		notice("reply", "warning", { reply: true }),
		notice("error", "error"),
		notice("other-session", "warning", { sessionId: "s2" }),
	];

	assert.deepEqual(
		transcriptNotices(notices, "s1").map((item) => item.id),
		["info", "reply", "error"],
	);
	assert.deepEqual(
		badgeWarnings(notices, "s1").map((item) => item.id),
		["ambient"],
	);
});

test("the badge lists the newest warning first and nothing without a session", () => {
	const notices = [notice("older", "warning"), notice("newer", "warning")];

	assert.deepEqual(
		badgeWarnings(notices, "s1").map((item) => item.id),
		["newer", "older"],
	);
	assert.deepEqual(badgeWarnings(notices, undefined), []);
});

test("a typed slash command is told apart from a pasted path or prose", () => {
	assert.equal(isCommandText("/cron delete"), true);
	assert.equal(isCommandText("  /goal status"), true);
	assert.equal(isCommandText("fix the /tmp path"), false);
	assert.equal(isCommandText("/"), false);
	assert.equal(isCommandText(undefined), false);
});

test("clearing the badge removes only that session's ambient warnings", () => {
	setState({ notices: [], current: { id: "s1" } as unknown as SessionSnapshot });
	pushNotice("warning", "ambient");
	pushNotice("warning", "reply", { reply: true });
	pushNotice("info", "answer");

	dismissWarnings("s1");

	assert.deepEqual(
		getState().notices.map((item) => item.text),
		["reply", "answer"],
	);
	setState({ notices: [], current: null });
});
