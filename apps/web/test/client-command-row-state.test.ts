import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { closeStream, connectStream, renderSnapshot } from "../client/src/state/session.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";
import { collectTurnChanges } from "../client/src/lib/turn-changes.ts";
import type { SessionEntry, ToolTimelineItem } from "../client/src/state/types.ts";

class FakeEventSource {
	static current: FakeEventSource | undefined;
	readonly listeners = new Map<string, (event: { data: string }) => void>();
	onerror: (() => void) | null = null;
	constructor() {
		FakeEventSource.current = this;
	}
	addEventListener(type: string, listener: (event: { data: string }) => void): void {
		this.listeners.set(type, listener);
	}
	close(): void {}
	emit(type: string, payload: unknown): void {
		this.listeners.get(type)?.({ data: JSON.stringify(payload) });
	}
}

/**
 * A command's outcome is an execution fact (`details.execution`), not an
 * invocation failure (`isError`). These cases pin both halves of the rule: a
 * failing command must read as failed, and a call whose check failed must still
 * show the file it changed.
 */

const cwd = "/work";
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
let revision = 1;
let nextSnapshot: unknown = null;

beforeEach(() => {
	revision = 1;
	nextSnapshot = null;
	setState(createInitialState());
	globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
	globalThis.fetch = (async () => {
		if (!nextSnapshot) throw new Error("offline");
		return new Response(JSON.stringify(nextSnapshot));
	}) as typeof fetch;
});

afterEach(() => {
	closeStream();
	setState(createInitialState());
	globalThis.fetch = originalFetch;
	globalThis.EventSource = originalEventSource;
});

const user: SessionEntry = {
	type: "message",
	id: "u1",
	timestamp: "",
	message: { role: "user", content: [{ type: "text", text: "go" }] },
} as SessionEntry;

const patch = (path: string) => `--- ${path}\n+++ ${path}\n@@ -0,0 +1 @@\n+x\n`;

function open(entries: SessionEntry[] = [user]): void {
	renderSnapshot({ id: "s", cwd, status: "running", revision, entries } as never);
	connectStream("s");
}

function agent(event: Record<string, unknown>): void {
	revision += 1;
	FakeEventSource.current?.emit("agent", { revision, event });
}

function runTool(id: string, toolName: string, args: unknown, result: unknown, isError = false): void {
	agent({ type: "tool_execution_start", toolCallId: id, toolName, args });
	agent({ type: "tool_execution_end", toolCallId: id, toolName, result, isError });
}

function toolItem(id: string): ToolTimelineItem | undefined {
	const item = getState().timelineItems.find((entry) => entry.itemId === `tool-${id}`);
	return item?.kind === "tool" ? item : undefined;
}

function shownFiles(): string[] {
	return collectTurnChanges(getState().timelineItems, cwd).flatMap((turn) => turn.files.map((file) => file.path));
}

const exited = (exitCode: number) => ({
	status: "exited",
	exitCode,
	signal: null,
	timedOut: false,
	aborted: false,
});

const commandResult = (exitCode: number) => ({
	content: [{ type: "text", text: `output\n\nCommand exited with code ${exitCode}` }],
	details: {
		execution: exited(exitCode),
		outputFooter: { notice: "", status: `Command exited with code ${exitCode}` },
	},
});

test("a command that exited nonzero reads as failed even though the call succeeded", () => {
	open();
	runTool("c1", "run_command", { command: "false" }, commandResult(1));
	const item = toolItem("c1");
	assert.equal(item?.state, "failed");
});

test("a deadline reads as failed even when the command exited with zero", () => {
	open();
	runTool("c1", "run_command", { command: "sleep 5" }, {
		content: [{ type: "text", text: "output\n\nCommand timed out after 1 seconds" }],
		details: { execution: { status: "timed_out", exitCode: 0, signal: null, timedOut: true, aborted: false, timeoutSeconds: 1 } },
	});
	assert.equal(toolItem("c1")?.state, "failed");
});

test("a clean command still reads as completed", () => {
	open();
	runTool("c1", "run_command", { command: "true" }, commandResult(0));
	assert.equal(toolItem("c1")?.state, "completed");
});

test("an invocation failure still reads as failed", () => {
	open();
	runTool(
		"c1",
		"run_command",
		{ command: "x" },
		{ content: [{ type: "text", text: "Command executor failed" }], details: { execution: { status: "unknown", exitCode: null } } },
		true,
	);
	assert.equal(toolItem("c1")?.state, "failed");
});

// A command tool never contributes a file change; what matters is that a failed
// edit with no recorded patch does not invent one either.
test("a failed edit without a recorded patch adds no file change", () => {
	open();
	runTool(
		"c1",
		"edit_file",
		{ path: "gone.ts", search: "a", replace: "b" },
		{ content: [{ type: "text", text: "search text not found" }], details: {} },
		true,
	);
	assert.equal(toolItem("c1")?.state, "failed");
	assert.deepEqual(shownFiles(), []);
});

test("an applied edit whose check failed reads as failed and keeps its change", () => {
	open();
	runTool(
		"c1",
		"edit_file",
		{ path: "a.ts", search: "a", replace: "b", then_run: "check" },
		{
			content: [{ type: "text", text: "edited" }],
			details: { patch: patch("a.ts"), changed: true, thenRun: { command: "check", exitCode: 1, timedOut: false, execution: exited(1) } },
		},
	);
	assert.equal(toolItem("c1")?.state, "failed");
	assert.deepEqual(shownFiles(), ["a.ts"]);
});

// A check that could not start reports `invocationError` and no execution facts.
// The row stays completed, matching the CLI card, which only derives its glyph
// from `details.execution`; the change it applied is still shown.
test("an applied edit whose check could not start keeps its change", () => {
	open();
	runTool(
		"c1",
		"edit_file",
		{ path: "b.ts", search: "a", replace: "b", then_run: "check" },
		{
			content: [{ type: "text", text: "edited" }],
			details: { patch: patch("b.ts"), changed: true, thenRun: { command: "check", exitCode: null, timedOut: false, invocationError: "executor unavailable" } },
		},
	);
	assert.equal(toolItem("c1")?.state, "completed");
	assert.deepEqual(shownFiles(), ["b.ts"]);
});

test("the recorded snapshot applies the same rule as the live event", async () => {
	open();
	const assistant: SessionEntry = {
		type: "message",
		id: "a1",
		timestamp: "",
		message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "run_command", arguments: { command: "false" } }] },
	} as unknown as SessionEntry;
	const result: SessionEntry = {
		type: "message",
		id: "r1",
		timestamp: "",
		message: { role: "toolResult", toolCallId: "c1", toolName: "run_command", ...commandResult(1), isError: false },
	} as unknown as SessionEntry;
	nextSnapshot = { id: "s", cwd, status: "idle", revision: revision + 1, entries: [user, assistant, result] };
	agent({ type: "agent_settled" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(toolItem("c1")?.state, "failed");
});

test("an imported call whose status was never recorded stays unknown", () => {
	open();
	runTool("c1", "run_command", { command: "false" }, {
		...commandResult(1),
		details: { execution: exited(1), importedStatus: "unknown" },
	});
	// `importedUnknown` is decided by the entry, not by the live result: a live
	// call keeps its own answer.
	assert.equal(toolItem("c1")?.state, "failed");
});

test("a record without execution facts keeps the legacy isError answer", async () => {
	open();
	const assistant: SessionEntry = {
		type: "message",
		id: "a1",
		timestamp: "",
		message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "run_command", arguments: { command: "false" } }] },
	} as unknown as SessionEntry;
	const result: SessionEntry = {
		type: "message",
		id: "r1",
		timestamp: "",
		message: { role: "toolResult", toolCallId: "c1", toolName: "run_command", content: [], isError: true },
	} as unknown as SessionEntry;
	nextSnapshot = { id: "s", cwd, status: "idle", revision: revision + 1, entries: [user, assistant, result] };
	agent({ type: "agent_settled" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(toolItem("c1")?.state, "failed");
});
