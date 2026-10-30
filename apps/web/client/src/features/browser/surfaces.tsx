import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/api";
import type { DesktopBrowserGuest, StepcodeDesktopBridge } from "../../platform/host";
import { eventBoolean, eventNumber, eventString, type WebviewElement } from "./webview";

/** What a surface observed about its page; omitted fields are unchanged. */
export interface SurfaceState {
	readonly url?: string;
	readonly title?: string;
	readonly loading?: boolean;
	readonly canGoBack?: boolean;
	readonly canGoForward?: boolean;
	/** False once a cross-origin frame navigated by itself: the address bar shows the last known address. */
	readonly urlKnown?: boolean;
	/** A failed main-frame load, or null to clear it. */
	readonly error?: string | null;
}

/** Commands the panel's toolbar sends to the page of one tab. */
export interface BrowserSurfaceHandle {
	navigate(url: string): void;
	back(): void;
	forward(): void;
	reload(): void;
	/** Stops a load; the Web iframe cannot, so its handle has none. */
	readonly stop?: () => void;
	focus(): void;
}

interface SurfaceProps {
	/** Loaded once when the surface mounts; later navigation goes through the handle. */
	readonly initialUrl: string;
	readonly zoom: number;
	readonly active: boolean;
	readonly label: string;
	readonly onState: (state: SurfaceState) => void;
	readonly onHandle: (handle: BrowserSurfaceHandle | null) => void;
}

/** The start page of an empty tab, never shown as its address. */
function visibleUrl(url: string): string {
	return url.startsWith("about:blank") ? "" : url;
}

/**
 * Desktop: an Electron `<webview>`, rendered by Chromium directly into the window. The lease is reserved
 * from the main process first; the element is created only with it, because Electron reads `src` and
 * `partition` once, at attachment. Unmounting (a closed tab) releases the lease and destroys the page.
 */
export function WebviewSurface(
	props: SurfaceProps & { readonly bridge: StepcodeDesktopBridge; readonly onLease: (lease: string) => void },
) {
	const { bridge, onLease, onState } = props;
	const [guest, setGuest] = useState<DesktopBrowserGuest>();
	const view = useRef<WebviewElement>(null);
	const zoom = useRef(props.zoom);
	zoom.current = props.zoom;
	const ready = useRef(false);
	/** Navigation requested before the guest is ready; the initial address is the first. */
	const pending = useRef(props.initialUrl);
	const callbacks = useRef({ onState, onLease, onHandle: props.onHandle });
	callbacks.current = { onState, onLease, onHandle: props.onHandle };

	// biome-ignore lint/correctness/useExhaustiveDependencies: one lease per mounted tab; the bridge never changes.
	useEffect(() => {
		let live = true;
		let lease: string | undefined;
		bridge
			.browserGuest()
			.then((reserved) => {
				if (!live) {
					void bridge.releaseBrowserGuest(reserved.lease).catch(() => {
						// The window reload that unmounted this tab releases its leases in the main process too.
					});
					return;
				}
				lease = reserved.lease;
				callbacks.current.onLease(reserved.lease);
				setGuest(reserved);
			})
			.catch((failure: unknown) => {
				if (live) callbacks.current.onState({ error: errorMessage(failure), loading: false });
			});
		return () => {
			live = false;
			if (lease !== undefined)
				void bridge.releaseBrowserGuest(lease).catch(() => {
					// Already destroyed with its element; the main process forgets unknown leases.
				});
		};
	}, []);

	useEffect(() => {
		const element = view.current;
		if (!guest || !element) return;
		const report = (state: SurfaceState) => callbacks.current.onState(state);
		const load = (url: string) => {
			void element.loadURL(url).catch(() => {
				// `did-fail-load` reports the failure with Chromium's own text.
			});
		};
		const sync = () => {
			if (!ready.current) return;
			report({
				url: visibleUrl(element.getURL()),
				canGoBack: element.canGoBack(),
				canGoForward: element.canGoForward(),
				urlKnown: true,
			});
		};
		const listeners: [string, (event: Event) => void][] = [
			[
				"dom-ready",
				() => {
					if (!ready.current) {
						ready.current = true;
						element.setZoomFactor(zoom.current);
						const first = pending.current;
						pending.current = "";
						if (first) load(first);
					}
					sync();
				},
			],
			["did-start-loading", () => report({ loading: true, error: null })],
			[
				"did-stop-loading",
				() => {
					report({ loading: false });
					sync();
				},
			],
			["did-navigate", sync],
			[
				"did-navigate-in-page",
				(event) => {
					if (eventBoolean(event, "isMainFrame") !== false) sync();
				},
			],
			[
				"page-title-updated",
				(event) => {
					const title = eventString(event, "title");
					if (title !== undefined) report({ title: title.slice(0, 512) });
				},
			],
			[
				"did-fail-load",
				(event) => {
					const code = eventNumber(event, "errorCode");
					// -3 is ERR_ABORTED: a stop, or a navigation replaced by the next one.
					if (eventBoolean(event, "isMainFrame") === false || code === -3) return;
					const description = eventString(event, "errorDescription") || "Load failed";
					report({ loading: false, error: code === undefined ? description : `${description} (${code})` });
				},
			],
		];
		for (const [name, listener] of listeners) element.addEventListener(name, listener);
		const whenReady = (command: () => void) => () => {
			if (ready.current) command();
		};
		callbacks.current.onHandle({
			navigate: (url) => {
				if (ready.current) load(url);
				else pending.current = url;
			},
			back: whenReady(() => element.goBack()),
			forward: whenReady(() => element.goForward()),
			reload: whenReady(() => element.reload()),
			stop: whenReady(() => element.stop()),
			focus: () => element.focus(),
		});
		return () => {
			for (const [name, listener] of listeners) element.removeEventListener(name, listener);
			callbacks.current.onHandle(null);
		};
	}, [guest]);

	useEffect(() => {
		if (ready.current) view.current?.setZoomFactor(props.zoom);
	}, [props.zoom]);

	if (!guest) return null;
	return (
		<webview
			ref={view}
			className={`browser-page${props.active ? "" : " is-hidden"}`}
			src={`about:blank#${guest.lease}`}
			partition={guest.partition}
			// Electron reads presence, not value. @types/react models it as a boolean, which React would print as
			// "true" with a warning; an empty string is the attribute's plain presence.
			allowpopups={"" as unknown as boolean}
			aria-label={props.label}
		/>
	);
}

/** Sandbox for the Web iframe: no top-level navigation, downloads or modal dialogs. */
const FRAME_SANDBOX = "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/**
 * Web: a sandboxed iframe, rendered by the user's own browser. A cross-origin frame hides its address, title
 * and history, so this surface keeps its own history of the navigations it started. The first `load` after
 * one is that navigation; any later `load` means the page moved by itself, and the address becomes unknown.
 */
export function FrameSurface(props: SurfaceProps) {
	const frame = useRef<HTMLIFrameElement>(null);
	const history = useRef<{ entries: string[]; index: number }>({ entries: [], index: -1 });
	const loads = useRef(0);
	const callbacks = useRef({ onState: props.onState, onHandle: props.onHandle });
	callbacks.current = { onState: props.onState, onHandle: props.onHandle };

	// biome-ignore lint/correctness/useExhaustiveDependencies: the initial address is read once, on mount.
	useEffect(() => {
		const element = frame.current;
		if (!element) return;
		const report = (state: SurfaceState) => callbacks.current.onState(state);
		const show = () => {
			const { entries, index } = history.current;
			const url = entries[index];
			if (url === undefined) return;
			loads.current = 0;
			// Assigning `src` navigates even when the value is unchanged, which is what reload needs.
			element.src = url;
			report({
				url,
				loading: true,
				urlKnown: true,
				error: null,
				canGoBack: index > 0,
				canGoForward: index < entries.length - 1,
			});
		};
		const navigate = (url: string) => {
			const { entries, index } = history.current;
			history.current = { entries: [...entries.slice(0, index + 1), url], index: index + 1 };
			show();
		};
		const onLoad = () => {
			if (!element.getAttribute("src")) return;
			loads.current++;
			report(loads.current === 1 ? { loading: false } : { loading: false, urlKnown: false, canGoBack: true });
		};
		element.addEventListener("load", onLoad);
		callbacks.current.onHandle({
			navigate,
			back: () => {
				// After the page moved by itself, the first step back is the last address this surface knows.
				if (loads.current > 1) return show();
				if (history.current.index <= 0) return;
				history.current = { ...history.current, index: history.current.index - 1 };
				show();
			},
			forward: () => {
				const { entries, index } = history.current;
				if (index >= entries.length - 1) return;
				history.current = { entries, index: index + 1 };
				show();
			},
			reload: show,
			focus: () => element.focus(),
		});
		if (props.initialUrl && history.current.entries.length === 0) navigate(props.initialUrl);
		return () => {
			element.removeEventListener("load", onLoad);
			callbacks.current.onHandle(null);
		};
	}, []);

	// Zoom lays the page out at 1/zoom of the panel and scales it back, like browser zoom on a fixed window.
	const scale = props.zoom;
	return (
		<iframe
			ref={frame}
			className={`browser-page${props.active ? "" : " is-hidden"}`}
			title={props.label}
			sandbox={FRAME_SANDBOX}
			referrerPolicy="no-referrer"
			style={
				scale === 1
					? undefined
					: {
							width: `${100 / scale}%`,
							height: `${100 / scale}%`,
							transform: `scale(${scale})`,
							transformOrigin: "0 0",
						}
			}
		/>
	);
}
