import { useEffect, useState } from "react";
import { type BrowserIdentity, browserMarkForName, detectBrowser } from "../../lib/browser-identity";
import { type DesktopBrowserInfo, getDesktopBridge } from "../../platform/host";
import { openRightPanel } from "../../state/right-panel";
import { setUi } from "../../state/store";

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
