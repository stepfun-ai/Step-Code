#!/usr/bin/env node
// falcon-mobile-pipeline entry point for the Windows installer: `pnpm pack:win`.
//
// catalyst/falcon-mobile-pipeline runs, from scripts/package/windows_build.sh:
//
//   node scripts/pack-win.cjs --env=<sit|prod> --sign|--no-sign [--channels=<ids>]
//
// then collects `dist-electron/StepCode-<version>-win-x64.exe` plus
// `dist-electron/latest.yml` through `dist-electron/channel-artifacts.json`, and
// refuses a channel without updater metadata. So this script builds the
// monorepo, drives apps/desktop/scripts/package.mjs, and writes both files next
// to the installer.
//
//   node scripts/pack-win.cjs --env=sit --no-sign
//
// Phase 1 ships one unsigned channel. Signing (an EV credential plus
// build/tools/win/signing/signtool.exe) and more channels are Phase 2, so
// --sign and a multi-channel --channels fail here instead of producing an
// installer the pipeline cannot sign or publish.

const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const repoRoot = path.join(__dirname, "..");
const desktopRoot = path.join(repoRoot, "apps", "desktop");
const releaseDir = path.join(desktopRoot, "release");
const distDir = path.join(repoRoot, "dist-electron");

/** The official channel: falcon keeps its installer name unprefixed in its own upload. */
const DEFAULT_CHANNEL_ID = "web_website_homepage";
const CHANNEL_MANIFEST_NAME = "channel-artifacts.json";

const options = { env: "sit", sign: false, channels: [], dryRun: false };

// `pnpm run pack:win -- <args>` forwards the separator itself; npm strips it.
for (const arg of process.argv.slice(2)) {
	if (arg === "--") continue;
	if (arg.startsWith("--env=")) options.env = arg.slice("--env=".length);
	else if (arg === "--sign") options.sign = true;
	else if (arg === "--no-sign") options.sign = false;
	else if (arg.startsWith("--channels=")) {
		options.channels = arg
			.slice("--channels=".length)
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean);
	} else if (arg === "--dry-run") options.dryRun = true;
	else throw new Error(`Unknown argument: ${arg}`);
}

if (options.env !== "sit" && options.env !== "prod") {
	throw new Error(`Unsupported --env=${options.env}; expected sit or prod`);
}
if (options.sign) {
	throw new Error(
		"--sign is not available yet: Windows signing needs an EV credential and build/tools/win/signing/signtool.exe (Phase 2). Run with --no-sign (BUILD_PROFILE=fast).",
	);
}
if (options.channels.length > 1) {
	throw new Error(`--channels=${options.channels.join(",")} is not available yet: Phase 1 packages the single official channel`);
}
if (options.channels.length === 1 && options.channels[0] !== DEFAULT_CHANNEL_ID) {
	throw new Error(`Unknown channel ${options.channels[0]}; Phase 1 packages only ${DEFAULT_CHANNEL_ID}`);
}
const channelId = DEFAULT_CHANNEL_ID;

/**
 * The product version, same sources as apps/desktop/scripts/package.mjs: a
 * release tag from the pipeline, else the root package.json version. falcon
 * passes it as CI_BUILD_APP_VERSION; stepcode reads STEPCODE_BUILD_VERSION.
 */
function productVersion() {
	const raw = process.env.STEPCODE_BUILD_VERSION?.trim() || process.env.CI_BUILD_APP_VERSION?.trim();
	if (!raw) return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
	const version = raw
		.replace(/^refs\/tags\//iu, "")
		.replace(/^(?:step|pi|desktop)-v/iu, "")
		.replace(/^v(?=\d)/iu, "");
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
		throw new Error(`Not a semver product version: ${JSON.stringify(raw)}`);
	}
	return version;
}

/** electron-updater's metadata for the official channel: one installer, no zip. */
function buildLatestYml({ version, exeName, sha512, size, releaseDate }) {
	return [
		`version: ${version}`,
		`releaseDate: '${releaseDate}'`,
		`path: ${exeName}`,
		`sha512: ${sha512}`,
		"files:",
		`  - url: ${exeName}`,
		`    sha512: ${sha512}`,
		`    size: ${size}`,
		"",
	].join("\n");
}

/** What falcon reads to find the installer and its updater metadata. */
function buildChannelManifest({ channelId: id, exeName, latestYmlName }) {
	return `${JSON.stringify({ channels: [{ channelId: id, exe: exeName, latestYml: latestYmlName }] }, null, 2)}\n`;
}

// No `--ignore-scripts` anywhere in CI: node-pty and esbuild ship postinstall
// artifacts, and electron-builder needs the electron binary.
const steps = [
	{ label: "build the monorepo", command: "pnpm", args: ["run", "build"] },
	{ label: "package the NSIS installer", command: process.execPath, args: [path.join(desktopRoot, "scripts", "package.mjs"), "--win"] },
];

const version = productVersion();
if (!process.env.STEPCODE_BUILD_VERSION) process.env.STEPCODE_BUILD_VERSION = version;
const exeName = `StepCode-${version}-win-x64.exe`;
const latestYmlName = "latest.yml";

if (options.dryRun) {
	console.log(
		JSON.stringify(
			{
				platform: "windows",
				env: options.env,
				sign: false,
				channelId,
				version,
				exe: exeName,
				latestYml: latestYmlName,
				manifest: CHANNEL_MANIFEST_NAME,
				steps: steps.map((step) => [step.command, ...step.args].join(" ")),
			},
			null,
			2,
		),
	);
	process.exit(0);
}

function main() {
	if (options.env === "prod") {
		console.log("[pack:win] --env=prod has no build-time effect; the app reads its backend from ~/.stepcode at run time");
	}
	for (const step of steps) {
		console.log(`[pack:win] ${step.label}`);
		const result = spawnSync(step.command, step.args, {
			cwd: repoRoot,
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`${step.label} failed with exit code ${result.status}`);
	}

	// apps/desktop/scripts/package.mjs writes apps/desktop/release/<version>/; falcon
	// only reads dist-electron/. Clear it first so an installer from an earlier
	// version cannot be collected into this build.
	rmSync(distDir, { recursive: true, force: true });
	mkdirSync(distDir, { recursive: true });

	const installers = [];
	const versionDirs = readdirSync(releaseDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name !== "stage")
		.map((entry) => path.join(releaseDir, entry.name));
	for (const versionDir of versionDirs) {
		for (const name of readdirSync(versionDir)) {
			if (/\.exe$/iu.test(name)) installers.push(path.join(versionDir, name));
		}
	}
	// One installer per run: picking one of several would silently ship whatever a
	// previous run left behind.
	if (installers.length !== 1) {
		throw new Error(
			`Expected exactly one Windows installer under ${path.relative(repoRoot, releaseDir)}, found ${installers.length}${installers.length > 0 ? `: ${installers.map((installer) => path.basename(installer)).join(", ")}` : ""}`,
		);
	}

	const exePath = path.join(distDir, exeName);
	cpSync(installers[0], exePath);
	const sha512 = crypto.createHash("sha512").update(readFileSync(exePath)).digest("base64");
	const size = statSync(exePath).size;
	writeFileSync(
		path.join(distDir, latestYmlName),
		buildLatestYml({ version, exeName, sha512, size, releaseDate: new Date().toISOString() }),
	);

	// electron-updater resolves `path` relative to the yml, so a yml naming an
	// installer we did not produce is a 404 on the client, not a build failure.
	const latestYml = readFileSync(path.join(distDir, latestYmlName), "utf8");
	if (!latestYml.includes(`path: ${exeName}`)) {
		throw new Error(`${latestYmlName} does not reference ${exeName}`);
	}

	writeFileSync(path.join(distDir, CHANNEL_MANIFEST_NAME), buildChannelManifest({ channelId, exeName, latestYmlName }));
	console.log(`[pack:win] ${path.relative(repoRoot, distDir)}/${exeName} (${channelId}, sha512 ${sha512.slice(0, 16)}…)`);
}

if (require.main === module) main();

module.exports = { buildChannelManifest, buildLatestYml };
