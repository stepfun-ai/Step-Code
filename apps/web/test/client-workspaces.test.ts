import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { knownWorkspaces } from "../client/src/state/session.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";
import type { SessionSummary, WebWorkspace } from "../client/src/state/types.ts";

/**
 * The two lists a removed workspace must leave: the sidebar's project groups
 * and the composer's workspace picker. Both are projections over the same
 * state, so both are checked here.
 */

afterEach(() => setState(createInitialState()));

function workspace(path: string, extra: Partial<WebWorkspace> = {}): WebWorkspace {
	return { path, name: path.split("/").at(-1) ?? path, available: true, ...extra };
}

function session(id: string, cwd: string): SessionSummary {
	return { id, cwd, cwdAvailable: true } as SessionSummary;
}

test("a hidden workspace leaves the composer's list even though its sessions remain", () => {
	setState({
		bootstrapCwd: "/work/other",
		workspaces: [workspace("/work/project"), workspace("/work/project", { hidden: true })],
		sessions: [session("s1", "/work/project")],
	});
	assert.deepEqual(knownWorkspaces(getState()), ["/work/other"]);
});

test("a workspace that is still visible stays selectable", () => {
	setState({
		bootstrapCwd: "/work/other",
		workspaces: [workspace("/work/project")],
		sessions: [session("s1", "/work/project")],
	});
	assert.deepEqual(knownWorkspaces(getState()), ["/work/other", "/work/project"]);
});

test("the open session's own folder is dropped once it is removed", () => {
	// The composer used to keep offering the folder of the conversation on screen.
	setState({
		bootstrapCwd: "/work/other",
		workspaces: [workspace("/work/project", { hidden: true })],
		current: { id: "s1", cwd: "/work/project", status: "idle" } as never,
	});
	assert.deepEqual(knownWorkspaces(getState()), ["/work/other"]);
});
