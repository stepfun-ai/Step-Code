import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { closeStream, renderSnapshot } from "../client/src/state/session.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";
import type { SessionSnapshot } from "../client/src/state/types.ts";

afterEach(() => {
	closeStream();
	setState(createInitialState());
});

function snapshot(id: string, status: SessionSnapshot["status"], revision?: number): SessionSnapshot {
	return { id, cwd: "/work", status, revision, entries: [] };
}

test("a snapshot older than the newest stream event does not repaint the session", () => {
	// A stopped turn: the stream reported completed/idle while a read that was
	// issued during the run is still in flight. Its answer says "running".
	renderSnapshot(snapshot("s", "completed", 12));
	renderSnapshot(snapshot("s", "idle", 13));
	assert.equal(getState().current?.status, "idle");
	renderSnapshot(snapshot("s", "running", 11));
	assert.equal(getState().current?.status, "idle", "the stale answer is ignored");
	// A read at the newest revision, and one the host answered later, still apply.
	renderSnapshot(snapshot("s", "idle", 13));
	renderSnapshot(snapshot("s", "running", 14));
	assert.equal(getState().current?.status, "running");
});

test("the stream's own snapshot is authoritative, and an unversioned host is never gated", () => {
	renderSnapshot(snapshot("s", "idle", 20));
	// A reconnect can follow a host restart whose revisions start over.
	renderSnapshot(snapshot("s", "running", 1), { fromStream: true });
	assert.equal(getState().current?.status, "running");
	renderSnapshot(snapshot("s", "idle", 2));
	assert.equal(getState().current?.status, "idle");
	// Hosts that predate revisions keep working unchanged.
	renderSnapshot(snapshot("s", "running"));
	assert.equal(getState().current?.status, "running");
});

test("a new stream starts a new order, so its first refused read is fresh again", () => {
	renderSnapshot(snapshot("s", "running", 40));
	closeStream();
	renderSnapshot(snapshot("s", "idle", 1));
	assert.equal(getState().current?.status, "idle");
});

test("an action's answer keeps its change without rolling back the stream", () => {
	// The host applied the action, but a stream event overtook the answer: the
	// policy the user picked must still apply, while the transcript, the run
	// status and the stop control stay as the stream last reported them.
	const running = {
		...snapshot("s", "running", 40),
		permissionPreset: "ask",
		entries: [
			{ id: "u1", type: "message", parentId: null, timestamp: "", message: { role: "user", content: "go", timestamp: 0 } },
		],
	} as SessionSnapshot;
	renderSnapshot(running);
	const shown = getState().timelineItems.length;
	assert.ok(shown > 0, "the transcript has the turn's own message");

	renderSnapshot({ ...snapshot("s", "idle", 39), permissionPreset: "full-access" }, { fromAction: true });
	assert.equal(getState().current?.permissionPreset, "full-access", "the action's own field applies");
	assert.equal(getState().current?.status, "running", "the overtaken status is not painted back");
	assert.equal(getState().timelineItems.length, shown, "the transcript is not rolled back");
	assert.equal(getState().current?.status, "running");
});

test("an action's answer applies when nothing overtook it", () => {
	renderSnapshot(snapshot("s", "running", 10));
	renderSnapshot({ ...snapshot("s", "idle", 11), permissionPreset: "ask" }, { fromAction: true });
	assert.equal(getState().current?.status, "idle");
	assert.equal(getState().current?.permissionPreset, "ask");
});
