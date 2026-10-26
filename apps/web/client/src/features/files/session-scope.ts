/**
 * File preview tabs belong to the session that opened them, the way each
 * session owns its own right-rail surface: switching to another session must
 * never leave the previous session's files in front of the new conversation,
 * where they read as that session's attachments or outputs.
 *
 * Leaving a session stashes its file tabs (and whether the Files panel was on
 * screen) in page memory; entering a session restores only its own tabs. File
 * contents are re-read from disk when a stashed tab never finished loading, so
 * a read that settled after the switch cannot leave a tab spinning. Side answers
 * are not stashed here: the host keeps them per session and the snapshot
 * restores them (`side-answers.ts`).
 */

import { activeRightPanel, openRightPanel } from "../../state/right-panel";
import { installPreviewSessionScope } from "../../state/session";
import { type FilePreviewTab, getState, setPreview } from "../../state/store";
import { loadPreviewTab } from "./actions";

interface SessionPreview {
	readonly tabs: readonly FilePreviewTab[];
	/** Index into `tabs`, -1 when the active tab was a side answer. */
	readonly active: number;
	/** The Files panel was the visible right panel when the session was left. */
	readonly showing: boolean;
}

/** Sessions remembered per page load; the oldest stash is dropped first. */
const SESSION_PREVIEW_LIMIT = 50;
const sessionPreviews = new Map<string, SessionPreview>();

function stash(sessionId: string): boolean {
	const state = getState();
	const showing = activeRightPanel(state) === "files";
	const tabs = state.preview.tabs.filter((tab): tab is FilePreviewTab => tab.kind === "file");
	sessionPreviews.delete(sessionId);
	if (!tabs.length) return showing;
	const activeTab = state.preview.tabs[state.preview.active];
	sessionPreviews.set(sessionId, {
		tabs,
		active: activeTab?.kind === "file" ? tabs.indexOf(activeTab) : -1,
		showing,
	});
	for (const key of sessionPreviews.keys()) {
		if (sessionPreviews.size <= SESSION_PREVIEW_LIMIT) break;
		sessionPreviews.delete(key);
	}
	return showing;
}

/**
 * Replace the preview's tabs with the ones `nextId` owns. `previousId` is the
 * session being left (undefined for a draft, whose tabs are not kept); `nextId`
 * undefined enters a fresh draft.
 */
export function switchPreviewSession(previousId: string | undefined, nextId: string | undefined): void {
	const showing = previousId ? stash(previousId) : activeRightPanel(getState()) === "files";
	const restored = nextId ? sessionPreviews.get(nextId) : undefined;
	// A read in flight when the session was left settles against tabs that are
	// no longer on screen; such a tab is re-read instead of spinning forever.
	const stale = (tab: FilePreviewTab) => tab.loading || (!tab.file && !tab.error);
	const tabs = (restored?.tabs ?? []).map((tab) => (tab.loading ? { ...tab, loading: false } : tab));
	const active = tabs.length ? Math.max(0, restored?.active ?? 0) : -1;
	setPreview((preview) => ({
		...preview,
		tabs,
		active,
		// The turn shown in the changes view belonged to the session being left.
		changes: null,
		open: preview.mode === "files" ? preview.open && tabs.length > 0 : preview.open,
	}));
	if (showing && !tabs.length) {
		// Nothing of this session's to show: hide the rail rather than an empty Files panel.
		openRightPanel(null);
	} else if (!showing && restored?.showing && tabs.length && activeRightPanel(getState()) === null) {
		// The session was left with its files on screen; bring them back unless another panel is open.
		openRightPanel("files");
	}
	for (const tab of restored?.tabs ?? []) {
		if (stale(tab)) void loadPreviewTab(tab.cwd, tab.path, tab.scope);
	}
}

/** A deleted session's tabs can never be restored. */
export function forgetPreviewSession(sessionId: string): void {
	sessionPreviews.delete(sessionId);
}

// `state/session.ts` cannot import a feature; the files feature installs its session scope here.
installPreviewSessionScope({ switch: switchPreviewSession, forget: forgetPreviewSession });
