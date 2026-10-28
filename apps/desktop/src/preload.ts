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
	beginTagGroupClose() {
		// Invoke responses are untyped; the renderer validates the attempt before using it.
		return ipcRenderer.invoke(DESKTOP_IPC.beginTagGroupClose) as ReturnType<
			StepcodeDesktopBridge["beginTagGroupClose"]
		>;
	},
	completeTagGroupClose(attemptId, outcome) {
		return ipcRenderer.invoke(DESKTOP_IPC.completeTagGroupClose, attemptId, outcome) as Promise<boolean>;
	},
	readTagGroups() {
		// Electron invoke erases response types; main validates disk data and the renderer validates the IPC result.
		return ipcRenderer.invoke(DESKTOP_IPC.readTagGroups) as ReturnType<StepcodeDesktopBridge["readTagGroups"]>;
	},
	saveTagGroups(data) {
		// This dedicated handler returns no payload and resolves only after atomic replacement.
		return ipcRenderer.invoke(DESKTOP_IPC.saveTagGroups, data) as Promise<void>;
	},
	platform: hostPlatform(),
	version: version ?? "",
	getTheme() {
		return ipcRenderer.invoke(DESKTOP_IPC.getTheme) as ReturnType<StepcodeDesktopBridge["getTheme"]>;
	},
	setTheme(theme) {
		return ipcRenderer.invoke(DESKTOP_IPC.setTheme, theme) as Promise<void>;
	},
	pickDirectory(options) {
		// Only plain strings cross the boundary; anything else is dropped here and re-validated in main.
		const request = {
			title: typeof options?.title === "string" ? options.title : undefined,
			defaultPath: typeof options?.defaultPath === "string" ? options.defaultPath : undefined,
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
