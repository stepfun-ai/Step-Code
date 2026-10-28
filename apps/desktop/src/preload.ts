/**
 * Sandboxed preload for the StepCode window.
 *
 * Exposes `window.stepcodeDesktop`, the contract defined once in
 * `@step-harness/web/desktop-bridge`. Every operation is an IPC call; the main
 * process checks that it comes from the window's top frame on the server origin.
 */

import type { StepcodeDesktopBridge } from "@step-harness/web/desktop-bridge";
import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC, VERSION_ARGUMENT } from "./ipc-channels.ts";

function hostPlatform(): StepcodeDesktopBridge["platform"] {
	return process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";
}

const version = process.argv.find((argument) => argument.startsWith(VERSION_ARGUMENT))?.slice(VERSION_ARGUMENT.length);

const bridge: StepcodeDesktopBridge = {
	platform: hostPlatform(),
	version: version ?? "",
	pickDirectory(options) {
		// Only plain strings cross the boundary; anything else is dropped here and re-validated in main.
		const request = {
			title: typeof options?.title === "string" ? options.title : undefined,
			defaultPath: typeof options?.defaultPath === "string" ? options.defaultPath : undefined,
			purpose: options?.purpose,
		};
		return ipcRenderer.invoke(DESKTOP_IPC.pickDirectory, request) as Promise<string | null>;
	},
	openExternal(url) {
		return ipcRenderer.invoke(DESKTOP_IPC.openExternal, String(url)) as Promise<void>;
	},
	revealPath(path) {
		return ipcRenderer.invoke(DESKTOP_IPC.revealPath, String(path)) as Promise<void>;
	},
	defaultBrowser() {
		return ipcRenderer.invoke(DESKTOP_IPC.defaultBrowser) as ReturnType<StepcodeDesktopBridge["defaultBrowser"]>;
	},
};

contextBridge.exposeInMainWorld("stepcodeDesktop", bridge);
