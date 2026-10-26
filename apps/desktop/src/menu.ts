/**
 * Application menu. Native roles keep copy/paste/undo, zoom, fullscreen and
 * window management working with platform shortcuts inside the web client.
 */

import { app, Menu, type MenuItemConstructorOptions } from "electron";

export interface MenuActions {
	/** Stop and start the web server, then reload the window. */
	readonly restartServer: () => void;
	/** Open the folder holding web-server.log. */
	readonly showLogs: () => void;
	/** Check the update feed now and report the result. */
	readonly checkForUpdates: () => void;
}

export function installApplicationMenu(actions: MenuActions): void {
	const darwin = process.platform === "darwin";
	const template: MenuItemConstructorOptions[] = [];
	if (darwin) {
		template.push({
			label: app.name,
			submenu: [
				{ role: "about" },
				{ label: "Check for Updates…", click: () => actions.checkForUpdates() },
				{ type: "separator" },
				{ role: "services" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit" },
			],
		});
	}
	template.push(
		{
			label: "File",
			submenu: [
				{ label: "Restart Server", click: () => actions.restartServer() },
				{ label: "Show Server Logs", click: () => actions.showLogs() },
				...(darwin ? [] : [{ label: "Check for Updates…", click: () => actions.checkForUpdates() }]),
				{ type: "separator" },
				darwin ? { role: "close" } : { role: "quit" },
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				...(darwin ? [{ role: "pasteAndMatchStyle" as const }] : []),
				{ role: "delete" },
				{ type: "separator" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				// F12 as a second, hidden DevTools shortcut on every platform.
				{ role: "toggleDevTools", accelerator: "F12", visible: false },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			role: "windowMenu",
		},
	);
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
