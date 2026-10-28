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
	/** Open the native folder chooser. Resource picks do not change the next-launch workspace. */
	pickDirectory(options?: {
		readonly title?: string;
		readonly defaultPath?: string;
		readonly purpose?: "workspace" | "resource";
	}): Promise<string | null>;
	/** Open an http(s) URL in the system browser. */
	openExternal(url: string): Promise<void>;
	/** Reveal a file or folder in Finder / Explorer / the file manager. */
	revealPath(path: string): Promise<void>;
	/**
	 * The system's default web browser, as `openExternal` would launch it: its display name and a PNG data URL of
	 * its icon (empty when the OS has none). Resolves to null where the OS cannot tell (Linux).
	 */
	defaultBrowser(): Promise<DesktopBrowserInfo | null>;
}

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
