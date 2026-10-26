/**
 * Which browser a "open in browser" control will launch, for its label and
 * icon. Display only: nothing is decided by it.
 */

/** Browsers with a bundled brand mark (`browser<Mark>` sprite icons). */
export type BrowserMark = "chrome" | "safari" | "edge" | "firefox";

export interface BrowserIdentity {
	/** Display name, e.g. "Google Chrome". */
	readonly name: string;
	readonly mark?: BrowserMark;
}

/**
 * The brand mark for a browser named by the OS (Desktop's default-browser
 * lookup: "Google Chrome", "Safari", "Microsoft Edge", "Firefox", "Firefox
 * Developer Edition"...). Chromium forks keep their own name and get no mark.
 */
export function browserMarkForName(name: string): BrowserMark | undefined {
	const value = name.toLowerCase();
	if (value.includes("edge")) return "edge";
	if (value.includes("firefox")) return "firefox";
	if (value.includes("safari")) return "safari";
	if (/\bchrome\b/.test(value) && !value.includes("chromium")) return "chrome";
	return undefined;
}

/**
 * The browser this page runs in, from its user agent (and Client Hints brands
 * where the browser offers them). In StepCode Web this is where "open in
 * browser" lands: `window.open` opens a tab of the same browser. Undefined for
 * one it cannot name with confidence (Electron, unknown engines).
 */
export function detectBrowser(userAgent: string, brands: readonly string[] = []): BrowserIdentity | undefined {
	if (/\bElectron\//.test(userAgent)) return undefined;
	// Client Hints name the product precisely; the UA string of every Chromium fork claims "Chrome".
	if (brands.includes("Microsoft Edge")) return { name: "Microsoft Edge", mark: "edge" };
	if (brands.includes("Google Chrome")) return { name: "Google Chrome", mark: "chrome" };
	const fork = brands.find((brand) => ["Brave", "Opera", "Vivaldi", "Arc", "Yandex"].includes(brand));
	if (fork) return { name: fork };
	if (/\bEdg(?:e|A|iOS)?\//.test(userAgent)) return { name: "Microsoft Edge", mark: "edge" };
	if (/\bOPR\//.test(userAgent)) return { name: "Opera" };
	if (/\b(?:Firefox|FxiOS)\//.test(userAgent)) return { name: "Firefox", mark: "firefox" };
	if (/\b(?:Chrome|CriOS)\//.test(userAgent)) return { name: "Google Chrome", mark: "chrome" };
	if (/\bVersion\/[\d.]+.*\bSafari\//.test(userAgent)) return { name: "Safari", mark: "safari" };
	return undefined;
}
