/**
 * Document-level listeners owned by the shell: the global keyboard shortcuts
 * and the central Escape chain (legacy app.js 3599-3644), and the OS theme
 * listener (3647-3649). Renders nothing.
 */

import { useEffect } from "react";
import { activeRightPanel, closeRightPanel } from "../../state/right-panel";
import {
	activeCwd,
	backgroundSessionBusy,
	closeRenameSession,
	interruptCurrent,
	refreshSessionStatuses,
	refreshSessions,
	refreshWorkspaces,
} from "../../state/session";
import { type AppState, getState, setUi, useAppStore } from "../../state/store";
import { handleTagGroupBeforeUnload } from "../../state/tag-group-persistence";
import { answerSelection, answerTextInput, pendingSelection, pendingTextInput } from "../composer/actions";
import { openTree, setPreviewOpen } from "../files/actions";
import { closeTopmostSettingsLayer } from "../settings/actions";
import { closeSearch, closeWorkspaceMenu, openSearch } from "../sidebar/actions";
import { toggleTerminalDock } from "../terminal/actions";
import { requestVoiceStop, voiceRecording } from "../voice/actions";
import { chooseWorkspaceFolder, closeWorkspaceRemoval } from "../workspace/actions";
import { closeLogoutConfirm, confirmLogout, toggleSidebar, watchSystemTheme } from "./actions";

/**
 * Escape closes the topmost overlay, first match only, and otherwise stops the
 * running turn (legacy 3631-3643). Overlays in this chain do not close
 * themselves on Escape. State is read at key time, so an overlay that an
 * earlier (React) handler just closed is skipped, exactly as the legacy chain
 * saw it already hidden.
 */
function handleEscape(): void {
	const state = getState();
	const { ui } = state;
	// A running dictation owns the microphone; Escape ends it before anything
	// else sees the key, so a stop never also closes an overlay.
	if (voiceRecording()) {
		requestVoiceStop();
		return;
	}
	// A kernel question blocks its session and sits above everything else;
	// Escape dismisses it, which the kernel reads as "cancel".
	const selection = pendingSelection(state);
	const textInput = pendingTextInput(state);
	if (selection) void answerSelection(selection, undefined);
	else if (textInput) void answerTextInput(textInput, undefined);
	else if (ui.logoutConfirm) closeLogoutConfirm();
	else if (ui.renameSession) closeRenameSession();
	else if (ui.imagePreview) setUi({ imagePreview: null });
	else if (ui.accountMenuOpen) setUi({ accountMenuOpen: false });
	else if (ui.workspaceRemoval) closeWorkspaceRemoval();
	else if (ui.fileCompletionOpen) setUi({ fileCompletionOpen: false });
	else if (ui.slashMenu) setUi({ slashMenu: null });
	else if (ui.changesMenu) setUi({ changesMenu: null });
	else if (ui.rightPanelMenu) setUi({ rightPanelMenu: false });
	else if (ui.searchOpen) closeSearch();
	else if (ui.workspaceBrowserOpen) setUi({ workspaceBrowserOpen: false });
	else if (closeTopmostSettingsLayer()) return;
	else if (ui.workspacePopoverOpen) setUi({ workspacePopoverOpen: false });
	else if (ui.branchCreateOpen) setUi({ branchCreateOpen: false });
	else if (ui.branchPopoverOpen) setUi({ branchPopoverOpen: false });
	else if (ui.tagPicker) setUi({ tagPicker: null });
	else if (ui.workspaceMenu) closeWorkspaceMenu(true);
	else if (ui.sessionMenu) setUi({ sessionMenu: null });
	else if (ui.streamMenu) setUi({ streamMenu: false });
	else if (ui.fileTreeOpen) setUi({ fileTreeOpen: false });
	else if (ui.midView) setUi({ midView: null });
	else if (ui.rightPanelExpanded) setUi({ rightPanelExpanded: false });
	// Summary opens by itself on wide windows and on task activity, so it must not absorb the
	// Escape that stops a running turn; it still closes on Escape while the session is idle.
	else if (activeRightPanel(state) && !(activeRightPanel(state) === "summary" && sessionBusy(state)))
		closeRightPanel();
	else void interruptCurrent();
}

function sessionBusy(state: AppState): boolean {
	return state.current?.status === "running" || state.current?.status === "waiting";
}

function handleKeydown(event: KeyboardEvent): void {
	if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
	// The sign-in gate cannot be dismissed, and nothing behind it may act.
	if (getState().ui.loginRequired) return;
	if (event.ctrlKey && !event.metaKey && !event.altKey && event.code === "Backquote") {
		event.preventDefault();
		toggleTerminalDock();
		return;
	}
	// Keys typed into a shell belong to it: Escape (vi, less), Ctrl+B/K (readline, tmux) and the like.
	// Only Cmd chords, which a terminal never receives on macOS, keep their app meaning there.
	if (event.target instanceof Element && event.target.closest("#terminalDock .terminal-output") && !event.metaKey)
		return;
	const mod = event.metaKey || event.ctrlKey;
	// Autofill and some IMEs dispatch keydown without a `key`.
	const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
	// The log-out dialog's ↵ hint holds wherever focus is (it can land on the
	// page behind, e.g. after a click on the dialog text). A focused dialog
	// button keeps its own Enter, so Enter on Cancel still cancels.
	if (event.key === "Enter" && !event.isComposing && !mod && getState().ui.logoutConfirm) {
		const target = event.target;
		if (!(target instanceof HTMLButtonElement && target.closest("#logoutDialog"))) {
			event.preventDefault();
			void confirmLogout();
		}
		return;
	}
	// With Alt held, macOS reports the composed character in `key`, so the
	// Alt chords match on the physical key instead.
	if (mod && event.altKey && event.code === "KeyO") {
		event.preventDefault();
		void chooseWorkspaceFolder();
		return;
	}
	if (mod && event.altKey && event.code === "KeyP") {
		event.preventDefault();
		const cwd = activeCwd();
		if (cwd) void openTree({ cwd });
		return;
	}
	if (mod && key === "b") {
		event.preventDefault();
		if (event.shiftKey) {
			const { preview } = getState();
			if (preview.tabs.length || preview.changes) setPreviewOpen(!preview.open);
		} else toggleSidebar();
	}
	if (mod && key === "k") {
		event.preventDefault();
		openSearch();
	}
	// A handled Escape (an overlay closed itself, or a field consumed it) closes nothing else.
	if (event.key === "Escape" && !event.defaultPrevented) handleEscape();
}

/** How often the rows of sessions running in the background are re-read. */
const BACKGROUND_STATUS_POLL_MS = 2000;
/** One focus can fire `focus` and `visibilitychange` back to back; read the lists once. */
const LIST_REFRESH_MIN_INTERVAL_MS = 1000;

export function watchTagGroupUnload(): () => void {
	window.addEventListener("beforeunload", handleTagGroupBeforeUnload);
	return () => window.removeEventListener("beforeunload", handleTagGroupBeforeUnload);
}

export function ShellEffects() {
	useEffect(() => watchTagGroupUnload(), []);
	useEffect(() => {
		document.addEventListener("keydown", handleKeydown);
		return () => document.removeEventListener("keydown", handleKeydown);
	}, []);
	useEffect(() => watchSystemTheme(), []);
	// Desktop and Web are separate Host processes over one `~/.stepcode`. A
	// conversation the other one starts (or archives) is only on disk, so the
	// lists this page loaded at bootstrap never hear about it; re-read them when
	// the window comes back into use.
	useEffect(() => {
		let last = 0;
		let inFlight = false;
		const refresh = () => {
			if (document.visibilityState === "hidden") return;
			const now = Date.now();
			if (inFlight || now - last < LIST_REFRESH_MIN_INTERVAL_MS) return;
			last = now;
			inFlight = true;
			// A failed read keeps the lists the page already has; the next focus retries.
			void Promise.all([refreshWorkspaces(), refreshSessions()])
				.catch(() => {})
				.finally(() => {
					inFlight = false;
				});
		};
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, []);
	// The page follows only the open session's stream; a run left in another
	// session is polled until it ends, so its row turns from the running pulse
	// into the unread dot without a click.
	const backgroundBusy = useAppStore(backgroundSessionBusy);
	useEffect(() => {
		if (!backgroundBusy) return;
		const timer = setInterval(() => {
			// A failed poll leaves the rows as they were; the next tick retries.
			void refreshSessionStatuses().catch(() => {});
		}, BACKGROUND_STATUS_POLL_MS);
		return () => clearInterval(timer);
	}, [backgroundBusy]);
	return null;
}
