/**
 * Main-process handlers behind `window.stepcodeDesktop`.
 *
 * Every handler first checks that the call comes from the main window's top
 * frame while it shows the StepCode server origin. A navigated-away page, an
 * iframe, or the startup error page cannot open dialogs or launch URLs.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import type { DesktopUpdateState } from "@step-harness/web/desktop-bridge";
import { type BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain, shell } from "electron";
import { DESKTOP_IPC } from "./ipc-channels.ts";
import type { DesktopUpdater } from "./updater.ts";

export interface DesktopIpcOptions {
	/** The window allowed to call the bridge, if one is open. */
	readonly getWindow: () => BrowserWindow | undefined;
	/** Origin of the running web server, e.g. `http://127.0.0.1:51234`; undefined while it is down. */
	readonly getServerOrigin: () => string | undefined;
	/** Called with every folder the user picks, so the next launch can start there. */
	readonly onDirectoryPicked: (path: string) => void;
	readonly updater: DesktopUpdater;
}

/**
 * Push an update state to the page, when the window shows the server origin.
 * The error and loading pages have no bridge, so nothing is sent to them.
 */
export function publishUpdateState(options: DesktopIpcOptions, state: DesktopUpdateState): void {
	const window = options.getWindow();
	const origin = options.getServerOrigin();
	if (window === undefined || window.isDestroyed() || origin === undefined) return;
	let pageOrigin: string;
	try {
		pageOrigin = new URL(window.webContents.getURL()).origin;
	} catch {
		return;
	}
	if (pageOrigin === origin) window.webContents.send(DESKTOP_IPC.updateState, state);
}

function trustedWindow(event: IpcMainInvokeEvent, options: DesktopIpcOptions): BrowserWindow {
	const window = options.getWindow();
	const origin = options.getServerOrigin();
	const frame = event.senderFrame;
	if (
		window === undefined ||
		window.isDestroyed() ||
		origin === undefined ||
		frame === null ||
		event.sender !== window.webContents ||
		frame !== window.webContents.mainFrame
	) {
		throw new Error("stepcode desktop: rejected IPC from an unowned renderer");
	}
	let frameOrigin: string;
	try {
		frameOrigin = new URL(frame.url).origin;
	} catch {
		throw new Error("stepcode desktop: rejected IPC from an unowned renderer");
	}
	if (frameOrigin !== origin) throw new Error("stepcode desktop: rejected IPC from an unowned renderer");
	return window;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function existingDirectory(path: string | undefined): string | undefined {
	if (path === undefined || !isAbsolute(path)) return undefined;
	try {
		return statSync(path).isDirectory() ? path : undefined;
	} catch {
		return undefined;
	}
}

/** Register the bridge handlers once for the application lifetime. */
export function installDesktopIpc(options: DesktopIpcOptions): void {
	// One folder dialog per window: a second request joins the open one instead of stacking.
	const pending = new WeakMap<BrowserWindow, Promise<string | null>>();

	ipcMain.handle(DESKTOP_IPC.pickDirectory, (event, raw: unknown) => {
		const window = trustedWindow(event, options);
		const existing = pending.get(window);
		if (existing !== undefined) return existing;
		const request = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
		if (window.isMinimized()) window.restore();
		window.focus();
		const result = dialog
			.showOpenDialog(window, {
				title: optionalString(request.title),
				defaultPath: existingDirectory(optionalString(request.defaultPath)),
				properties: ["openDirectory", "createDirectory"],
			})
			.then(({ canceled, filePaths }) => {
				const picked = canceled || window.isDestroyed() ? null : (filePaths[0] ?? null);
				if (picked !== null) options.onDirectoryPicked(picked);
				return picked;
			})
			.finally(() => {
				pending.delete(window);
			});
		pending.set(window, result);
		return result;
	});

	ipcMain.handle(DESKTOP_IPC.openExternal, async (event, raw: unknown) => {
		trustedWindow(event, options);
		if (typeof raw !== "string") throw new Error("openExternal expects a URL string");
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw new Error(`Not a valid URL: ${raw}`);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error(`Only http and https URLs can be opened externally (got ${url.protocol})`);
		}
		await shell.openExternal(url.href);
	});

	ipcMain.handle(DESKTOP_IPC.revealPath, (event, raw: unknown) => {
		trustedWindow(event, options);
		if (typeof raw !== "string" || !isAbsolute(raw)) throw new Error("revealPath expects an absolute path");
		const path = normalize(raw);
		if (!existsSync(path)) throw new Error(`Path does not exist: ${path}`);
		shell.showItemInFolder(path);
	});

	// The updater takes no arguments from the page: it only ever installs what its own feed names.
	ipcMain.handle(DESKTOP_IPC.updateGetState, (event) => {
		trustedWindow(event, options);
		return options.updater.state;
	});
	ipcMain.handle(DESKTOP_IPC.updateCheck, (event) => {
		trustedWindow(event, options);
		return options.updater.check(true);
	});
	ipcMain.handle(DESKTOP_IPC.updateDownload, async (event) => {
		trustedWindow(event, options);
		// Failures are reported through the state; the page does not need the rejection.
		await options.updater.download().catch(() => undefined);
	});
	ipcMain.handle(DESKTOP_IPC.updateRestart, (event) => {
		trustedWindow(event, options);
		return options.updater.restart();
	});
}
