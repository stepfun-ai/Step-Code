/**
 * Pure embedded-browser policy shared by both surfaces: what the address bar accepts and what a tab
 * remembers across a page reload. No DOM, store or bridge access, so it is unit-tested directly.
 */

/** The panel keeps at most this many tabs (Desktop leases one webview per tab). */
export const MAX_BROWSER_TABS = 12;
export const MIN_BROWSER_ZOOM = 0.5;
export const MAX_BROWSER_ZOOM = 2;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/** Whether `hostname` (as `URL.hostname` reports it) names this machine. */
export function isLoopbackHost(hostname: string): boolean {
	return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost");
}

/** Whether a loaded address is on this machine (a preview or dev server), where framing is never refused. */
export function isLocalAddress(raw: string): boolean {
	try {
		return isLoopbackHost(new URL(raw).hostname);
	} catch {
		return false;
	}
}

function effectivePort(url: URL): number {
	return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

export type BrowserAddress =
	| { readonly ok: true; readonly url: string }
	| { readonly ok: false; readonly reason: "invalid" | "blocked" };

/**
 * Normalize what the user typed into a loadable address. A bare host gets `https://`, or `http://` when it
 * names this machine (`localhost:5173`). Only http(s) without embedded credentials is accepted, and never
 * the port StepCode's own page is served from (`appOrigin`), on any hostname: in the Web iframe a frame of
 * the client itself would be same-origin and could lift its sandbox. The Host additionally refuses to be
 * framed, and Desktop's main process blocks the Host port for every guest request.
 */
export function browserAddress(raw: string, appOrigin: string): BrowserAddress {
	const text = raw.trim();
	if (!text || text.length > 8192) return { ok: false, reason: "invalid" };
	let url: URL;
	try {
		if (/^[a-z][a-z\d+.-]*:\/\//i.test(text)) url = new URL(text);
		else {
			const probe = new URL(`http://${text}`);
			url = new URL(`${isLoopbackHost(probe.hostname) ? "http" : "https"}://${text}`);
		}
	} catch {
		return { ok: false, reason: "invalid" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "blocked" };
	if (url.username || url.password) return { ok: false, reason: "blocked" };
	let app: URL | undefined;
	try {
		app = new URL(appOrigin);
	} catch {
		app = undefined;
	}
	if (
		app &&
		effectivePort(url) === effectivePort(app) &&
		(isLoopbackHost(url.hostname) || url.hostname === app.hostname)
	)
		return { ok: false, reason: "blocked" };
	return { ok: true, url: url.href };
}

/** What a tab keeps across a page reload: enough to reopen it, nothing the page could not recompute. */
export interface StoredBrowserTab {
	readonly id: string;
	readonly url: string;
	readonly title: string;
	readonly zoom: number;
}

export interface StoredBrowserTabs {
	readonly activeId: string | null;
	readonly tabs: readonly StoredBrowserTab[];
}

/** Validate `sessionStorage` content; anything malformed is dropped rather than trusted. */
export function readStoredTabs(raw: string | null, appOrigin: string): StoredBrowserTabs {
	const empty: StoredBrowserTabs = { activeId: null, tabs: [] };
	if (!raw) return empty;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return empty;
	}
	if (typeof value !== "object" || value === null) return empty;
	const list: unknown = Reflect.get(value, "tabs");
	if (!Array.isArray(list)) return empty;
	const tabs: StoredBrowserTab[] = [];
	for (const entry of list.slice(0, MAX_BROWSER_TABS)) {
		if (typeof entry !== "object" || entry === null) continue;
		const id: unknown = Reflect.get(entry, "id");
		const url: unknown = Reflect.get(entry, "url");
		const title: unknown = Reflect.get(entry, "title");
		const zoom: unknown = Reflect.get(entry, "zoom");
		if (typeof id !== "string" || !id || typeof url !== "string") continue;
		const address = url ? browserAddress(url, appOrigin) : undefined;
		if (address && !address.ok) continue;
		tabs.push({
			id,
			url: address?.ok ? address.url : "",
			title: typeof title === "string" ? title.slice(0, 512) : "",
			zoom: clampZoom(typeof zoom === "number" ? zoom : 1),
		});
	}
	const activeId: unknown = Reflect.get(value, "activeId");
	const active = typeof activeId === "string" && tabs.some((tab) => tab.id === activeId) ? activeId : null;
	return { activeId: active ?? tabs.at(-1)?.id ?? null, tabs };
}

/** Zoom in tenths between 50% and 200%. */
export function clampZoom(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.round(Math.min(MAX_BROWSER_ZOOM, Math.max(MIN_BROWSER_ZOOM, value)) * 10) / 10;
}

/** A tab label when the page title is unknown: the host, or the address itself. */
export function addressLabel(url: string): string {
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}
