/**
 * Main-process ownership and fixed isolation policy for embedded-browser guests (`<webview>` pages).
 *
 * The page asks for a lease over the bridge, then renders `<webview src="about:blank#<lease>">` in the lease's
 * partition. Attachment is refused unless the lease was issued to this window and is still unused; the guest's
 * preferences are replaced with a fixed sandbox. Navigation, requests, permissions, popups and downloads are
 * decided here, never by the page. All guests share one in-memory partition: no StepCode cookie, storage or
 * permission reaches it, and it is gone when the app quits.
 */

import { randomUUID } from "node:crypto";
import type { DesktopBrowserEvent, DesktopBrowserGuest } from "@step-harness/web/desktop-bridge";
import { type BrowserWindow, type Session, session, type WebContents } from "electron";
import {
	GESTURE_INPUTS,
	guestNavigationAllowed,
	guestRequestBlocked,
	guestShortcut,
	leaseFromStartUrl,
	POPUP_GESTURE_MS,
} from "./browser-guest-policy.ts";
import { DESKTOP_IPC } from "./ipc-channels.ts";

/** No `persist:` prefix: an in-memory session, cleared when the app quits. */
const PARTITION = "stepcode-browser";
/** The panel keeps at most 12 tabs; the slack covers a tab released while its replacement is reserved. */
const MAX_LEASES_PER_WINDOW = 16;
/** How long a release waits for Chromium to destroy the guest before it resolves anyway. */
const RELEASE_TIMEOUT_MS = 2000;

interface GuestLease {
	readonly owner: WebContents;
	attached: boolean;
	guest?: WebContents;
	/** When the user last clicked or pressed a key in this guest; one popup may follow it. */
	gestureAt: number;
}

export class DesktopBrowserGuests {
	private readonly leases = new Map<string, GuestLease>();
	private readonly hostPorts: () => readonly number[];
	/** Per-guest download notifiers; the session-wide handler finds the guest that started a download. */
	private readonly downloads = new WeakMap<WebContents, () => void>();
	private sessionConfigured = false;

	/** @param hostPorts - the running StepCode Host's ports, which no guest request may reach. */
	constructor(hostPorts: () => readonly number[]) {
		this.hostPorts = hostPorts;
	}

	/** Reserve one guest for `owner`, the authenticated application window's WebContents. */
	acquire(owner: WebContents): DesktopBrowserGuest {
		let owned = 0;
		for (const lease of this.leases.values()) if (lease.owner === owner) owned++;
		if (owned >= MAX_LEASES_PER_WINDOW) throw new Error("embedded browser: too many open pages");
		this.configureSession();
		const lease = randomUUID();
		this.leases.set(lease, { owner, attached: false, gestureAt: 0 });
		return { lease, partition: PARTITION };
	}

	/** Destroy the guest of a lease issued to `owner`. Unknown leases resolve: the tab is already gone. */
	async release(owner: WebContents, id: unknown): Promise<void> {
		if (typeof id !== "string") throw new Error("embedded browser: invalid page lease");
		const lease = this.leases.get(id);
		if (lease === undefined) return;
		if (lease.owner !== owner) throw new Error("embedded browser: page belongs to another window");
		this.leases.delete(id);
		const guest = lease.guest;
		if (guest === undefined || guest.isDestroyed()) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, RELEASE_TIMEOUT_MS);
			guest.once("destroyed", () => {
				clearTimeout(timer);
				resolve();
			});
			guest.close({ waitForBeforeUnload: false });
		});
	}

	/**
	 * Install the attachment checks on the application window before its document can create a webview.
	 * @param installContextMenu - gives an approved guest the window's edit context menu.
	 */
	bind(window: BrowserWindow, installContextMenu: (contents: WebContents) => void): void {
		const owner = window.webContents;
		owner.on("will-attach-webview", (event, preferences, params) => {
			const id = leaseFromStartUrl(typeof params.src === "string" ? params.src : "");
			const lease = id === undefined ? undefined : this.leases.get(id);
			if (lease === undefined || lease.owner !== owner || lease.attached || params.partition !== PARTITION) {
				event.preventDefault();
				return;
			}
			lease.attached = true;
			// Keep only Electron's popup flag (the `allowpopups` attribute) so window.open reaches the handler
			// below, which still denies every native window. Everything else the page asked for is dropped.
			for (const key of Object.keys(preferences)) {
				if (key !== "disablePopups") Reflect.deleteProperty(preferences, key);
			}
			Object.assign(preferences, {
				partition: PARTITION,
				nodeIntegration: false,
				nodeIntegrationInWorker: false,
				nodeIntegrationInSubFrames: false,
				contextIsolation: true,
				sandbox: true,
				webSecurity: true,
				allowRunningInsecureContent: false,
				webviewTag: false,
				plugins: false,
				navigateOnDragDrop: false,
				disableDialogs: true,
				spellcheck: false,
			});
			params.httpreferrer = "";
		});
		owner.on("did-attach-webview", (_event, guest) => this.wire(owner, guest, installContextMenu));
		const releaseAll = (): void => {
			for (const [id, lease] of this.leases) {
				if (lease.owner !== owner) continue;
				void this.release(owner, id).catch((error: unknown) => {
					console.error("Embedded browser release failed:", error instanceof Error ? error.message : error);
				});
			}
		};
		// A reload or crash of the application document drops its webviews; their leases go with them.
		owner.on("did-start-navigation", (details) => {
			if (details.isMainFrame && !details.isSameDocument) releaseAll();
		});
		owner.on("render-process-gone", releaseAll);
		owner.once("destroyed", releaseAll);
	}

	private wire(owner: WebContents, guest: WebContents, installContextMenu: (contents: WebContents) => void): void {
		let bound: string | undefined;
		const lease = (): GuestLease | undefined => {
			const value = bound === undefined ? undefined : this.leases.get(bound);
			return value?.guest === guest && value.owner === owner ? value : undefined;
		};
		const send = (event: DesktopBrowserEvent): void => {
			if (!owner.isDestroyed()) owner.send(DESKTOP_IPC.browserEvent, event);
		};
		// The first document is the inert about:blank carrying the approved lease. Bind on this main-process
		// event, before the page can navigate the ready guest; a guest that does not carry an attached,
		// still unbound lease is closed.
		guest.once("dom-ready", () => {
			const id = leaseFromStartUrl(guest.getURL());
			const candidate = id === undefined ? undefined : this.leases.get(id);
			if (
				id === undefined ||
				candidate === undefined ||
				candidate.owner !== owner ||
				candidate.guest !== undefined
			) {
				guest.close({ waitForBeforeUnload: false });
				return;
			}
			candidate.guest = guest;
			bound = id;
			guest.once("destroyed", () => {
				if (this.leases.get(id) === candidate) this.leases.delete(id);
			});
		});
		guest.on("input-event", (_event, input) => {
			const current = lease();
			if (current !== undefined && GESTURE_INPUTS.has(input.type)) current.gestureAt = Date.now();
		});
		guest.on("before-input-event", (event, input) => {
			const current = lease();
			const key = guestShortcut(input, process.platform);
			if (current === undefined || key === undefined || bound === undefined) return;
			event.preventDefault();
			send({ type: "shortcut", lease: bound, key });
		});
		guest.setWindowOpenHandler(({ url, postBody }) => {
			const current = lease();
			// One popup per click or key press, as a tab of the panel; pages cannot open windows on their own.
			if (
				current !== undefined &&
				bound !== undefined &&
				postBody === undefined &&
				Date.now() - current.gestureAt <= POPUP_GESTURE_MS &&
				guestNavigationAllowed(url) &&
				!guestRequestBlocked(url, this.hostPorts())
			) {
				current.gestureAt = 0;
				send({ type: "popup", lease: bound, url: new URL(url).href });
			}
			return { action: "deny" };
		});
		guest.on("will-frame-navigate", (event) => {
			if (event.isMainFrame && !guestNavigationAllowed(event.url)) event.preventDefault();
		});
		guest.on("will-redirect", (event) => {
			if (event.isMainFrame && !guestNavigationAllowed(event.url)) event.preventDefault();
		});
		guest.on("will-attach-webview", (event) => event.preventDefault());
		// HTTP authentication prompts are cancelled: the guest has no credential UI.
		guest.on("login", (event, _details, _authInfo, callback) => {
			event.preventDefault();
			callback();
		});
		installContextMenu(guest);
		this.downloads.set(guest, () => {
			if (bound !== undefined) send({ type: "download", lease: bound });
		});
	}

	private configureSession(): void {
		if (this.sessionConfigured) return;
		this.sessionConfigured = true;
		const guests: Session = session.fromPartition(PARTITION);
		guests.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		guests.setPermissionCheckHandler(() => false);
		guests.setDevicePermissionHandler(() => false);
		guests.setDisplayMediaRequestHandler((_request, callback) => callback(null));
		guests.on("will-download", (event, _item, contents) => {
			event.preventDefault();
			this.downloads.get(contents)?.();
		});
		guests.webRequest.onBeforeRequest((details, callback) => {
			callback({ cancel: guestRequestBlocked(details.url, this.hostPorts()) });
		});
	}
}
