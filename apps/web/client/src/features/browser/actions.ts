import { useEffect, useState } from "react";
import { ApiError, api, errorMessage } from "../../lib/api";
import { type BrowserIdentity, browserMarkForName, detectBrowser } from "../../lib/browser-identity";
import { type DesktopBrowserInfo, getDesktopBridge } from "../../platform/host";
import { openRightPanel } from "../../state/right-panel";
import { setUi } from "../../state/store";
import type { EmbeddedBrowserFrame, EmbeddedBrowserSnapshot } from "../../state/types";

const ROOT = "/api/v1/browser";

/** Coalesced pointer and wheel input is sent once per frame; Chromium needs about two frames per wheel. */
const INPUT_FLUSH_MS = 40;
/** The host rejects a single wheel delta above this bound. */
const MAX_WHEEL_DELTA = 4000;
/**
 * Wheels farther apart than this, in page CSS pixels, may scroll different containers, so their
 * deltas are never summed. The frame alone cannot tell where one scroll container ends.
 */
const WHEEL_MERGE_RADIUS = 16;

/** A pointer move as the host's input route accepts it. */
export interface BrowserPointerMove {
	kind: "pointer";
	phase: "move";
	x: number;
	y: number;
	button: "left" | "right" | "middle";
	/** 1-3; the host rejects other counts. */
	clicks: number;
}

/** A wheel at a page position; the host moves the remote pointer there before scrolling. */
export interface BrowserWheel {
	x: number;
	y: number;
	deltaX: number;
	deltaY: number;
}

type PendingInput =
	| { path: string; kind: "move"; input: BrowserPointerMove }
	| { path: string; kind: "wheel"; input: BrowserWheel; origin: { x: number; y: number } };

const near = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
	Math.abs(a.x - b.x) <= WHEEL_MERGE_RADIUS && Math.abs(a.y - b.y) <= WHEEL_MERGE_RADIUS;

/**
 * The sum of two wheels that scroll the same way, or undefined. Opposite deltas on either axis are
 * not additive: at a scroll boundary up-then-down still scrolls down, while their sum would not move.
 */
function mergeWheels(a: BrowserWheel, b: BrowserWheel): BrowserWheel | undefined {
	const deltaX = a.deltaX + b.deltaX;
	const deltaY = a.deltaY + b.deltaY;
	if (a.deltaX * b.deltaX < 0 || a.deltaY * b.deltaY < 0) return undefined;
	if (Math.abs(deltaX) > MAX_WHEEL_DELTA || Math.abs(deltaY) > MAX_WHEEL_DELTA) return undefined;
	return { x: b.x, y: b.y, deltaX, deltaY };
}

/** Why a page's browser connection ended. Only a lost connection is worth reconnecting by itself. */
export class BrowserDisconnect extends Error {
	/** `replaced`: a page with the same client id took control; `stopped`: the Host is shutting down. */
	readonly reason: "lost" | "replaced" | "stopped";
	readonly retry: boolean;
	constructor(message: string, reason: "lost" | "replaced" | "stopped") {
		super(message);
		this.reason = reason;
		this.retry = reason === "lost";
	}
}

/**
 * Whether reconnecting can recover from `failure`. A refused control request (409: another page
 * controls the browser; 503: the Host is stopping) and a displaced page wait for the user, so two
 * pages never take control from each other in a loop. Dropped or unopened streams, network errors and
 * lapsed leases are recoverable.
 */
export function browserRetryable(failure: unknown): boolean {
	if (failure instanceof BrowserDisconnect) return failure.retry;
	if (failure instanceof ApiError) return failure.status !== 409 && failure.status !== 503;
	return true;
}

/** The parts of a keydown that decide where the key goes. */
export interface BrowserKeyEvent {
	readonly key: string;
	readonly altKey: boolean;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	readonly shiftKey: boolean;
	/** AltGr on Windows/Linux layouts (`getModifierState("AltGraph")`). */
	readonly altGraph: boolean;
}

/**
 * Where a keydown in the page's input goes: `copy` (the page selection), `native` (let the textarea
 * receive it, so its `input` event forwards the committed text), `ignore`, or a key press for the
 * host. A printed character is text even when AltGr or macOS Option produced it (`@` on a German
 * layout, `π` from Option+P); only Ctrl or Cmd turn a character into a shortcut. Windows reports
 * AltGr as Ctrl+Alt, so that pair is text too.
 */
export function browserKeyRoute(
	event: BrowserKeyEvent,
	mac: boolean,
): { kind: "copy" | "native" | "ignore" } | { kind: "key"; key: string; modifiers: number } {
	const altGr = event.altGraph || (!mac && event.ctrlKey && event.altKey);
	const mod = !altGr && (event.ctrlKey || event.metaKey);
	if (mod && event.key.toLowerCase() === "c") return { kind: "copy" };
	// Native paste/input supplies committed text, without touching the host browser clipboard.
	if (mod && event.key.toLowerCase() === "v") return { kind: "native" };
	if (!mod && event.key.length === 1 && (altGr || mac || !event.altKey)) return { kind: "native" };
	if (["Control", "Meta", "Alt", "AltGraph", "Shift", "Dead"].includes(event.key)) return { kind: "ignore" };
	return {
		kind: "key",
		key: event.key,
		modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0),
	};
}

/** Owns only this page's connection; tabs and browser lifetime belong to the host. */
export class BrowserConnection {
	private token = "";
	private controller = new AbortController();
	private heartbeat?: ReturnType<typeof setInterval>;
	private heartbeatMisses = 0;
	private queue: Promise<unknown> = Promise.resolve();
	private pending = 0;
	private revision = -1;
	/** Coalesced input in the order it happened: at most a wheel followed by a pointer move. */
	private coalesced: PendingInput[] = [];
	private coalesceTimer?: ReturnType<typeof setTimeout>;
	private readonly onSnapshot: (state: EmbeddedBrowserSnapshot) => void;
	private readonly onFrame: (frame: EmbeddedBrowserFrame) => void;
	private readonly onError: (error: unknown, disconnected: boolean) => void;

	constructor(
		onSnapshot: (state: EmbeddedBrowserSnapshot) => void,
		onFrame: (frame: EmbeddedBrowserFrame) => void,
		onError: (error: unknown, disconnected: boolean) => void,
	) {
		this.onSnapshot = onSnapshot;
		this.onFrame = onFrame;
		this.onError = onError;
	}

	private request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
		return api<T>(`${ROOT}${path}`, {
			method,
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: { "x-stepcode-browser-control": this.token },
			signal: this.controller.signal,
		});
	}

	private acceptSnapshot(snapshot: EmbeddedBrowserSnapshot): void {
		if (
			this.controller.signal.aborted ||
			!Array.isArray(snapshot.tabs) ||
			!Number.isSafeInteger(snapshot.revision) ||
			snapshot.revision < 0 ||
			snapshot.revision <= this.revision
		)
			return;
		this.revision = snapshot.revision;
		this.onSnapshot(snapshot);
	}

	async connect(): Promise<void> {
		let clientId: string;
		try {
			clientId = sessionStorage.getItem("stepcode-browser-client") || crypto.randomUUID();
			sessionStorage.setItem("stepcode-browser-client", clientId);
		} catch {
			clientId = crypto.randomUUID();
		}
		const result = await this.request<{ token: string }>("/control", "POST", { clientId });
		this.token = result.token;
		if (this.controller.signal.aborted) {
			this.release();
			return;
		}
		this.acceptSnapshot(await this.request<EmbeddedBrowserSnapshot>(""));
		// The connection is established only once its frame stream is: a page whose stream cannot open
		// must not count as connected, or its reconnect budget would reset on every attempt.
		const reader = await this.openStream();
		if (this.controller.signal.aborted) {
			void reader.cancel().catch(() => {
				// Abandoned together with this connection; nothing reads it any more.
			});
			return;
		}
		this.heartbeat = setInterval(() => {
			void this.request<EmbeddedBrowserSnapshot>("")
				.then((snapshot) => {
					this.heartbeatMisses = 0;
					this.acceptSnapshot(snapshot);
				})
				.catch((error: unknown) => {
					if (this.controller.signal.aborted) return;
					// A single slow or failed heartbeat is normal while the window sleeps or the Host is
					// busy; only a run of failures means this page lost its Host. A 409 here is a lapsed
					// lease, not a competing page, so reconnecting recovers it.
					if (++this.heartbeatMisses < 3) return;
					this.onError(new BrowserDisconnect(errorMessage(error), "lost"), true);
					this.close();
				});
		}, 5000);
		void this.readStream(reader).catch((error: unknown) => {
			if (!this.controller.signal.aborted) {
				this.onError(error, true);
				this.close();
			}
		});
	}

	private async openStream(): Promise<ReadableStreamDefaultReader<string>> {
		const response = await fetch(`${ROOT}/events`, {
			headers: { "x-stepcode-browser-control": this.token },
			signal: this.controller.signal,
		});
		if (!response.ok || !response.body) {
			await response.body?.cancel().catch(() => {
				// A refused stream's body holds only the Host's error text.
			});
			throw new BrowserDisconnect(`Browser stream HTTP ${response.status}`, "lost");
		}
		return response.body.pipeThrough(new TextDecoderStream()).getReader();
	}

	private async readStream(reader: ReadableStreamDefaultReader<string>): Promise<void> {
		let pending = "";
		try {
			while (!this.controller.signal.aborted) {
				const { value, done } = await reader.read();
				if (done) throw new BrowserDisconnect("Browser stream disconnected", "lost");
				pending += value;
				if (pending.length > 4_000_000)
					throw new BrowserDisconnect("Browser frame exceeds transport limit", "lost");
				let boundary = pending.indexOf("\n\n");
				while (boundary >= 0) {
					const event = pending.slice(0, boundary);
					pending = pending.slice(boundary + 2);
					const type = event
						.split("\n")
						.find((line) => line.startsWith("event: "))
						?.slice(7);
					const data = event
						.split("\n")
						.find((line) => line.startsWith("data: "))
						?.slice(6);
					if (data && type === "snapshot") this.acceptSnapshot(JSON.parse(data) as EmbeddedBrowserSnapshot);
					if (data && type === "frame") this.onFrame(JSON.parse(data) as EmbeddedBrowserFrame);
					if (type === "closed") throw new BrowserDisconnect("Browser host stopped", "stopped");
					if (type === "replaced")
						throw new BrowserDisconnect("Another StepCode page took over the browser", "replaced");
					boundary = pending.indexOf("\n\n");
				}
			}
		} finally {
			await reader.cancel();
			reader.releaseLock();
		}
	}

	send(path: string, body?: unknown, method = "POST"): void {
		if (!this.token || this.controller.signal.aborted) return;
		this.flushInput();
		this.enqueue(path, body, method);
	}

	private enqueue(path: string, body: unknown, method = "POST"): void {
		if (this.pending >= 48) {
			this.onError(new Error("Browser input queue is full"), false);
			return;
		}
		this.pending++;
		this.queue = this.queue
			.then(async () => {
				const snapshot = await this.request<EmbeddedBrowserSnapshot>(path, method, body);
				this.acceptSnapshot(snapshot);
			})
			.catch((error: unknown) => {
				if (!this.controller.signal.aborted) this.onError(error, false);
			})
			.finally(() => {
				this.pending--;
			});
	}

	/** Coalesce pointer movement: within a frame only the latest position matters, after any earlier wheel. */
	move(path: string, input: BrowserPointerMove): void {
		if (!this.token || this.controller.signal.aborted) return;
		if (this.coalesced[0] && this.coalesced[0].path !== path) this.flushInput();
		const last = this.coalesced.at(-1);
		if (last?.kind === "move") last.input = input;
		else this.coalesced.push({ path, kind: "move", input });
		this.scheduleInput();
	}

	/**
	 * Coalesce wheel input. One request per event cannot keep up: Chromium needs about two frames per
	 * dispatch, so a 120 Hz trackpad fills the bounded queue and dropped events lose scroll distance.
	 * Wheels are summed only when they scroll the same way at the same place, so no distance moves
	 * to another container and a reversal is not cancelled out.
	 */
	wheel(path: string, input: BrowserWheel): void {
		if (!this.token || this.controller.signal.aborted) return;
		if (this.coalesced[0] && this.coalesced[0].path !== path) this.flushInput();
		const [first, second] = this.coalesced;
		if (first?.kind === "move") {
			// The host moves the remote pointer to a wheel's position first, so the pending move is superseded.
			this.coalesced = [];
		} else if (first?.kind === "wheel") {
			const samePlace = near(first.origin, input) && (!second || near(first.origin, second.input));
			const merged = samePlace ? mergeWheels(first.input, input) : undefined;
			if (merged) {
				// A small pointer jitter between notches is part of the same scroll; the wheel moves there itself.
				this.coalesced = [{ ...first, input: merged }];
				this.scheduleInput();
				return;
			}
			this.flushInput();
		}
		this.coalesced.push({ path, kind: "wheel", input: { ...input }, origin: { x: input.x, y: input.y } });
		this.scheduleInput();
	}

	private scheduleInput(): void {
		this.coalesceTimer ??= setTimeout(() => this.flushInput(), INPUT_FLUSH_MS);
	}

	/** Queue coalesced input in the order it happened, before anything that must observe it. */
	private flushInput(): void {
		clearTimeout(this.coalesceTimer);
		this.coalesceTimer = undefined;
		const pending = this.coalesced;
		this.coalesced = [];
		for (const item of pending)
			this.enqueue(item.path, item.kind === "wheel" ? { kind: "wheel", ...item.input } : item.input);
	}

	async selection(id: string): Promise<string> {
		return (await this.request<{ text: string }>(`/tabs/${id}/selection`)).text;
	}

	private release(): void {
		if (!this.token) return;
		void fetch(`${ROOT}/control`, {
			method: "DELETE",
			headers: { "x-stepcode-browser-control": this.token },
			keepalive: true,
		}).catch(() => {
			// On offline/navigation the host's lease expiry releases ownership once this page's
			// stream closes; an attached stream keeps it across a missed heartbeat.
		});
	}

	close(): void {
		clearInterval(this.heartbeat);
		clearTimeout(this.coalesceTimer);
		this.coalesceTimer = undefined;
		this.coalesced = [];
		this.controller.abort();
		this.release();
	}
}

/**
 * Show `url` in the embedded browser panel: the panel opens, and once its connection is ready it reuses a tab
 * already on that page (reloading it, so a rewritten file shows its new content) or opens a new one.
 */
export function openInEmbeddedBrowser(url: string): void {
	setUi((ui) => ({ browserOpenRequest: { url, seq: (ui.browserOpenRequest?.seq ?? 0) + 1 } }));
	openRightPanel("browser");
}

/** Open `url` in the system's default browser (Desktop), or a new tab of this browser (Web). */
export function openInSystemBrowser(url: string): void {
	const bridge = getDesktopBridge();
	if (bridge) {
		void bridge.openExternal(url).catch(() => window.open(url, "_blank", "noopener,noreferrer"));
		return;
	}
	window.open(url, "_blank", "noopener,noreferrer");
}

/** The browser an "open in browser" control launches, as its label and icon show it. */
export interface SystemBrowser extends BrowserIdentity {
	/** The OS's own icon (PNG data URL, Desktop only); preferred over the bundled `mark`. */
	readonly image?: string;
}

// One OS lookup per page: the default browser does not change under a running window often enough to matter.
let desktopBrowser: Promise<DesktopBrowserInfo | null> | undefined;

/** Brand hints from Client Hints, where the browser offers them (Chromium); others rely on the UA string. */
function clientHintBrands(): string[] {
	const data: unknown = Reflect.get(navigator, "userAgentData");
	const brands: unknown = data && typeof data === "object" ? Reflect.get(data, "brands") : undefined;
	if (!Array.isArray(brands)) return [];
	return brands.flatMap((entry: unknown) => {
		const brand: unknown = entry && typeof entry === "object" ? Reflect.get(entry, "brand") : undefined;
		return typeof brand === "string" ? [brand] : [];
	});
}

/**
 * The browser "open in browser" will launch. Desktop: the system's default
 * browser with its OS icon (macOS / Windows), mapped to a bundled mark too.
 * Web: the browser showing this page, since a new tab opens there. Null when
 * it cannot be named (Desktop on Linux, a failed lookup, an unknown browser),
 * so the caller shows its generic label and glyph.
 */
export function useSystemBrowser(): SystemBrowser | null {
	const [info, setInfo] = useState<SystemBrowser | null>(() =>
		getDesktopBridge() ? null : (detectBrowser(navigator.userAgent, clientHintBrands()) ?? null),
	);
	useEffect(() => {
		const bridge = getDesktopBridge();
		// An older desktop build without the method keeps the generic control.
		if (typeof bridge?.defaultBrowser !== "function") return;
		desktopBrowser ??= bridge.defaultBrowser().catch(() => {
			desktopBrowser = undefined;
			return null;
		});
		let live = true;
		void desktopBrowser.then((value) => {
			if (!live || !value) return;
			setInfo({ name: value.name, mark: browserMarkForName(value.name), image: value.icon || undefined });
		});
		return () => {
			live = false;
		};
	}, []);
	return info;
}
