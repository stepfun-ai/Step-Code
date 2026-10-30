/**
 * Pure policy for embedded-browser guests (`<webview>` pages). No Electron imports, so it is unit-tested
 * under plain Node; `browser-guests.ts` applies it to real WebContents and sessions.
 */

/** Where a guest's main frame may go: http(s) without embedded credentials. */
export function guestNavigationAllowed(raw: string): boolean {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
}

/** Schemes a guest may load besides the network: its inert start page and inline/page-created documents. */
const LOCAL_SCHEMES = new Set(["about:", "data:", "blob:"]);
const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

/**
 * Whether a guest request must be cancelled. Network requests to a StepCode Host port are refused on every
 * hostname (DNS aliases and rebinding resolve to loopback too), as are embedded credentials. Other schemes
 * (`file:`, `chrome:`, `devtools:` ...) are refused outright: `loadURL` from the embedder skips navigation
 * events, so the request filter is the only check that covers it.
 */
export function guestRequestBlocked(raw: string, hostPorts: readonly number[]): boolean {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return true;
	}
	if (LOCAL_SCHEMES.has(url.protocol)) return false;
	if (!NETWORK_SCHEMES.has(url.protocol)) return true;
	if (url.username !== "" || url.password !== "") return true;
	const secure = url.protocol === "https:" || url.protocol === "wss:";
	const port = Number(url.port || (secure ? 443 : 80));
	return hostPorts.includes(port);
}

/** The lease a guest's inert start document carries: `about:blank#<lease>`. */
export function leaseFromStartUrl(raw: string): string | undefined {
	const prefix = "about:blank#";
	if (!raw.startsWith(prefix)) return undefined;
	const lease = raw.slice(prefix.length);
	return /^[0-9a-f-]{36}$/.test(lease) ? lease : undefined;
}

/** The keyboard fields `before-input-event` reports. */
export interface GuestKeyInput {
	readonly type: string;
	readonly key: string;
	readonly control: boolean;
	readonly meta: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
}

export type GuestShortcut = "r" | "l" | "t" | "w";

/**
 * A panel shortcut pressed inside a guest: Cmd (macOS) or Ctrl (elsewhere) with R, L, T or W and no other
 * modifier. Those keys would otherwise reach the page and, for R and W, the application menu, which reloads
 * or closes the whole StepCode window instead of the tab.
 */
export function guestShortcut(input: GuestKeyInput, platform: NodeJS.Platform): GuestShortcut | undefined {
	// Chromium reports a physical key press as `rawKeyDown` on some paths (macOS, synthesized input) and as
	// `keyDown` on others; either is the press. `keyUp` and `char` never trigger.
	if ((input.type !== "keyDown" && input.type !== "rawKeyDown") || input.alt || input.shift) return undefined;
	const mac = platform === "darwin";
	if (mac ? !input.meta || input.control : !input.control || input.meta) return undefined;
	const key = input.key.toLowerCase();
	return key === "r" || key === "l" || key === "t" || key === "w" ? key : undefined;
}

/** Input that counts as a user gesture for the one popup a click or key press may open. */
export const GESTURE_INPUTS: ReadonlySet<string> = new Set([
	"mouseDown",
	"mouseUp",
	"rawKeyDown",
	"keyDown",
	"gestureTap",
	"touchEnd",
	"pointerDown",
]);

/** How long after a gesture a popup still belongs to it. */
export const POPUP_GESTURE_MS = 1500;
