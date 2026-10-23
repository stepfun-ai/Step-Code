import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveTaskStatus, sessionIsLive } from "../client/src/features/inspector/model.ts";

test("a stopped session freezes an in-progress checklist row as aborted", () => {
	// The last snapshot keeps in_progress when a turn ends, so the row must not keep spinning.
	for (const status of ["idle", "completed", "failed"] as const) {
		assert.ok(!sessionIsLive(status));
	}
	assert.equal(effectiveTaskStatus("in_progress", false), "aborted");
});

test("a live session keeps the snapshot status verbatim", () => {
	for (const status of ["running", "waiting"] as const) {
		assert.ok(sessionIsLive(status));
	}
	assert.equal(effectiveTaskStatus("in_progress", true), "in_progress");
});

test("pending and completed rows never turn aborted", () => {
	assert.equal(effectiveTaskStatus("pending", false), "pending");
	assert.equal(effectiveTaskStatus("completed", false), "completed");
	assert.equal(effectiveTaskStatus("pending", true), "pending");
	assert.equal(effectiveTaskStatus("completed", true), "completed");
});

test("an absent session is not live", () => {
	assert.ok(!sessionIsLive(undefined));
});
