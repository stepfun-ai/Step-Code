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
	defaultBrowser: "stepcode-desktop:default-browser",
	browserGuest: "stepcode-desktop:browser-guest",
	releaseBrowserGuest: "stepcode-desktop:release-browser-guest",
	/** Main to page only: validated embedded-browser events (`DesktopBrowserEvent`). */
	browserEvent: "stepcode-desktop:browser-event",
} as const;

/** Argument the main process passes to the preload so the bridge can report the app version synchronously. */
export const VERSION_ARGUMENT = "--stepcode-desktop-version=";
