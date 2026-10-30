import assert from "node:assert/strict";
import { afterEach, test, type TestContext } from "node:test";
import {
	isDefaultProject,
	isDefaultWorkspace,
	knownWorkspaces,
	startDraft,
	workspaceForNewConversation,
	workspaceLabel,
} from "../client/src/state/session.ts";
import { t } from "../client/src/i18n/index.ts";
import { removeWorkspace } from "../client/src/features/workspace/actions.ts";
import { createInitialState, getState, setState, setUi } from "../client/src/state/store.ts";
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

/**
 * Answer the requests these tests cause, inside the test that causes them.
 * `startDraft` immediately loads the new draft's model panel, and the removal
 * action re-reads the workspace list. Left to the real fetch, the relative URL
 * throws, `showError` raises the toast, and its 4.2s dismiss timer holds this
 * file's process open long after the assertions passed.
 *
 * `t.mock` restores the stub when the test ends; a module-level `mock.method`
 * would leak a fake `fetch` into every later test in the file.
 */
function stubFetch(t: TestContext, workspaces: readonly WebWorkspace[] = []): void {
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) =>
		String(input).startsWith("/api/v1/workspaces") ? Response.json({ workspaces }) : Response.json({}),
	);
}

/** Let the draft's fire-and-forget model request settle before the test ends. */
function settle(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

test("the first-use workspace is named in the reader's language, other folders by their own name", () => {
	const first = "/Users/a/Documents/StepCode/default-workspace";
	setState({
		workspaces: [workspace(first, { default: true }), workspace("/work/default-workspace")],
	});
	assert.equal(isDefaultWorkspace(getState(), first), true);
	assert.equal(workspaceLabel(getState(), first), t("defaultWorkspace"));
	assert.notEqual(t("defaultWorkspace"), "default-workspace");
	// Only the folder the host created is relabeled, not every folder sharing its name.
	assert.equal(isDefaultWorkspace(getState(), "/work/default-workspace"), false);
	assert.equal(workspaceLabel(getState(), "/work/default-workspace"), "default-workspace");
});

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

test("a new conversation never starts in a folder that was removed", async (t) => {
	stubFetch(t);
	// A removed folder keeps its chats, so one can still be open. "New
	// conversation" used to inherit it through `activeCwd()`, and the session it
	// created lived in a workspace the picker could no longer even list.
	setState({
		bootstrapCwd: "/work/other",
		workspaces: [workspace("/work/other"), workspace("/work/project", { hidden: true })],
		current: { id: "s1", cwd: "/work/project", status: "idle" } as never,
	});
	assert.equal(workspaceForNewConversation(getState()), "/work/other");
	startDraft("/work/project");
	assert.equal(getState().draftCwd, "/work/other");
	assert.equal(getState().current, null);
	await settle();
});

test("a removed launch folder falls back to a workspace that is still on offer", () => {
	setState({
		bootstrapCwd: "/work/project",
		workspaces: [workspace("/work/project", { hidden: true }), workspace("/work/other")],
		current: { id: "s1", cwd: "/work/project", status: "idle" } as never,
	});
	assert.equal(workspaceForNewConversation(getState()), "/work/other");
});

test("the launch folder is the last resort when every workspace was removed", () => {
	// The host still has to work somewhere; naming no folder would leave the
	// composer unable to start a session at all. The host normally reports a
	// `defaultCwd` in this situation — see the next test — so this only covers a
	// page that has not learned one yet.
	setState({
		bootstrapCwd: "/work/project",
		workspaces: [workspace("/work/project", { hidden: true })],
	});
	assert.equal(workspaceForNewConversation(getState()), "/work/project");
});

test("a removed launch folder sends new work to the host's default folder, not the deleted one", async (t) => {
	// Desktop launches the host in the folder it last picked and stores that
	// pick. Removing that folder from navigation left it as the launch folder,
	// so "New conversation" with an empty workspace list kept starting there —
	// in a workspace the picker could no longer even list. The host answers with
	// a home fallback instead, and the page uses it.
	stubFetch(t);
	setState({
		bootstrapCwd: "/work/project",
		defaultCwd: "/home/me",
		defaultCwdFallback: true,
		workspaces: [workspace("/work/project", { hidden: true })],
	});
	assert.equal(workspaceForNewConversation(getState()), "/home/me");
	startDraft("/work/project");
	assert.equal(getState().draftCwd, "/home/me");
	assert.equal(getState().ui.draftRow, null);
	await settle();
});

test("only the fallback folder is presented as the default project", () => {
	setState({
		bootstrapCwd: "/work/project",
		defaultCwd: "/home/me",
		defaultCwdFallback: true,
		workspaces: [workspace("/work/project", { hidden: true })],
	});
	assert.equal(isDefaultProject(getState(), "/home/me"), true, "the home fallback is the default project");
	assert.equal(isDefaultProject(getState(), "/work/project"), false, "the deleted folder is not");

	// A usable launch folder keeps its own name: the label must not rename a
	// real project the user opened.
	setState({ defaultCwd: "/work/project", defaultCwdFallback: false });
	assert.equal(isDefaultProject(getState(), "/work/project"), false);

	// Registering the fallback folder makes it a workspace with its own name again.
	setState({ defaultCwd: "/home/me", defaultCwdFallback: true, workspaces: [workspace("/home/me")] });
	assert.equal(isDefaultProject(getState(), "/home/me"), false);
});

test("a visible draft folder is left alone", async (t) => {
	stubFetch(t);
	setState({
		bootstrapCwd: "/work/other",
		draftCwd: "/work/third",
		workspaces: [workspace("/work/other"), workspace("/work/third"), workspace("/work/project", { hidden: true })],
	});
	startDraft("/work/third");
	assert.equal(getState().draftCwd, "/work/third");
	await settle();
});

test("removing the folder a listed draft sits in moves the row with it", async (t) => {
	// The draft's sidebar placeholder used to vanish with its folder: the reroute
	// started a fresh draft without the row, so the conversation disappeared from
	// the rail until a reload.
	setState({
		bootstrapCwd: "/work/other",
		draftCwd: "/work/project",
		workspaces: [workspace("/work/project"), workspace("/work/other")],
	});
	setUi({ workspaceRemoval: { path: "/work/project", pending: false }, draftRow: "/work/project" });
	stubFetch(t, [workspace("/work/project", { hidden: true }), workspace("/work/other")]);
	await removeWorkspace();
	await settle();
	assert.equal(getState().draftCwd, "/work/other", "the draft moves to a workspace still on offer");
	assert.equal(getState().ui.draftRow, "/work/other", "its sidebar row follows it");
	assert.equal(getState().ui.workspaceRemoval, null, "the dialog closes");
});

test("removing the folder an unlisted draft sits in starts no row", async (t) => {
	setState({
		bootstrapCwd: "/work/other",
		draftCwd: "/work/project",
		workspaces: [workspace("/work/project"), workspace("/work/other")],
	});
	setUi({ workspaceRemoval: { path: "/work/project", pending: false }, draftRow: null });
	stubFetch(t, [workspace("/work/project", { hidden: true }), workspace("/work/other")]);
	await removeWorkspace();
	await settle();
	assert.equal(getState().draftCwd, "/work/other");
	assert.equal(getState().ui.draftRow, null, "a draft that was never listed gains no row");
});

test("removing a workspace while another pane is open leaves that pane in place", async (t) => {
	// The reroute starts a draft, which normally replaces the pane; here the user
	// is reading the plugin market and only the draft's folder changed.
	setState({
		bootstrapCwd: "/work/other",
		draftCwd: "/work/project",
		workspaces: [workspace("/work/project"), workspace("/work/other")],
	});
	setUi({ workspaceRemoval: { path: "/work/project", pending: false }, draftRow: null, midView: "market" });
	stubFetch(t, [workspace("/work/project", { hidden: true }), workspace("/work/other")]);
	await removeWorkspace();
	await settle();
	assert.equal(getState().draftCwd, "/work/other");
	assert.equal(getState().ui.midView, "market", "the pane the user was reading stays open");
});
