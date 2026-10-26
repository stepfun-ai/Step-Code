/**
 * IPC channel names shared by the main process and the preload.
 *
 * Kept in their own module so the sandboxed preload bundle does not pull in
 * main-process code (dialog, shell, ipcMain are unavailable there).
 */
export const DESKTOP_IPC = {
	pickDirectory: "stepcode-desktop:pick-directory",
	openExternal: "stepcode-desktop:open-external",
	revealPath: "stepcode-desktop:reveal-path",
	updateGetState: "stepcode-desktop:update-get-state",
	updateCheck: "stepcode-desktop:update-check",
	updateDownload: "stepcode-desktop:update-download",
	updateRestart: "stepcode-desktop:update-restart",
	/** Main -> page push: the new `DesktopUpdateState`. The only channel the page listens on. */
	updateState: "stepcode-desktop:update-state",
} as const;

/** Argument the main process passes to the preload so the bridge can report the app version synchronously. */
export const VERSION_ARGUMENT = "--stepcode-desktop-version=";
