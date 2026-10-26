/**
 * File preview tabs belong to the session that opened them: switching to
 * another session never leaves the previous session's file in front of the
 * new conversation, and coming back restores it.
 */

import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { openFile } from "../client/src/features/files/actions.ts";
import "../client/src/features/files/session-scope.ts";
import { activeRightPanel, openRightPanel } from "../client/src/state/right-panel.ts";
import { renderSnapshot, startDraft } from "../client/src/state/session.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";

afterEach(() => {
	mock.restoreAll();
	setState(createInitialState());
});

function snapshot(id: string) {
	return { id, cwd: "/work", status: "idle" as const, entries: [] };
}

function fileResponse(path: string): Response {
	return new Response(JSON.stringify({ kind: "text", path, size: 1, content: path }));
}

function filePaths(): string[] {
	return getState().preview.tabs.flatMap((tab) => (tab.kind === "file" ? [tab.path] : []));
}

test("switching sessions hides the previous session's files and restores them on return", async () => {
	mock.method(globalThis, "fetch", async (input: string | URL) =>
		fileResponse(new URL(String(input), "http://host").searchParams.get("path") ?? ""),
	);
	renderSnapshot(snapshot("scope-a"));
	await openFile("/work", "auth-qr.png");
	assert.deepEqual(filePaths(), ["auth-qr.png"]);
	assert.equal(activeRightPanel(getState()), "files");

	renderSnapshot(snapshot("scope-b"));
	assert.deepEqual(filePaths(), [], "B must not show A's file");
	assert.equal(getState().preview.active, -1);
	assert.equal(activeRightPanel(getState()), null, "An empty Files panel is hidden");

	await openFile("/work", "review.docx");
	renderSnapshot(snapshot("scope-a"));
	assert.deepEqual(filePaths(), ["auth-qr.png"]);
	assert.equal(activeRightPanel(getState()), "files");

	renderSnapshot(snapshot("scope-b"));
	assert.deepEqual(filePaths(), ["review.docx"]);
});

test("another open panel stays open and a session left with its files hidden does not reopen them", async () => {
	mock.method(globalThis, "fetch", async () => fileResponse("notes.md"));
	renderSnapshot(snapshot("panel-a"));
	await openFile("/work", "notes.md");
	openRightPanel("summary");
	renderSnapshot(snapshot("panel-b"));
	assert.equal(activeRightPanel(getState()), "summary");
	assert.deepEqual(filePaths(), []);
	openRightPanel(null);
	renderSnapshot(snapshot("panel-a"));
	assert.deepEqual(filePaths(), ["notes.md"]);
	assert.equal(activeRightPanel(getState()), null);
});

test("a read that settles after the switch is re-read when its session returns", async () => {
	let release: (() => void) | undefined;
	const fetch = mock.method(globalThis, "fetch", async () => {
		if (!release) await new Promise<void>((resolve) => (release = resolve));
		return fileResponse("slow.txt");
	});
	renderSnapshot(snapshot("late-a"));
	const opening = openFile("/work", "slow.txt");
	await new Promise((resolve) => setTimeout(resolve, 0));
	renderSnapshot(snapshot("late-b"));
	release?.();
	await opening;
	assert.deepEqual(filePaths(), [], "A late read never lands in another session");
	renderSnapshot(snapshot("late-a"));
	await new Promise((resolve) => setTimeout(resolve, 0));
	const [tab] = getState().preview.tabs;
	assert.equal(tab?.kind === "file" && tab.file?.path, "slow.txt");
	assert.equal(tab?.kind === "file" && tab.loading, false);
	assert.equal(fetch.mock.calls.length, 2);
});

test("a new conversation starts without the left session's files; a draft's files carry into its session", async () => {
	mock.method(globalThis, "fetch", async () => fileResponse("draft.md"));
	renderSnapshot(snapshot("draft-a"));
	await openFile("/work", "a.md");
	startDraft("/work");
	assert.deepEqual(filePaths(), []);
	await openFile("/work", "draft.md");
	// What `createSessionIfNeeded` renders once the draft's first send created its session.
	renderSnapshot(snapshot("draft-session"), { adoptDraft: true });
	assert.deepEqual(filePaths(), ["draft.md"]);
});
