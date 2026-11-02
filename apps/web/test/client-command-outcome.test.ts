import assert from "node:assert/strict";
import test from "node:test";
import { commandOutcomeFailed, toolResultFailed } from "../client/src/lib/command-outcome.ts";

/** One declared observation, in the shape the tool result carries on the wire. */
function exited(exitCode: number) {
	return { status: "exited", exitCode, signal: null, timedOut: false, aborted: false };
}

test("a clean exit is the only success", () => {
	assert.equal(commandOutcomeFailed({ execution: exited(0) }), false);
});

test("a nonzero exit is reported", () => {
	assert.equal(commandOutcomeFailed({ execution: exited(1) }), true);
	assert.equal(commandOutcomeFailed({ execution: exited(128) }), true);
});

test("a deadline is a failure even when the command exited with zero", () => {
	const outcome = { status: "timed_out", exitCode: 0, signal: null, timedOut: true, aborted: false, timeoutSeconds: 1 };
	assert.equal(commandOutcomeFailed({ execution: outcome }), true);
});

test("a signal, cancellation and an unknown exit are failures", () => {
	assert.equal(commandOutcomeFailed({ execution: { status: "signaled", exitCode: null, signal: "SIGKILL" } }), true);
	assert.equal(commandOutcomeFailed({ execution: { status: "canceled", exitCode: null, signal: null } }), true);
	assert.equal(commandOutcomeFailed({ execution: { status: "unknown", exitCode: null, signal: null } }), true);
});

test("an embedded then_run check counts for the call that ran it", () => {
	assert.equal(commandOutcomeFailed({ changed: true, thenRun: { execution: exited(1) } }), true);
	assert.equal(commandOutcomeFailed({ changed: true, thenRun: { execution: exited(0) } }), false);
	// The top-level observation wins when both exist.
	assert.equal(commandOutcomeFailed({ execution: exited(0), thenRun: { execution: exited(1) } }), false);
});

test("a record without a usable observation keeps the legacy answer", () => {
	for (const details of [undefined, null, {}, { thenRun: {} }, { execution: null }, "not an object"]) {
		assert.equal(commandOutcomeFailed(details), false, JSON.stringify(details));
	}
});

/**
 * The CLI drops these too (`readCommandExecutionOutcome` in agent-core), so the
 * two hosts agree instead of one inventing a failure from a broken field.
 */
test("an observation that cannot describe itself is dropped rather than read as a failure", () => {
	const malformed = [
		{ status: "exited" },
		{ status: "exited", exitCode: null },
		{ status: "exited", exitCode: 1.5 },
		{ status: "exited", exitCode: "1" },
		{ status: "signaled", exitCode: null },
		{ status: "running" },
		{ status: "exited", exitCode: 1, signal: 7 },
		{ status: "exited", exitCode: 1, timeoutSeconds: "1" },
	];
	for (const execution of malformed) {
		assert.equal(commandOutcomeFailed({ execution }), false, JSON.stringify(execution));
	}
	// A later valid observation still counts even when the first one was dropped.
	assert.equal(commandOutcomeFailed({ execution: { status: "exited" }, thenRun: { execution: exited(1) } }), true);
});

test("a tool result fails when the invocation failed or the command did", () => {
	assert.equal(toolResultFailed(undefined, undefined), false);
	assert.equal(toolResultFailed(false, undefined), false);
	assert.equal(toolResultFailed(true, undefined), true);
	assert.equal(toolResultFailed(false, { execution: exited(0) }), false);
	// The case this change exists for: the call succeeded, the command did not.
	assert.equal(toolResultFailed(false, { execution: exited(3) }), true);
	assert.equal(toolResultFailed(false, { changed: true, thenRun: { execution: exited(1) } }), true);
	// An invocation failure is reported whatever the observation says.
	assert.equal(toolResultFailed(true, { execution: exited(0) }), true);
	// A live event keeps `details` under `result`, so callers pass the level that holds it.
	assert.equal(toolResultFailed(false, { result: { details: { execution: exited(1) } } }), false);
});
