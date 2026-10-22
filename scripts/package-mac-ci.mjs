#!/usr/bin/env node
// falcon-mobile-pipeline entry point for the macOS installers: `pnpm dist:mac`.
//
// catalyst/falcon-mobile-pipeline runs, from scripts/package/electron_build.sh:
//
//   npm run dist:mac -- --env=<sit|prod> --arch=<all|universal|arm64|x64> [--fast-build] [--notarize]
//
// and then collects `*.dmg` / `*.zip` from `<repo>/dist-electron/`, reading the
// architecture off the file name (`-arm64` / `-x64`). This script builds the
// monorepo, drives apps/desktop/scripts/package.mjs (which owns the staging and
// electron-builder configuration), and copies its output to `dist-electron/`,
// where falcon looks.
//
//   node scripts/package-mac-ci.mjs --env=sit --arch=arm64 --fast-build
//
// The installers are unsigned (macOS gets an ad-hoc signature); `--notarize` is
// accepted and skipped until Phase 2 adds a Developer ID.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(repoRoot, "apps", "desktop");
const releaseDir = join(desktopRoot, "release");
const distDir = join(repoRoot, "dist-electron");

const options = { env: "sit", arch: "all", fastBuild: false, notarize: false, dryRun: false };

// `pnpm run dist:mac -- <args>` forwards the separator itself; npm strips it.
for (const arg of process.argv.slice(2)) {
	if (arg === "--") continue;
	if (arg.startsWith("--env=")) options.env = arg.slice("--env=".length);
	else if (arg.startsWith("--arch=")) options.arch = arg.slice("--arch=".length);
	else if (arg === "--fast-build") options.fastBuild = true;
	else if (arg === "--notarize") options.notarize = true;
	else if (arg === "--dry-run") options.dryRun = true;
	else throw new Error(`Unknown argument: ${arg}`);
}

if (options.env !== "sit" && options.env !== "prod") {
	throw new Error(`Unsupported --env=${options.env}; expected sit or prod`);
}
// electron-builder's universal target needs @electron/universal and per-arch
// rebuilds; two single-arch dmgs are what the app ships. falcon takes any
// `--arch` value but only all/universal/arm64/x64 reach here.
if (options.arch === "universal") {
	console.warn("[dist:mac] --arch=universal is not supported; building arm64 + x64 dmgs instead");
	options.arch = "all";
}
if (!["all", "arm64", "x64"].includes(options.arch)) {
	throw new Error(`Unsupported --arch=${options.arch}; expected all, universal, arm64, or x64`);
}
if (options.notarize) {
	console.warn("[dist:mac] --notarize is skipped: the build is unsigned (Phase 2 adds a Developer ID)");
}
if (options.env !== "sit") {
	console.log(`[dist:mac] --env=${options.env} has no build-time effect; the app reads its backend from ~/.stepcode at run time`);
}

/**
 * The product version, same sources as apps/desktop/scripts/package.mjs: a
 * release tag from the pipeline, else the root package.json version. falcon
 * passes it as CI_BUILD_APP_VERSION; stepcode reads STEPCODE_BUILD_VERSION.
 */
function productVersion() {
	const raw = process.env.STEPCODE_BUILD_VERSION?.trim() || process.env.CI_BUILD_APP_VERSION?.trim();
	if (!raw) return undefined;
	const version = raw
		.replace(/^refs\/tags\//iu, "")
		.replace(/^(?:step|pi|desktop)-v/iu, "")
		.replace(/^v(?=\d)/iu, "");
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
		throw new Error(`Not a semver product version: ${JSON.stringify(raw)}`);
	}
	return version;
}

const version = productVersion();
if (version !== undefined && !process.env.STEPCODE_BUILD_VERSION) process.env.STEPCODE_BUILD_VERSION = version;

// No `--ignore-scripts` anywhere in CI: node-pty and esbuild ship postinstall
// artifacts, and electron-builder needs the electron binary.
const steps = [
	{ label: "build the monorepo", command: "pnpm", args: ["run", "build"] },
	{ label: "package macOS dmgs", command: process.execPath, args: [join(desktopRoot, "scripts", "package.mjs"), "--mac", `--arch=${options.arch}`] },
];

if (options.dryRun) {
	console.log(
		JSON.stringify(
			{
				platform: "macos",
				env: options.env,
				arch: options.arch,
				fastBuild: options.fastBuild,
				notarize: false,
				version,
				distDir: relative(repoRoot, distDir),
				steps: steps.map((step) => [step.command, ...step.args].join(" ")),
			},
			null,
			2,
		),
	);
	process.exit(0);
}

// apps/desktop/scripts/package.mjs writes into release/<version>/ and never
// removes a previous version's directory, so a warm workspace would otherwise
// hand falcon a stale dmg of another version or architecture.
rmSync(releaseDir, { recursive: true, force: true });

for (const step of steps) {
	console.log(`[dist:mac] ${step.label}`);
	const result = spawnSync(step.command, step.args, {
		cwd: repoRoot,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${step.label} failed with exit code ${result.status}`);
}

// apps/desktop/scripts/package.mjs writes apps/desktop/release/<version>/; falcon
// only reads dist-electron/. Clear it first so a stale dmg of another
// architecture cannot be collected into this build.
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const copied = [];
for (const entry of readdirSync(releaseDir, { withFileTypes: true })) {
	if (!entry.isDirectory() || entry.name === "stage") continue;
	const versionDir = join(releaseDir, entry.name);
	for (const name of readdirSync(versionDir)) {
		if (!/\.(?:dmg|zip)$/iu.test(name)) continue;
		cpSync(join(versionDir, name), join(distDir, name));
		copied.push(name);
	}
}
if (!copied.some((name) => name.toLowerCase().endsWith(".dmg"))) {
	throw new Error(`No .dmg produced under ${relative(repoRoot, releaseDir)}`);
}
console.log(`[dist:mac] ${relative(repoRoot, distDir)}/${copied.sort().join(` ${relative(repoRoot, distDir)}/`)}`);
