/**
 * Contract between the Web client and a desktop host (apps/desktop).
 *
 * The desktop preload script exposes an object of this shape as
 * `window.stepcodeDesktop`. In a plain browser the property is absent and the
 * client falls back to the server-side equivalents. Type-only: the desktop app
 * imports it from `@step-harness/web/desktop-bridge` so both sides share one
 * definition.
 */
export interface StepcodeDesktopBridge {
	/** Host operating system, as reported by Node's `process.platform`. */
	readonly platform: "darwin" | "win32" | "linux";
	/** Desktop application version. */
	readonly version: string;
	/** Open the native folder chooser. Resolves to an absolute path, or null when cancelled. */
	pickDirectory(options?: { readonly title?: string; readonly defaultPath?: string }): Promise<string | null>;
	/** Open an http(s) URL in the system browser. */
	openExternal(url: string): Promise<void>;
	/** Reveal a file or folder in Finder / Explorer / the file manager. */
	revealPath(path: string): Promise<void>;
	/**
	 * The system's default web browser, as `openExternal` would launch it: its display name and a PNG data URL of
	 * its icon (empty when the OS has none). Resolves to null where the OS cannot tell (Linux).
	 */
	defaultBrowser(): Promise<DesktopBrowserInfo | null>;
	/**
	 * Reserve one embedded-browser page. Render `<webview src={"about:blank#" + lease} partition={partition}>`
	 * exactly once with it: the main process refuses a webview without an unused lease issued to this window,
	 * replaces its preferences with a fixed sandbox, and owns its navigation, request and permission policy.
	 */
	browserGuest(): Promise<DesktopBrowserGuest>;
	/** Destroy the page attached with `lease` (a closed tab). Unknown or already released leases resolve. */
	releaseBrowserGuest(lease: string): Promise<void>;
	/**
	 * Events the main process observed in this window's embedded-browser pages. Returns the unsubscribe
	 * function. This is the bridge's only main-to-page channel.
	 */
	onBrowserEvent(listener: (event: DesktopBrowserEvent) => void): () => void;
}

/** A reserved embedded-browser page: the opaque lease and the storage partition approved for it. */
export interface DesktopBrowserGuest {
	readonly lease: string;
	readonly partition: string;
}

/**
 * `popup`: the page opened an http(s) window right after a click or key press in it; show `url` in a new tab.
 * `download`: a download was cancelled. `shortcut`: a panel shortcut (Cmd/Ctrl + R, L, T or W) was pressed while
 * the page had focus; the main process kept it from the page and from the application menu.
 */
export type DesktopBrowserEvent =
	| { readonly type: "popup"; readonly lease: string; readonly url: string }
	| { readonly type: "download"; readonly lease: string }
	| { readonly type: "shortcut"; readonly lease: string; readonly key: "r" | "l" | "t" | "w" };

/** Display identity of the system's default browser. */
export interface DesktopBrowserInfo {
	readonly name: string;
	/** `data:image/png;base64,...`, or "" without an icon. */
	readonly icon: string;
}

declare global {
	interface Window {
		stepcodeDesktop?: StepcodeDesktopBridge;
	}
}
