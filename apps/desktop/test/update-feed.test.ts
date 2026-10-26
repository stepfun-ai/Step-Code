import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildDesktopManifest, DESKTOP_TARGETS } from "../../../infra/release/desktop-release.mjs";
import { assertUpdateUrl, assetsFor, installBlocker, manifestUrl, parseRelease } from "../src/update-feed.ts";

const FEED = "https://release.example.test/stepcode/desktop/";

/** The manifest the release pipeline publishes, built by its own code. */
function publishedManifest(version = "1.2.3"): unknown {
	const assets = DESKTOP_TARGETS.map((target) => {
		const fileName = `StepCode-${version}-${target.suffix}`;
		return {
			...target,
			fileName,
			size: 1000 + fileName.length,
			sha256: createHash("sha256").update(fileName).digest("hex"),
			sha512: createHash("sha512").update(fileName).digest("base64"),
		};
	});
	return buildDesktopManifest({
		version,
		baseUrl: "https://release.example.test/stepcode",
		assets,
		commit: "abc123",
		publishedAt: "2026-01-01T00:00:00.000Z",
	});
}

test("the channel is <feed>/latest.json, https only (http for loopback)", () => {
	assert.equal(manifestUrl(FEED).href, `${FEED}latest.json`);
	assert.equal(manifestUrl(FEED.slice(0, -1)).href, `${FEED}latest.json`);
	assert.equal(manifestUrl("http://127.0.0.1:8123/").href, "http://127.0.0.1:8123/latest.json");
	assert.throws(() => manifestUrl("http://release.example.test/desktop/"), /must be https/);
	assert.throws(() => assertUpdateUrl("file:///etc/passwd"), /must be https/);
	assert.throws(() => assertUpdateUrl("not a url"), /Not a valid update URL/);
});

test("the app reads the manifest the release pipeline publishes", () => {
	const release = parseRelease(publishedManifest(), manifestUrl(FEED));
	assert.equal(release.version, "1.2.3");
	assert.equal(release.releaseDate, "2026-01-01T00:00:00.000Z");
	// dmgs are first-install media, not update payloads.
	assert.deepEqual(
		release.assets.map((asset) => `${asset.platform}/${asset.arch}/${asset.kind}`),
		["darwin/arm64/zip", "darwin/x64/zip", "win32/x64/nsis"],
	);
	const mac = assetsFor(release, "darwin");
	assert.deepEqual(
		mac.map((asset) => asset.url),
		[
			"https://release.example.test/stepcode/desktop/1.2.3/StepCode-1.2.3-mac-arm64.zip",
			"https://release.example.test/stepcode/desktop/1.2.3/StepCode-1.2.3-mac-x64.zip",
		],
	);
	const [win] = assetsFor(release, "win32");
	assert.equal(win?.url, "https://release.example.test/stepcode/desktop/1.2.3/StepCode-1.2.3-win-x64.exe");
	assert.equal(win?.sha512, createHash("sha512").update("StepCode-1.2.3-win-x64.exe").digest("base64"));
	assert.deepEqual(assetsFor(release, "linux"), []);
});

test("a manifest that is not a StepCode release, or lacks what electron-updater needs, is refused", () => {
	const source = manifestUrl(FEED);
	const valid = publishedManifest() as Record<string, unknown> & { assets: Record<string, unknown>[] };
	assert.throws(() => parseRelease({ ...valid, product: "other" }, source), /not for stepcode-desktop/);
	assert.throws(() => parseRelease({ ...valid, version: "latest" }, source), /semver/);
	assert.throws(() => parseRelease({ ...valid, assets: undefined }, source), /no assets/);
	const without = (field: string) => ({
		...valid,
		assets: valid.assets.map((asset) => (asset.kind === "nsis" ? { ...asset, [field]: undefined } : asset)),
	});
	assert.throws(() => parseRelease(without("sha512"), source), /sha512/);
	assert.throws(() => parseRelease(without("size"), source), /size/);
	const insecure = {
		...valid,
		assets: valid.assets.map((asset) => (asset.kind === "nsis" ? { ...asset, url: "http://evil.example/x.exe" } : asset)),
	};
	assert.throws(() => parseRelease(insecure, source), /must be https/);
	assert.throws(() => parseRelease(["not", "an", "object"], source), /not an object/);
});

test("a copy that cannot replace itself does not offer updates", () => {
	assert.match(
		installBlocker("darwin", "/Volumes/StepCode 1.2.3/StepCode.app/Contents/MacOS/StepCode") ?? "",
		/disk image/,
	);
	assert.match(
		installBlocker("darwin", "/private/var/folders/x/AppTranslocation/1/d/StepCode.app/Contents/MacOS/StepCode") ?? "",
		/translocated/,
	);
	assert.equal(installBlocker("darwin", "/Applications/StepCode.app/Contents/MacOS/StepCode"), undefined);
	assert.equal(installBlocker("win32", "C:\\Users\\u\\AppData\\Local\\Programs\\StepCode\\StepCode.exe"), undefined);
	assert.match(installBlocker("linux", "/opt/StepCode/stepcode") ?? "", /linux/);
});
