import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { computeNextDesktopTag, parseDesktopReleaseTag } from "../infra/release/desktop-next-version.mjs";
import { desktopDotenv, pushDesktopTag, tokenRemoteUrl } from "../infra/release/desktop-tag-release.mjs";
import {
	DESKTOP_TARGETS,
	installerFileName,
	normalizeDesktopVersion,
	stageDesktopRelease,
} from "../infra/release/desktop-release.mjs";

test("desktop tags: first release, bumps, unrelated tags ignored", () => {
	assert.deepEqual(computeNextDesktopTag({ tags: ["v0.3.1", "web-v1.0.0"], bump: "minor" }), {
		latestTag: null,
		nextTag: "desktop-v0.1.0",
	});
	const tags = ["desktop-v0.1.0", "desktop-v0.10.2", "desktop-v0.9.9", "desktop-v1.0.0-rc.1", "v9.9.9"];
	assert.equal(computeNextDesktopTag({ tags, bump: "patch" }).nextTag, "desktop-v0.10.3");
	assert.equal(computeNextDesktopTag({ tags, bump: "minor" }).nextTag, "desktop-v0.11.0");
	assert.equal(computeNextDesktopTag({ tags, bump: "major" }).nextTag, "desktop-v1.0.0");
	assert.equal(parseDesktopReleaseTag("web-v1.0.0"), null);
	assert.throws(() => computeNextDesktopTag({ tags, bump: "none" }), /unsupported bump/);
});

test("desktop version: tag forms normalize, junk is rejected", () => {
	assert.equal(normalizeDesktopVersion("desktop-v1.2.3"), "1.2.3");
	assert.equal(normalizeDesktopVersion("refs/tags/desktop-v1.2.3"), "1.2.3");
	assert.equal(normalizeDesktopVersion("v1.2.3"), "1.2.3");
	assert.equal(normalizeDesktopVersion("1.2.3-rc.1"), "1.2.3-rc.1");
	assert.throws(() => normalizeDesktopVersion("web-v1.2.3"), /not a semver/);
});

test("desktop release: staged layout, manifest and pointer-last upload order", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "desktop-release-"));
	try {
		const inputDir = path.join(root, "in");
		const outDir = path.join(root, "out");
		await mkdir(inputDir);
		for (const target of DESKTOP_TARGETS) {
			await writeFile(path.join(inputDir, installerFileName("1.2.3", target)), target.suffix);
		}
		const { files } = await stageDesktopRelease({
			version: "1.2.3",
			baseUrl: "https://release.example.test/stepcode/",
			inputDir,
			outDir,
			commit: "abc123",
			publishedAt: "2026-01-01T00:00:00.000Z",
		});
		assert.deepEqual(
			files.map((file) => file.remoteKey),
			[
				"desktop/1.2.3/StepCode-1.2.3-mac-arm64.dmg",
				"desktop/1.2.3/StepCode-1.2.3-mac-x64.dmg",
				"desktop/1.2.3/StepCode-1.2.3-mac-arm64.zip",
				"desktop/1.2.3/StepCode-1.2.3-mac-x64.zip",
				"desktop/1.2.3/StepCode-1.2.3-win-x64.exe",
				"desktop/1.2.3/SHA256SUMS",
				"desktop/1.2.3/manifest.json",
				"desktop/latest.json",
			],
		);
		assert.match(files.at(-1).cacheControl, /no-cache/);
		assert.match(files[0].cacheControl, /immutable/);
		const manifest = JSON.parse(await readFile(path.join(outDir, "desktop", "1.2.3", "manifest.json"), "utf8"));
		assert.equal(manifest.version, "1.2.3");
		assert.equal(manifest.commit, "abc123");
		assert.equal(
			manifest.assets[4].url,
			"https://release.example.test/stepcode/desktop/1.2.3/StepCode-1.2.3-win-x64.exe",
		);
		assert.match(manifest.assets[0].sha256, /^[a-f0-9]{64}$/);
		// electron-updater verifies the base64 SHA-512 of the payload it downloads.
		assert.equal(
			manifest.assets[4].sha512,
			createHash("sha512").update("win-x64.exe").digest("base64"),
		);
		assert.deepEqual(
			manifest.assets.map((asset) => `${asset.platform}/${asset.arch}/${asset.kind}`),
			["darwin/arm64/dmg", "darwin/x64/dmg", "darwin/arm64/zip", "darwin/x64/zip", "win32/x64/nsis"],
		);
		assert.equal(
			await readFile(path.join(outDir, "desktop", "latest.json"), "utf8"),
			await readFile(path.join(outDir, "desktop", "1.2.3", "manifest.json"), "utf8"),
		);
		const sums = await readFile(path.join(outDir, "desktop", "1.2.3", "SHA256SUMS"), "utf8");
		assert.equal(sums.trim().split("\n").length, 5);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("desktop release: a missing installer fails the release", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "desktop-release-"));
	try {
		const inputDir = path.join(root, "in");
		await mkdir(inputDir);
		await writeFile(path.join(inputDir, installerFileName("1.2.3", DESKTOP_TARGETS[0])), "x");
		await assert.rejects(
			stageDesktopRelease({
				version: "1.2.3",
				baseUrl: "https://release.example.test/stepcode",
				inputDir,
				outDir: path.join(root, "out"),
				publishedAt: "2026-01-01T00:00:00.000Z",
			}),
			/StepCode-1\.2\.3-mac-x64\.dmg, StepCode-1\.2\.3-mac-arm64\.zip, StepCode-1\.2\.3-mac-x64\.zip, StepCode-1\.2\.3-win-x64\.exe/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("desktop tag push: ci.skip, commit to tag ref, token redacted on failure", () => {
	const calls = [];
	const ok = (command, args) => {
		calls.push([command, ...args]);
		return { status: 0, stdout: "", stderr: "" };
	};
	const remoteUrl = tokenRemoteUrl({ serverUrl: "https://git.example.test/", projectPath: "group/repo", token: "s3cret" });
	assert.equal(remoteUrl, "https://release-tagger:s3cret@git.example.test/group/repo.git");
	pushDesktopTag({ remoteUrl, token: "s3cret", tag: "desktop-v0.1.1", commit: "abc123", run: ok });
	assert.deepEqual(calls, [
		["git", "push", "--porcelain", "-o", "ci.skip", remoteUrl, "abc123:refs/tags/desktop-v0.1.1"],
	]);
	const denied = () => ({ status: 1, stdout: "", stderr: `remote: denied for ${remoteUrl}` });
	assert.throws(
		() => pushDesktopTag({ remoteUrl, token: "s3cret", tag: "desktop-v0.1.1", commit: "abc123", run: denied }),
		(error) => !error.message.includes("s3cret") && error.message.includes("***"),
	);
	assert.equal(desktopDotenv("desktop-v1.2.3"), "DESKTOP_TAG=desktop-v1.2.3\nDESKTOP_VERSION=1.2.3\n");
});
