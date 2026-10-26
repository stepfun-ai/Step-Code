import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const { buildChannelManifest, buildLatestYml } = require("./pack-win.cjs");

// The pipeline passes its version as CI_BUILD_APP_VERSION; a tag arrives with a prefix.
const pipelineEnv = { ...process.env, STEPCODE_BUILD_VERSION: "", CI_BUILD_APP_VERSION: "desktop-v9.9.9" };

// `pnpm run <script> -- <args>` forwards the separator itself (npm strips it), so
// every call below goes through a leading `--` exactly as falcon's does.
function dryRun(script, args) {
	const result = spawnSync(process.execPath, [join(repoRoot, "scripts", script), "--", "--dry-run", ...args], {
		cwd: repoRoot,
		encoding: "utf8",
		env: pipelineEnv,
	});
	return { ...result, plan: result.status === 0 ? JSON.parse(result.stdout) : undefined };
}

test("dist:mac packages the architecture falcon asked for", () => {
	const single = dryRun("package-mac-ci.mjs", ["--env=sit", "--arch=arm64", "--fast-build"]);
	assert.equal(single.status, 0, single.stderr);
	assert.equal(single.plan.arch, "arm64");
	assert.equal(single.plan.fastBuild, true);
	assert.equal(single.plan.version, "9.9.9");
	assert.match(single.plan.steps.at(-1), /package\.mjs --mac --arch=arm64$/u);

	// falcon accepts --arch=universal, but universal targets would need per-arch
	// rebuilds; both dmgs are what the app ships, so the value degrades to all.
	const both = dryRun("package-mac-ci.mjs", ["--arch=universal"]);
	assert.equal(both.status, 0, both.stderr);
	assert.equal(both.plan.arch, "all");
	assert.match(both.stderr, /universal is not supported/u);
});

test("dist:mac refuses a value falcon never sends and skips notarization", () => {
	const bad = dryRun("package-mac-ci.mjs", ["--arch=ppc"]);
	assert.notEqual(bad.status, 0);
	assert.match(bad.stderr, /Unsupported --arch=ppc/u);

	const notarize = dryRun("package-mac-ci.mjs", ["--notarize"]);
	assert.equal(notarize.status, 0, notarize.stderr);
	assert.equal(notarize.plan.notarize, false);
	assert.match(notarize.stderr, /--notarize is skipped/u);
});

test("pack:win writes the channel manifest falcon collects from", () => {
	const plan = dryRun("pack-win.cjs", ["--env=sit", "--no-sign"]);
	assert.equal(plan.status, 0, plan.stderr);
	assert.equal(plan.plan.channelId, "web_website_homepage");
	assert.equal(plan.plan.exe, "StepCode-9.9.9-win-x64.exe");
	assert.equal(plan.plan.latestYml, "latest.yml");
	assert.equal(plan.plan.manifest, "channel-artifacts.json");
});

test("pack:win fails instead of shipping an installer Phase 1 cannot sign or publish", () => {
	const sign = dryRun("pack-win.cjs", ["--sign"]);
	assert.notEqual(sign.status, 0);
	assert.match(sign.stderr, /--sign is not available yet/u);

	const multi = dryRun("pack-win.cjs", ["--channels=web_website_homepage,appdist_soft_mgr_360"]);
	assert.notEqual(multi.status, 0);
	assert.match(multi.stderr, /is not available yet/u);
});

test("updater metadata names the installer that was packaged", () => {
	const exeName = "StepCode-1.2.3-win-x64.exe";
	const latestYml = buildLatestYml({
		version: "1.2.3",
		exeName,
		sha512: "abc=",
		size: 42,
		releaseDate: "2026-01-01T00:00:00.000Z",
	});
	// electron-updater resolves `path` relative to the yml: a stale name is a 404.
	assert.match(latestYml, new RegExp(`^path: ${exeName}$`, "mu"));
	assert.match(latestYml, new RegExp(`- url: ${exeName}`, "u"));

	assert.deepEqual(JSON.parse(buildChannelManifest({ channelId: "web_website_homepage", exeName, latestYmlName: "latest.yml" })), {
		channels: [{ channelId: "web_website_homepage", exe: exeName, latestYml: "latest.yml" }],
	});
});

// The Windows jobs cannot run the installer (no Windows machine), so the only
// check available is that the bytes and the updater metadata agree. These cover
// the failures that used to reach a user as a 404 or a corrupt install.
const { verifyWinArtifact } = await import("./verify-win-artifact.mjs");

async function writeFakeInstaller(dir, { exeName, version, corruptYml } = {}) {
	const exe = exeName ?? "StepCode-1.2.3-win-x64.exe";
	const data = Buffer.alloc(10_500_000, 7);
	data.write("MZ", 0, "latin1");
	data.writeUInt32LE(0x80, 0x3c);
	data.write("PE\0\0", 0x80, "latin1");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, exe), data);
	const sha512 = createHash("sha512").update(data).digest("base64");
	const yml = corruptYml ?? `version: ${version ?? "1.2.3"}\npath: ${exe}\nsha512: ${sha512}\nfiles:\n  - url: ${exe}\n    sha512: ${sha512}\n    size: ${data.length}\n`;
	await writeFile(join(dir, "latest.yml"), yml);
	await writeFile(
		join(dir, "channel-artifacts.json"),
		`${JSON.stringify({ channels: [{ channelId: "web_website_homepage", exe, latestYml: "latest.yml" }] }, null, 2)}\n`,
	);
	return { dir, exe, sha512 };
}

test("verify-win-artifact accepts a consistent installer", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-win-verify-"));
	try {
		const { dir } = await writeFakeInstaller(root);
		assert.deepEqual(verifyWinArtifact({ dir }), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("verify-win-artifact rejects a stale or renamed metadata file", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-win-verify-"));
	try {
		const exe = "StepCode-1.2.3-win-x64.exe";
		// Path names the old file, and the version disagrees with the file name.
		const stale = await writeFakeInstaller(join(root, "stale"), {
			exeName: exe,
			corruptYml: "version: 9.9.9\npath: StepCode-9.9.9-win-x64.exe\nsha512: abc=\nfiles:\n  - url: StepCode-9.9.9-win-x64.exe\n",
		});
		const problems = verifyWinArtifact({ dir: stale.dir });
		assert.ok(problems.some((p) => p.includes("path does not name")), problems.join("\n"));
		assert.ok(problems.some((p) => p.includes("files[] names")), problems.join("\n"));
		assert.ok(problems.some((p) => p.includes("latest.yml says 9.9.9")), problems.join("\n"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
