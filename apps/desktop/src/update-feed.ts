/**
 * The update channel: the release manifest the pipeline publishes, and the
 * files in it this app can update with.
 *
 * Pure functions (no Electron, no I/O) so they run under plain `node --test`.
 *
 * The channel is the one `infra/release/desktop-release.mjs` writes on the CI
 * branch, a single file for every platform:
 *
 *   <feed>/latest.json         the channel pointer, uploaded last
 *   <feed>/<v>/<installer>     immutable per release
 *
 *   { "product": "stepcode-desktop", "version": "0.1.4", "publishedAt": "...",
 *     "assets": [{ "platform": "darwin", "arch": "arm64", "kind": "zip",
 *                  "fileName": "StepCode-0.1.4-mac-arm64.zip", "url": "https://...",
 *                  "size": 123, "sha256": "<hex>", "sha512": "<base64>" }, ...] }
 *
 * electron-updater installs from the `zip` assets on macOS (Squirrel.Mac) and
 * the `nsis` asset on Windows; dmgs are for first installs only. URLs must be
 * https; plain http is accepted for loopback hosts only (local testing).
 */

export const UPDATE_MANIFEST_FILE = "latest.json";
const PRODUCT = "stepcode-desktop";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/u;

export type UpdatePlatform = "darwin" | "win32";

export interface UpdateAsset {
	readonly platform: UpdatePlatform;
	readonly arch: "arm64" | "x64";
	readonly kind: "zip" | "nsis";
	readonly url: string;
	readonly size: number;
	readonly sha512: string;
}

export interface UpdateRelease {
	readonly version: string;
	readonly releaseDate?: string;
	/** Every update payload in the manifest, all platforms. */
	readonly assets: readonly UpdateAsset[];
}

function isLoopback(hostname: string): boolean {
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/** Throws unless `value` is an https URL, or an http URL on a loopback host. */
export function assertUpdateUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Not a valid update URL: ${value}`);
	}
	if (url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname))) return url;
	throw new Error(`Update URLs must be https (got ${url.protocol}//${url.host})`);
}

/** `<feed>/latest.json`; the feed is the channel directory (`.../stepcode/desktop/`). */
export function manifestUrl(feed: string): URL {
	const base = assertUpdateUrl(feed.endsWith("/") ? feed : `${feed}/`);
	return new URL(UPDATE_MANIFEST_FILE, base);
}

function record(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${what} is not an object`);
	return value as Record<string, unknown>;
}

function parseAsset(value: unknown, index: number, base: URL): UpdateAsset | undefined {
	const asset = record(value, `assets[${index}]`);
	const { platform, arch, kind } = asset;
	// dmgs and anything this app does not install from are not update payloads.
	if (!((platform === "darwin" && kind === "zip") || (platform === "win32" && kind === "nsis"))) return undefined;
	if (arch !== "arm64" && arch !== "x64") throw new Error(`assets[${index}] has an unknown arch`);
	if (typeof asset.url !== "string") throw new Error(`assets[${index}] has no url`);
	const url = assertUpdateUrl(new URL(asset.url, base).href).href;
	if (typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
		throw new Error(`assets[${index}] has no valid size`);
	}
	if (typeof asset.sha512 !== "string" || !SHA512_BASE64.test(asset.sha512)) {
		throw new Error(`assets[${index}] has no base64 sha512`);
	}
	return { platform, arch, kind, url, size: asset.size, sha512: asset.sha512 };
}

/** Validate the published manifest; `source` resolves relative asset URLs. */
export function parseRelease(raw: unknown, source: URL): UpdateRelease {
	const manifest = record(raw, "update manifest");
	if (manifest.product !== PRODUCT) throw new Error(`update manifest is not for ${PRODUCT}`);
	if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
		throw new Error("update manifest has no semver version");
	}
	if (!Array.isArray(manifest.assets)) throw new Error("update manifest has no assets");
	const assets = manifest.assets.flatMap((asset, index) => parseAsset(asset, index, source) ?? []);
	return {
		version: manifest.version,
		...(typeof manifest.publishedAt === "string" ? { releaseDate: manifest.publishedAt } : {}),
		assets,
	};
}

/**
 * The payloads this platform installs from. macOS gets both architectures and
 * lets electron-updater pick (an x64 app on Apple Silicon may move to arm64;
 * both carry the same Developer ID, which Squirrel.Mac requires).
 */
export function assetsFor(release: UpdateRelease, platform: string): readonly UpdateAsset[] {
	return release.assets.filter((asset) => asset.platform === platform);
}

/**
 * Why this copy cannot update itself, or undefined when it can. A mac app run
 * from the disk image or from App Translocation (quarantined, not moved to a
 * folder) has no writable bundle to replace.
 */
export function installBlocker(platform: string, executable: string): string | undefined {
	if (platform === "darwin") {
		if (executable.startsWith("/Volumes/")) return "running from the disk image: move StepCode to Applications";
		if (executable.includes("/AppTranslocation/"))
			return "running from a translocated copy: move StepCode to Applications";
		return undefined;
	}
	if (platform === "win32") return undefined;
	return `no update payload is published for ${platform}`;
}
