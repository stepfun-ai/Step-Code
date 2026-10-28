/**
 * Main-process handlers behind `window.stepcodeDesktop`.
 *
 * Every handler first checks that the call comes from the main window's top
 * frame while it shows the StepCode server origin. A navigated-away page, an
 * iframe, or the startup error page cannot open dialogs or launch URLs.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import type { DesktopBrowserInfo } from "@step-harness/web/desktop-bridge";
import { app, type BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain, shell } from "electron";
import { DESKTOP_IPC } from "./ipc-channels.ts";
import { type DesktopStateStore, isDesktopThemeChoice } from "./state.ts";

export interface DesktopIpcOptions {
	/** Profile state shared with window bounds and workspace persistence. */
	readonly state: DesktopStateStore;
	/** The window allowed to call the bridge, if one is open. */
	readonly getWindow: () => BrowserWindow | undefined;
	/** Origin of the running web server, e.g. `http://127.0.0.1:51234`; undefined while it is down. */
	readonly getServerOrigin: () => string | undefined;
	/** Called with every folder the user picks, so the next launch can start there. */
	readonly onDirectoryPicked: (path: string) => void;
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
	ipcMain.handle(DESKTOP_IPC.getTheme, (event) => {
		trustedWindow(event, options);
		return options.state.theme();
	});
	ipcMain.handle(DESKTOP_IPC.setTheme, (event, raw: unknown) => {
		trustedWindow(event, options);
		if (!isDesktopThemeChoice(raw)) throw new Error("setTheme expects a valid theme choice");
		if (!options.state.update({ theme: raw })) throw new Error("Could not persist desktop theme");
	});
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

	// The default browser rarely changes while the app runs, and the lookup reads the OS registry or
	// Launch Services; one answer per launch is enough. A failed lookup is retried on the next call.
	let defaultBrowser: Promise<DesktopBrowserInfo | null> | undefined;
	ipcMain.handle(DESKTOP_IPC.defaultBrowser, (event) => {
		trustedWindow(event, options);
		// Electron documents this lookup for macOS and Windows only.
		if (process.platform !== "darwin" && process.platform !== "win32") return null;
		defaultBrowser ??= app
			.getApplicationInfoForProtocol("https://example.com")
			.then(({ name, icon }): DesktopBrowserInfo | null => {
				const label = name.replace(/\.app$/i, "").trim();
				if (!label) return null;
				return { name: label, icon: icon.isEmpty() ? "" : icon.resize({ width: 32, height: 32 }).toDataURL() };
			})
			.catch((error: unknown) => {
				defaultBrowser = undefined;
				throw error;
			});
		return defaultBrowser;
	});

	ipcMain.handle(DESKTOP_IPC.revealPath, (event, raw: unknown) => {
		trustedWindow(event, options);
		if (typeof raw !== "string" || !isAbsolute(raw)) throw new Error("revealPath expects an absolute path");
		const path = normalize(raw);
		if (!existsSync(path)) throw new Error(`Path does not exist: ${path}`);
		shell.showItemInFolder(path);
	});
}
