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
	/** The desktop app's own updates (see apps/desktop/src/updater.ts). */
	readonly updates: DesktopUpdatesBridge;
}

/**
 * Where the desktop updater is. The main process owns the state machine and
 * pushes every change; the page only renders it and asks for the next step.
 *
 * - `disabled`: no updates for this copy (development run, no update feed, or
 *   the app cannot replace itself: running from a disk image or a read-only
 *   folder). `reason` is English, for logs and tooltips.
 * - `idle`: up to date as of the last check (`checkedAt`, epoch ms), or never checked.
 * - `available` -> `downloading` -> `installing` (verify, unpack) -> `ready`:
 *   the new version is staged and takes over on the next restart.
 * - `error`: the last step the user asked for failed; `operation` says which.
 *   Failed background checks do not surface; they fall back to `idle`.
 */
export type DesktopUpdateState =
	| { readonly phase: "disabled"; readonly reason: string }
	| { readonly phase: "idle"; readonly checkedAt?: number }
	| { readonly phase: "checking" }
	| { readonly phase: "available"; readonly version: string; readonly size: number }
	| {
			readonly phase: "downloading";
			readonly version: string;
			/** Bytes received and expected. */
			readonly received: number;
			readonly size: number;
	  }
	| { readonly phase: "installing"; readonly version: string }
	| { readonly phase: "ready"; readonly version: string }
	| { readonly phase: "restarting"; readonly version: string }
	| {
			readonly phase: "error";
			readonly operation: "check" | "download" | "install" | "restart";
			readonly message: string;
			/** The version being fetched or installed, when there was one. */
			readonly version?: string;
	  };

export interface DesktopUpdatesBridge {
	/** The running app's version, e.g. `0.1.0`. */
	readonly currentVersion: string;
	/** The current state; call once on load, then follow `subscribe`. */
	getState(): Promise<DesktopUpdateState>;
	/** Check the update feed now. Resolves to the state after the check. */
	check(): Promise<DesktopUpdateState>;
	/** Download, verify and stage the available version; progress arrives through `subscribe`. */
	download(): Promise<void>;
	/** Quit, put the staged version in place and start it. Rejects when nothing is staged. */
	restart(): Promise<void>;
	/** Receive every state change. Returns the unsubscribe function. */
	subscribe(listener: (state: DesktopUpdateState) => void): () => void;
}

declare global {
	interface Window {
		stepcodeDesktop?: StepcodeDesktopBridge;
	}
}
