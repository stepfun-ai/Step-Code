/**
 * The empty state of workspace navigation names the actual condition.
 *
 * With no workspace on offer, the composer's picker used to borrow the
 * directory browser's "没有子文件夹" — a line about browsing a folder that
 * holds no subfolders, not about an empty workspace list — and the sidebar's
 * project list claimed "还没有项目会话。" while the user's chats sat under
 * Recent. Both now say there is no workspace. Copy is invisible to the
 * state-level tests, so the wiring is guarded here, as the empty-session
 * layout is guarded in client-empty-session-style.test.ts.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const picker = await readFile(
	new URL("../client/src/features/workspace/WorkspaceControl.tsx", import.meta.url),
	"utf8",
);
const projects = await readFile(new URL("../client/src/features/sidebar/ProjectView.tsx", import.meta.url), "utf8");
const messages = await readFile(new URL("../client/src/i18n/messages.ts", import.meta.url), "utf8");

test("the workspace picker's empty state says there is no workspace", () => {
	assert.match(picker, /t\("noWorkspaces"\)/u);
	// The directory browser's "no subfolders" describes a different surface.
	assert.doesNotMatch(picker, /t\("emptyDirectory"\)/u);
	// An empty list has no folders to title, so the heading is not drawn.
	assert.match(picker, /workspaces\.length \? <div className="workspace-popover-title">/u);
});

test("the sidebar's project list says there is no workspace when none is on offer", () => {
	assert.match(projects, /registered\.size/u);
	assert.match(projects, /t\("noWorkspaces"\)/u);
	// A workspace that exists but holds no conversation keeps its own wording.
	assert.match(projects, /t\("noProjectConversations"\)/u);
});

test("the message exists in both dictionaries", () => {
	assert.match(messages, /\tnoWorkspaces: "无工作空间"/u);
	assert.match(messages, /\tnoWorkspaces: "No workspace"/u);
});
