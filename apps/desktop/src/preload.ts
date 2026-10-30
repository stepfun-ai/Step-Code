/**
 * Sandboxed preload for the StepCode window.
 *
 * Exposes `window.stepcodeDesktop`, the contract defined once in
 * `@step-harness/web/desktop-bridge`. Every operation is an IPC call; the main
 * process checks that it comes from the window's top frame on the server origin.
 */

import type { DesktopBrowserEvent, StepcodeDesktopBridge } from "@step-harness/web/desktop-bridge";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import { DESKTOP_IPC, VERSION_ARGUMENT } from "./ipc-channels.ts";

function hostPlatform(): StepcodeDesktopBridge["platform"] {
	return process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";
}

/** A copy of a main-process browser event with only its known fields, or undefined when malformed. */
function browserEvent(payload: unknown): DesktopBrowserEvent | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const { type, lease, url, key } = payload as Record<string, unknown>;
	if (typeof lease !== "string") return undefined;
	if (type === "popup" && typeof url === "string") return { type, lease, url };
	if (type === "download") return { type, lease };
	if (type === "shortcut" && (key === "r" || key === "l" || key === "t" || key === "w")) return { type, lease, key };
	return undefined;
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
	browserGuest() {
		return ipcRenderer.invoke(DESKTOP_IPC.browserGuest) as ReturnType<StepcodeDesktopBridge["browserGuest"]>;
	},
	releaseBrowserGuest(lease) {
		return ipcRenderer.invoke(DESKTOP_IPC.releaseBrowserGuest, String(lease)) as Promise<void>;
	},
	onBrowserEvent(listener) {
		// The one main-to-page channel. Only the fixed channel is subscribed, and only well-formed events
		// reach the page; the IpcRendererEvent itself (with its sender) never crosses the context bridge.
		const handler = (_event: IpcRendererEvent, payload: unknown): void => {
			const event = browserEvent(payload);
			if (event !== undefined) listener(event);
		};
		ipcRenderer.on(DESKTOP_IPC.browserEvent, handler);
		return () => {
			ipcRenderer.off(DESKTOP_IPC.browserEvent, handler);
		};
	},
};

contextBridge.exposeInMainWorld("stepcodeDesktop", bridge);
