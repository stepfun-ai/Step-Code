// Types for the parts of desktop-release.mjs that apps/desktop's tests use to
// check the app reads exactly the manifest this script publishes.

export interface DesktopTarget {
	readonly platform: "darwin" | "win32";
	readonly arch: "arm64" | "x64";
	readonly kind: "dmg" | "zip" | "nsis";
	readonly suffix: string;
}

export interface DesktopAsset extends DesktopTarget {
	readonly fileName: string;
	readonly size: number;
	readonly sha256: string;
	readonly sha512: string;
}

export declare const DESKTOP_TARGETS: readonly DesktopTarget[];

export declare function buildDesktopManifest(options: {
	readonly version: string;
	readonly baseUrl: string;
	readonly assets: readonly DesktopAsset[];
	readonly commit?: string;
	readonly publishedAt: string;
}): unknown;
