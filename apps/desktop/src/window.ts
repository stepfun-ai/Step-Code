/**
 * The StepCode application window.
 *
 * Security posture: context isolation, sandboxed renderer, no Node
 * integration. The only privileged surface is the preload bridge. Navigation
 * is pinned to the web server origin; other http(s) links open in the system
 * browser, and new windows are never created. `<webview>` is enabled for the
 * embedded browser only: `browser-guests.ts` refuses any webview without a
 * lease the main process issued, and fixes every guest's preferences.
 */

import {
	BrowserWindow,
	Menu,
	type MenuItemConstructorOptions,
	nativeTheme,
	type Rectangle,
	screen,
	session,
	shell,
	type WebContents,
} from "electron";
import type { DesktopBrowserGuests } from "./browser-guests.ts";
import { VERSION_ARGUMENT } from "./ipc-channels.ts";
import { canvasColor } from "./pages.ts";
import { isAllowedPermission, originOf } from "./permissions.ts";
import type { DesktopStateStore, WindowState } from "./state.ts";

const DEFAULT_SIZE = { width: 1280, height: 840 };
const MIN_SIZE = { width: 720, height: 480 };
/** Where macOS draws the traffic lights; the web client reserves this strip in its desktop CSS. */
export const TRAFFIC_LIGHT_POSITION = { x: 16, y: 16 };

export interface MainWindowOptions {
	readonly onNativeClose: (window: BrowserWindow) => void;
	readonly onDocumentChanged: (window: BrowserWindow, url: string) => void;
	readonly preload: string;
	readonly version: string;
	readonly state: DesktopStateStore;
	/** Window / taskbar icon (Windows, Linux). macOS takes the app icon from the bundle or the Dock. */
	readonly icon: string;
	/** Origin the window may navigate within; undefined while the server is down. */
	readonly getServerOrigin: () => string | undefined;
	/** Lease and policy owner for the embedded browser's `<webview>` guests. */
	readonly browserGuests: DesktopBrowserGuests;
}

function openIfWeb(url: string): void {
	try {
		const { protocol } = new URL(url);
		if (protocol === "http:" || protocol === "https:") void shell.openExternal(url);
	} catch {
		// Not a URL: nothing to open.
	}
}

/** Saved bounds, if they still land on a connected display. */
function restorableBounds(saved: WindowState | undefined): Partial<Rectangle> {
	if (saved === undefined) return DEFAULT_SIZE;
	const size = { width: Math.max(saved.width, MIN_SIZE.width), height: Math.max(saved.height, MIN_SIZE.height) };
	if (saved.x === undefined || saved.y === undefined) return size;
	const bounds = { x: saved.x, y: saved.y, ...size };
	const visible = screen.getAllDisplays().some(({ workArea }) => {
		const overlapX = Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
		const overlapY =
			Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
		return overlapX >= 100 && overlapY >= 50;
	});
	return visible ? bounds : size;
}

let sessionConfigured = false;

/** Permission policy for the default session, installed once. */
function configureSession(getServerOrigin: () => string | undefined): void {
	if (sessionConfigured) return;
	sessionConfigured = true;
	// Both handlers answer for our own server origin only: a page from any
	// other origin gets Electron's default denial.
	const allowed = (_contents: unknown, permission: string, requestingUrl: string): boolean => {
		const origin = getServerOrigin();
		return isAllowedPermission(permission, requestingUrl, origin);
	};
	session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingUrl) =>
		allowed(_contents, permission, requestingUrl),
	);
	session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
		callback(allowed(_contents, permission, details.requestingUrl));
	});
}

/** Edit menu for the window's own page and for embedded-browser guests, which Electron gives none. */
function installContextMenu(window: BrowserWindow, contents: WebContents = window.webContents): void {
	contents.on("context-menu", (_event, { isEditable, selectionText, editFlags }) => {
		const items: MenuItemConstructorOptions[] = [];
		if (isEditable) {
			items.push(
				{ role: "undo", enabled: editFlags.canUndo },
				{ role: "redo", enabled: editFlags.canRedo },
				{ type: "separator" },
				{ role: "cut", enabled: editFlags.canCut },
				{ role: "copy", enabled: editFlags.canCopy },
				{ role: "paste", enabled: editFlags.canPaste },
				{ type: "separator" },
				{ role: "selectAll", enabled: editFlags.canSelectAll },
			);
		} else if (selectionText.trim().length > 0) {
			items.push({ role: "copy", enabled: editFlags.canCopy });
		}
		if (items.length > 0) Menu.buildFromTemplate(items).popup({ window });
	});
}

function persistBounds(window: BrowserWindow, state: DesktopStateStore): void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const save = (): void => {
		if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
		const bounds = window.getNormalBounds();
		state.update({ window: { ...bounds, maximized: window.isMaximized() } });
	};
	const schedule = (): void => {
		clearTimeout(timer);
		timer = setTimeout(save, 500);
	};
	window.on("resize", schedule);
	window.on("move", schedule);
	window.on("close", () => {
		clearTimeout(timer);
		save();
	});
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
	configureSession(options.getServerOrigin);
	const saved = options.state.get().window;
	const darwin = process.platform === "darwin";
	const window = new BrowserWindow({
		...restorableBounds(saved),
		minWidth: MIN_SIZE.width,
		minHeight: MIN_SIZE.height,
		show: false,
		title: "StepCode",
		...(darwin ? {} : { icon: options.icon }),
		backgroundColor: canvasColor(nativeTheme.shouldUseDarkColors),
		...(darwin ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: TRAFFIC_LIGHT_POSITION } : {}),
		webPreferences: {
			preload: options.preload,
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webSecurity: true,
			webviewTag: true,
			spellcheck: false,
			additionalArguments: [`${VERSION_ARGUMENT}${options.version}`],
		},
	});
	// Windows/Linux render the application menu as an in-window bar; hide it but
	// keep the menu installed so its accelerators (zoom, reload, DevTools) still work.
	if (!darwin) window.setMenuBarVisibility(false);
	if (saved?.maximized) window.maximize();

	window.webContents.setWindowOpenHandler(({ url }) => {
		openIfWeb(url);
		return { action: "deny" };
	});
	const guard = (event: Electron.Event, url: string): void => {
		const origin = options.getServerOrigin();
		if (origin !== undefined && originOf(url) === origin) return;
		event.preventDefault();
		openIfWeb(url);
	};
	window.webContents.on("will-navigate", guard);
	window.webContents.on("will-redirect", guard);
	options.browserGuests.bind(window, (guest) => installContextMenu(window, guest));
	// The page title is the product name; keep it stable in the Dock / taskbar.
	window.on("page-title-updated", (event) => event.preventDefault());

	window.on("close", () => options.onNativeClose(window));
	window.webContents.on("did-navigate", (_event, url) => options.onDocumentChanged(window, url));
	installContextMenu(window);
	persistBounds(window, options.state);
	return window;
}
