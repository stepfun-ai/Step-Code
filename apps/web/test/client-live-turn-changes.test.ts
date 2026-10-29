import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { collectTurnChanges } from "../client/src/lib/turn-changes.ts";
import { closeStream, connectStream, renderSnapshot } from "../client/src/state/session.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";
import type { SessionEntry, SessionSnapshot } from "../client/src/state/types.ts";

/** The page's stream, driven by the test: `emit` delivers one SSE event to the listener the client registered. */
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

const cwd = "C:\\work";
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
let revision = 1;
/** Snapshot reads the client issues; each answers with `nextSnapshot` or fails when it is null. */
let nextSnapshot: SessionSnapshot | null = null;

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
	renderSnapshot({ id: "s", cwd, status: "running", revision, entries });
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

function shownFiles(): Array<[string, number]> {
	const turns = collectTurnChanges(getState().timelineItems, cwd);
	return turns.flatMap((turn) => turn.files.map((file): [string, number] => [file.path, file.additions]));
}

test("a finished edit or write shows in the turn's changes before any snapshot", () => {
	open();
	runTool("c1", "write_file", { path: "data-doc.json", content: "x\n" }, { details: { changed: true, patch: patch("data-doc.json") } });
	runTool("c2", "edit_file", { path: "C:\\work\\src\\a.ts", search: "a", replace: "b" }, { details: { patch: patch("a.ts") } });
	runTool("c3", "edit", { file_path: "b.ts" }, { details: { patch: patch("b.ts") } });
	runTool("c4", "write", { path: "big.bin" }, { details: { untracked: "binary" } });
	assert.deepEqual(shownFiles(), [
		["data-doc.json", 1],
		["src\\a.ts", 1],
		["b.ts", 1],
		["big.bin", 0],
	]);
});

test("a failed, unchanged or unfinished call adds no change", () => {
	open();
	runTool("c1", "write_file", { path: "a.json" }, { details: { patch: patch("a.json") } }, true);
	runTool("c2", "write_file", { path: "b.json" }, { details: { changed: false } });
	agent({ type: "tool_execution_start", toolCallId: "c3", toolName: "edit_file", args: { path: "c.json" } });
	agent({ type: "tool_execution_end", toolCallId: "c4", toolName: "run_command", result: { details: {} } });
	assert.deepEqual(shownFiles(), []);
});

test("a write whose then_run command failed still shows the file it changed", () => {
	open();
	runTool(
		"c1",
		"edit_file",
		{ path: "a.ts", search: "a", replace: "b", then_run: "npm test" },
		{ details: { patch: patch("a.ts"), thenRun: { command: "npm test", exitCode: 1, timedOut: false } } },
	);
	assert.deepEqual(shownFiles(), [["a.ts", 1]]);
});

test("a repeated end event does not count the change twice", () => {
	open();
	const result = { details: { patch: patch("a.ts") } };
	runTool("c1", "edit_file", { path: "a.ts" }, result);
	agent({ type: "tool_execution_end", toolCallId: "c1", toolName: "edit_file", result, isError: false });
	assert.deepEqual(shownFiles(), [["a.ts", 1]]);
});

test("the recorded snapshot after the turn keeps the same changes once", async () => {
	open();
	const args = { path: "a.ts" };
	const result = { content: [{ type: "text", text: "ok" }], details: { patch: patch("a.ts") } };
	runTool("c1", "edit_file", args, result);
	nextSnapshot = {
		id: "s",
		cwd,
		status: "idle",
		revision: revision + 1,
		entries: [
			user,
			{ type: "message", id: "a1", timestamp: "", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "edit_file", arguments: args }] } },
			{ type: "message", id: "r1", timestamp: "", message: { role: "toolResult", toolCallId: "c1", isError: false, ...result } },
		] as SessionEntry[],
	};
	agent({ type: "agent_settled" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(getState().current?.status, "idle");
	assert.deepEqual(shownFiles(), [["a.ts", 1]]);
});

test("a failed snapshot read leaves the live changes in place", async () => {
	open();
	runTool("c1", "write_file", { path: "a.json" }, { details: { patch: patch("a.json") } });
	agent({ type: "agent_settled" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(shownFiles(), [["a.json", 1]]);
});
