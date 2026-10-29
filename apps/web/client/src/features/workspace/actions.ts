/**
 * Workspace actions with fixed names, callable from any feature. Foundation
 * ported them from legacy app.js; the workspace feature owns this file.
 */

import { t } from "../../i18n";
import { api, apiSend, errorMessage, workspaceApi } from "../../lib/api";
import { getDesktopBridge } from "../../platform/host";
import {
	isHiddenWorkspace,
	refreshWorkspaces,
	showError,
	startDraft,
	workspaceForNewConversation,
} from "../../state/session";
import { getState, setState, setUi, setWithout } from "../../state/store";
import type { DirectoryListing, WebWorkspace } from "../../state/types";

export { refreshWorkspaces } from "../../state/session";

/** Register a folder as a workspace and start a draft conversation in it (legacy `addWorkspace`, 1990-2003). */
export async function addWorkspace(path: string): Promise<void> {
	try {
		const workspace = await apiSend<WebWorkspace>("/api/v1/workspaces", "POST", { path });
		await refreshWorkspaces();
		setState((state) => ({ foldedProjects: setWithout(state.foldedProjects, workspace.path) }));
		startDraft(workspace.path);
		showError(t("workspaceSwitched", { name: workspace.name }), false);
	} catch (error) {
		showError(errorMessage(error));
	}
}

export function requestWorkspaceRemoval(path: string): void {
	if (getState().ui.workspaceRemoval?.pending) return;
	setUi({ workspaceRemoval: { path, pending: false } });
}

export function closeWorkspaceRemoval(): void {
	if (!getState().ui.workspaceRemoval?.pending) setUi({ workspaceRemoval: null });
}

/** Confirmed navigation removal; never deletes files or sessions. */
export async function removeWorkspace(): Promise<void> {
	const removal = getState().ui.workspaceRemoval;
	if (!removal || removal.pending) return;
	const { path } = removal;
	setUi({ workspaceRemoval: { path, pending: true } });
	try {
		await api(`/api/v1/workspaces?${new URLSearchParams({ path })}`, { method: "DELETE" });
		await refreshWorkspaces();
		const state = getState();
		// A draft in the folder being removed moves to a workspace that is still on
		// offer; otherwise its group would come straight back as an empty project
		// and the composer would keep naming a folder the picker no longer lists.
		if (!state.current && state.draftCwd && isHiddenWorkspace(state, state.draftCwd)) {
			// The draft's sidebar row follows it: dropping it would make the draft
			// disappear from the rail until the next reload.
			const midView = state.ui.midView;
			startDraft(workspaceForNewConversation(state), { listed: state.ui.draftRow !== null });
			// Only the draft's folder changed, so whatever the user was reading
			// (cron, the plugin market) stays open instead of being replaced.
			if (midView) setUi({ midView });
		}
		setUi({ workspaceRemoval: null });
	} catch (error) {
		setUi({ workspaceRemoval: { path, pending: false } });
		showError(errorMessage(error));
	}
}

/** Show the recent-folders popover (legacy `openWorkspacePopover`, 1125-1129; the list renders from the store). */
export function openWorkspacePopover(): void {
	setUi({ workspacePopoverOpen: true });
}

/** Hide the recent-folders popover (legacy `closeWorkspacePopover`, 1131-1134). */
export function closeWorkspacePopover(): void {
	setUi({ workspacePopoverOpen: false });
}

let resourceDirectoryAnswer: ((path: string | null) => void) | undefined;

/** Hide the browser and settle any resource pick, without changing workspace registration or the draft. */
export function closeWorkspaceBrowser(): void {
	setUi({ workspaceBrowserOpen: false, workspaceBrowserPurpose: "workspace" });
	const answer = resourceDirectoryAnswer;
	resourceDirectoryAnswer = undefined;
	answer?.(null);
}

export async function confirmWorkspaceBrowser(path: string): Promise<void> {
	if (getState().ui.workspaceBrowserPurpose === "resource") {
		const answer = resourceDirectoryAnswer;
		resourceDirectoryAnswer = undefined;
		setUi({ workspaceBrowserOpen: false, workspaceBrowserPurpose: "workspace" });
		answer?.(path);
	} else {
		closeWorkspaceBrowser();
		await addWorkspace(path);
	}
}

/**
 * Select an existing directory for migration without registering it as a workspace,
 * switching the draft or mutating the next-launch workspace. The title distinguishes
 * destination picks from read-only source picks in dialogs.
 */
export async function chooseResourceDirectory(title: string = t("migrationPickTarget")): Promise<string | null> {
	if (getState().pickingFolder || resourceDirectoryAnswer || getState().ui.workspaceBrowserOpen) return null;
	setState({ pickingFolder: true });
	try {
		const state = getState();
		const bridge = getDesktopBridge();
		try {
			if (bridge)
				return await bridge.pickDirectory({
					title,
					defaultPath: state.draftCwd || state.bootstrapCwd || undefined,
					purpose: "resource",
				});
			if (state.directoryPicker === "native") {
				const result = await apiSend<{ path?: string | null }>("/api/v1/workspaces/pick", "POST", {
					title,
					startIn: state.draftCwd || state.bootstrapCwd,
				});
				return result.path ?? null;
			}
		} catch {
			// Unavailable native dialogs fall back to the same in-page browser, with resource-only ownership.
		}
		setUi({ workspaceBrowserOpen: true, workspaceBrowserPurpose: "resource" });
		const result = new Promise<string | null>((resolve) => {
			resourceDirectoryAnswer = resolve;
		});
		await loadWorkspaceDirectory(state.draftCwd || state.bootstrapCwd);
		document.getElementById("workspacePathInput")?.focus();
		return await result;
	} finally {
		setState({ pickingFolder: false });
	}
}

/** List one directory in the in-page browser (legacy `loadWorkspaceDirectory`, 1164-1178). */
export async function loadWorkspaceDirectory(path: string): Promise<void> {
	try {
		const data = await api<DirectoryListing>(`/api/v1/directories?path=${encodeURIComponent(path || "")}`);
		setState({ workspaceBrowser: data });
	} catch (error) {
		showError(errorMessage(error));
	}
}

/**
 * Show the in-page folder browser at the current draft folder (legacy
 * `openWorkspaceBrowser`, 1180-1185). Focuses `#workspacePathInput` once the
 * listing has loaded, as the legacy code did.
 */
export async function openWorkspaceBrowser(): Promise<void> {
	closeWorkspacePopover();
	setUi({ workspaceBrowserOpen: true });
	const state = getState();
	await loadWorkspaceDirectory(state.draftCwd || state.bootstrapCwd);
	document.getElementById("workspacePathInput")?.focus();
}

async function pickWithDesktopBridge(): Promise<void> {
	const bridge = getDesktopBridge();
	if (!bridge) return;
	const state = getState();
	const path = await bridge.pickDirectory({
		title: t("pickWorkspaceFolder"),
		defaultPath: state.draftCwd || state.bootstrapCwd || undefined,
	});
	if (path) await addWorkspace(path);
}

async function pickWithServer(): Promise<void> {
	const state = getState();
	const { path } = await apiSend<{ path?: string | null }>("/api/v1/workspaces/pick", "POST", {
		title: t("pickWorkspaceFolder"),
		startIn: state.draftCwd || state.bootstrapCwd,
	});
	if (path) await addWorkspace(path);
}

/**
 * "Add workspace" (legacy `chooseWorkspaceFolder`, 2014-2038).
 *
 * Order of preference: the desktop shell's native chooser
 * (`window.stepcodeDesktop.pickDirectory`), then the host's system chooser
 * when the bootstrap reported `directoryPicker: "native"`, then the in-page
 * browser. A failing native chooser falls back to the in-page browser rather
 * than leaving the button dead. Only one chooser request runs at a time;
 * `state.pickingFolder` drives `#addWorkspace[aria-busy]`.
 */
export async function chooseWorkspaceFolder(): Promise<void> {
	const desktop = getDesktopBridge() !== undefined;
	if (!desktop && getState().directoryPicker !== "native") {
		await openWorkspaceBrowser();
		return;
	}
	if (getState().pickingFolder) return;
	setState({ pickingFolder: true });
	try {
		if (desktop) await pickWithDesktopBridge();
		else await pickWithServer();
	} catch (error) {
		showError(t("folderPickerFailed", { reason: errorMessage(error) }));
		await openWorkspaceBrowser();
	} finally {
		setState({ pickingFolder: false });
	}
}

/** Show a workspace folder in Finder / File Explorer; the Host opens it, so Web and Desktop behave the same. */
export async function openWorkspaceFolder(cwd: string): Promise<void> {
	try {
		await api(workspaceApi(cwd, "/open"), { method: "POST" });
	} catch (error) {
		showError(t("workspaceOpenFolderFailed", { error: errorMessage(error) }));
	}
}
