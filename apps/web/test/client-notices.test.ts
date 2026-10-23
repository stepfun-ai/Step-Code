/**
 * Notices are command answers; state announcements are not.
 *
 * `ui.notify` used to be dropped by the Web host, then became a transcript row for
 * everything. Plan mode's "Plan mode enabled…" is state the composer already
 * draws, so it must not land in the conversation, while `/status` and `/btw` (on a
 * text-only host) are answers that stay until dismissed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";
import { dismissNotice, pushNotice } from "../client/src/state/session.ts";
import type { SessionSnapshot } from "../client/src/state/types.ts";

function reset(): void {
	const initial = createInitialState();
	setState({ notices: [], toast: null, current: null });
}

test("a command answer becomes one notice row and can be dismissed", () => {
	reset();
	pushNotice("info", "Usage: 12k in / 3k out");
	assert.equal(getState().notices.length, 1);
	assert.equal(getState().notices[0]?.text, "Usage: 12k in / 3k out");
	dismissNotice(getState().notices[0]?.id ?? "");
	assert.deepEqual(getState().notices, []);
});

test("notices carry no model or session-file identity", () => {
	reset();
	pushNotice("warning", "Nothing to compact (session too small)");
	const [notice] = getState().notices;
	assert.equal(notice?.level, "warning");
	// A notice has an id, a level and text; it is never a message entry.
	assert.deepEqual(Object.keys(notice ?? {}).sort(), ["id", "level", "sessionId", "text"]);
});

test("a snapshot's planMode is what the strip draws, not a notice", () => {
	reset();
	const snapshot = {
		id: "s1",
		cwd: "/tmp",
		status: "idle",
		planMode: { enabled: true, planFilePath: "/tmp/.stepcode/plans/session-s1.md", planSource: "user" },
	} as unknown as SessionSnapshot;
	setState({ current: snapshot });
	assert.equal(getState().current?.planMode?.enabled, true);
	// Nothing about plan mode is in the transcript: no notice, no timeline row.
	assert.deepEqual(getState().notices, []);
	assert.deepEqual(getState().timelineItems, []);
});
