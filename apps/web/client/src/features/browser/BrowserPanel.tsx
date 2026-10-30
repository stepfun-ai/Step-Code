import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { getDesktopBridge } from "../../platform/host";
import { useAppStore } from "../../state/store";
import { Button, Icon, IconButton, type IconName, Tooltip } from "../../ui";
import { openInSystemBrowser } from "./actions";
import {
	addressLabel,
	browserAddress,
	clampZoom,
	isLocalAddress,
	MAX_BROWSER_TABS,
	MAX_BROWSER_ZOOM,
	MIN_BROWSER_ZOOM,
	readStoredTabs,
	type StoredBrowserTab,
} from "./address";
import { type BrowserSurfaceHandle, FrameSurface, type SurfaceState, WebviewSurface } from "./surfaces";

const STORAGE_KEY = "stepcode-browser-tabs";

interface PanelTab extends StoredBrowserTab {
	/** The address the page loads when its surface mounts (the stored one, or the one it was opened with). */
	readonly initialUrl: string;
	readonly loading: boolean;
	readonly canGoBack: boolean;
	readonly canGoForward: boolean;
	readonly urlKnown: boolean;
	readonly error?: string;
	readonly notice?: "download" | "popup" | "navigation" | "invalid";
	/** Desktop only: the guest lease, which main-process events name. */
	readonly lease?: string;
}

function newTab(url = "", stored?: StoredBrowserTab): PanelTab {
	return {
		id: stored?.id ?? crypto.randomUUID(),
		url: stored?.url ?? url,
		title: stored?.title ?? "",
		zoom: stored?.zoom ?? 1,
		initialUrl: stored?.url ?? url,
		loading: false,
		canGoBack: false,
		canGoForward: false,
		urlKnown: true,
	};
}

function readTabs(): { activeId: string | null; tabs: PanelTab[] } {
	let raw: string | null = null;
	try {
		raw = sessionStorage.getItem(STORAGE_KEY);
	} catch {
		// Storage can be disabled; the panel then starts empty on every load.
	}
	const stored = readStoredTabs(raw, window.location.origin);
	return { activeId: stored.activeId, tabs: stored.tabs.map((tab) => newTab("", tab)) };
}

/**
 * The embedded browser. Desktop renders each tab as an Electron `<webview>` the main process approved; a plain
 * browser renders a sandboxed iframe. Either way Chromium draws the page itself: there is no Host-side engine,
 * screenshot stream or input forwarding. Tabs are this page's own and survive a reload through
 * sessionStorage; a hidden panel keeps its pages mounted, and pages are created only once it was shown.
 */
export function BrowserPanel({ open }: { open: boolean }) {
	const t = useT();
	const bridge = getDesktopBridge();
	// An older Desktop build without the webview lease falls back to the iframe.
	const desktop = bridge !== undefined && typeof bridge.browserGuest === "function" ? bridge : undefined;
	const [state, setState] = useState(readTabs);
	const [shown, setShown] = useState(open);
	const [address, setAddress] = useState("");
	const handles = useRef(new Map<string, BrowserSurfaceHandle>());
	const addressInput = useRef<HTMLInputElement>(null);
	const openRequest = useAppStore((store) => store.ui.browserOpenRequest);
	const handledRequest = useRef(0);
	const latest = useRef(state);
	latest.current = state;
	const active = state.tabs.find((tab) => tab.id === state.activeId);
	const activeId = active?.id;

	useEffect(() => {
		if (open) setShown(true);
	}, [open]);
	useEffect(() => {
		setAddress(active?.url ?? "");
	}, [active?.url]);
	useEffect(() => {
		const stored = {
			activeId: state.activeId,
			tabs: state.tabs.map(({ id, url, title, zoom }) => ({ id, url, title, zoom })),
		};
		try {
			sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
		} catch {
			// Best effort: without storage a reload starts with no tabs, which is still a working panel.
		}
	}, [state]);

	const update = useCallback((id: string, change: Partial<PanelTab>) => {
		setState((current) => ({
			...current,
			tabs: current.tabs.map((tab) => (tab.id === id ? { ...tab, ...change } : tab)),
		}));
	}, []);
	const surfaceState = useCallback(
		(id: string, observed: SurfaceState) => {
			const { error, ...rest } = observed;
			update(id, error === undefined ? rest : { ...rest, error: error ?? undefined });
		},
		[update],
	);
	const openTab = useCallback(
		(url = "") => {
			const current = latest.current;
			if (current.tabs.length >= MAX_BROWSER_TABS) {
				if (current.activeId) update(current.activeId, { notice: "popup" });
				return;
			}
			const tab = newTab(url);
			setState({ activeId: tab.id, tabs: [...current.tabs, tab] });
			setShown(true);
		},
		[update],
	);
	const closeTab = useCallback((id: string) => {
		setState((current) => {
			const index = current.tabs.findIndex((tab) => tab.id === id);
			const tabs = current.tabs.filter((tab) => tab.id !== id);
			const activeId =
				current.activeId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : current.activeId;
			return { activeId, tabs };
		});
	}, []);
	/** Load an address in the active tab, or a new one when there is none. */
	const go = useCallback(
		(raw: string) => {
			const target = browserAddress(raw, window.location.origin);
			const current = latest.current;
			const tab = current.tabs.find((entry) => entry.id === current.activeId);
			if (!target.ok) {
				if (tab) update(tab.id, { notice: target.reason === "invalid" ? "invalid" : "navigation" });
				return;
			}
			const handle = tab ? handles.current.get(tab.id) : undefined;
			if (!tab || !handle) {
				openTab(target.url);
				return;
			}
			update(tab.id, { notice: undefined, error: undefined, url: target.url, title: "" });
			handle.navigate(target.url);
		},
		[openTab, update],
	);
	const shortcut = useCallback(
		(key: "r" | "l" | "t" | "w") => {
			const id = latest.current.activeId;
			if (key === "l") addressInput.current?.focus();
			if (key === "t") openTab();
			if (key === "w" && id) closeTab(id);
			if (key === "r" && id) handles.current.get(id)?.reload();
		},
		[closeTab, openTab],
	);

	// Another feature asked for a page (a delivered file's preview): reuse a tab already on it, reloaded so a
	// rewritten file shows its new content, or open a new one. Each request is handled once.
	useEffect(() => {
		if (!openRequest || openRequest.seq <= handledRequest.current) return;
		handledRequest.current = openRequest.seq;
		const existing = latest.current.tabs.find((tab) => tab.url === openRequest.url);
		if (existing) {
			setState((current) => ({ ...current, activeId: existing.id }));
			handles.current.get(existing.id)?.reload();
		} else openTab(openRequest.url);
	}, [openRequest, openTab]);

	// Desktop pages report popups, cancelled downloads and panel shortcuts through the main process.
	useEffect(() => {
		if (!desktop) return;
		return desktop.onBrowserEvent((event) => {
			const tab = latest.current.tabs.find((entry) => entry.lease === event.lease);
			if (!tab) return;
			if (event.type === "popup") {
				const target = browserAddress(event.url, window.location.origin);
				if (target.ok) openTab(target.url);
			} else if (event.type === "download") update(tab.id, { notice: "download" });
			else shortcut(event.key);
		});
	}, [desktop, openTab, shortcut, update]);

	const control = (icon: IconName, label: string, onClick: () => void, disabled = false) => (
		<Tooltip content={t(label)}>
			<IconButton icon={icon} aria-label={t(label)} onClick={onClick} disabled={disabled} />
		</Tooltip>
	);
	const handle = activeId ? handles.current.get(activeId) : undefined;
	const zoom = (value: number) => {
		if (activeId) update(activeId, { zoom: clampZoom(value) });
	};
	const external = active?.url.startsWith("http") ? active.url : "";
	const status = !active
		? ""
		: active.loading
			? t("browserLoading")
			: !active.urlKnown
				? t("browserAddressUnknown")
				: !desktop && active.url && !isLocalAddress(active.url)
					? t("browserFramingHint")
					: "";

	return (
		<section
			className="embedded-browser"
			hidden={!open}
			aria-label={t("browserTitle")}
			data-browser-surface={desktop ? "webview" : "iframe"}
			onKeyDownCapture={(event) => {
				if (!(event.ctrlKey || event.metaKey) || event.nativeEvent.isComposing) return;
				// AltGr (Ctrl+Alt on Windows) prints characters; it is never a panel shortcut.
				if (event.altKey || event.shiftKey || event.getModifierState("AltGraph")) return;
				const key = event.key.toLowerCase();
				if (key !== "l" && key !== "t" && key !== "w" && key !== "r") return;
				event.preventDefault();
				event.stopPropagation();
				shortcut(key);
			}}
		>
			<div className="browser-tabs" role="tablist" aria-label={t("browserTabs")}>
				{state.tabs.map((tab) => (
					<div
						className={`browser-tab${activeId === tab.id ? " is-active" : ""}${tab.loading ? " is-loading" : ""}`}
						key={tab.id}
					>
						<Button
							role="tab"
							aria-selected={activeId === tab.id}
							onClick={() => setState((current) => ({ ...current, activeId: tab.id }))}
						>
							<Icon name={tab.loading ? "loaderCircle" : "globe"} size="xs" />
							<span>{tab.title || (tab.url ? addressLabel(tab.url) : t("browserNewTab"))}</span>
						</Button>
						<Tooltip content={t("closeTab")}>
							<IconButton
								icon="closeSm"
								aria-label={`${t("closeTab")} ${tab.title || t("browserNewTab")}`}
								onClick={() => closeTab(tab.id)}
							/>
						</Tooltip>
					</div>
				))}
				{control("plus", "browserNewTab", () => openTab(), state.tabs.length >= MAX_BROWSER_TABS)}
			</div>
			<form
				className="browser-navigation"
				onSubmit={(event) => {
					event.preventDefault();
					go(address);
				}}
			>
				<div className="browser-nav-buttons">
					{control("chevronLeft", "browserBack", () => handle?.back(), !active?.canGoBack)}
					{control("chevronRight", "browserForward", () => handle?.forward(), !active?.canGoForward)}
					{active?.loading && handle?.stop
						? control("stop", "browserStop", () => handle.stop?.())
						: control("refresh", "reload", () => handle?.reload(), !active?.url)}
				</div>
				<input
					ref={addressInput}
					className="browser-address"
					aria-label={t("browserAddress")}
					placeholder={t("browserAddress")}
					value={address}
					onChange={(event) => setAddress(event.target.value)}
					onFocus={(event) => event.currentTarget.select()}
					spellCheck={false}
					autoComplete="off"
				/>
				<Tooltip content={t("go")}>
					<IconButton type="submit" icon="chevronRight" aria-label={t("go")} disabled={!address.trim()} />
				</Tooltip>
			</form>
			{active?.error ? (
				<div className="browser-error" role="alert">
					<span>{active.error}</span>
					<Tooltip content={t("reload")}>
						<IconButton icon="refresh" aria-label={t("reload")} onClick={() => handle?.reload()} />
					</Tooltip>
				</div>
			) : null}
			{active?.notice ? <output className="browser-notice">{t(`browserNotice.${active.notice}`)}</output> : null}
			<div className="browser-surface" role="presentation">
				{shown
					? state.tabs.map((tab) => {
							const props = {
								initialUrl: tab.initialUrl,
								zoom: tab.zoom,
								active: tab.id === activeId,
								label: tab.title || t("browserPage"),
								onState: (observed: SurfaceState) => surfaceState(tab.id, observed),
								onHandle: (value: BrowserSurfaceHandle | null) => {
									if (value) handles.current.set(tab.id, value);
									else handles.current.delete(tab.id);
								},
							};
							return desktop ? (
								<WebviewSurface
									key={tab.id}
									{...props}
									bridge={desktop}
									onLease={(lease) => update(tab.id, { lease })}
								/>
							) : (
								<FrameSurface key={tab.id} {...props} />
							);
						})
					: null}
				{!active?.url ? (
					<div className="browser-empty">
						<Icon name="globe" size="lg" />
						<span>{t("browserNewTab")}</span>
					</div>
				) : null}
			</div>
			<footer className="browser-footer">
				<output>{status}</output>
				{control(
					"circleMinus",
					"browserZoomOut",
					() => zoom((active?.zoom ?? 1) - 0.1),
					!active || active.zoom <= MIN_BROWSER_ZOOM,
				)}
				<Button
					className="browser-zoom"
					disabled={!active}
					onClick={() => zoom(1)}
					aria-label={t("browserZoomReset")}
				>
					{Math.round((active?.zoom ?? 1) * 100)}%
				</Button>
				{control(
					"plus",
					"browserZoomIn",
					() => zoom((active?.zoom ?? 1) + 0.1),
					!active || active.zoom >= MAX_BROWSER_ZOOM,
				)}
				{control("openExternal", "browserExternal", () => openInSystemBrowser(external), !external)}
			</footer>
		</section>
	);
}
