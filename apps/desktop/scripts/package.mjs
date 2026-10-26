#!/usr/bin/env node
// Build StepCode Desktop installers with electron-builder.
//
//   node scripts/package.mjs [--mac] [--win] [--arch=all|arm64|x64]   (default: both platforms, all arches)
//   node scripts/package.mjs --mac --app-only --arch=arm64            signed .app only, no dmg
//   node scripts/package.mjs --from-app=<path> --arch=arm64           dmg + zip from an existing .app
//
//   mac: dmg for arm64 (Apple Silicon) and x64 (Intel), or the one named by --arch
//   win: NSIS installer for x64
//
// The two extra modes exist for the notarization pipeline: it needs a signed
// .app as its input (checkpoint), and it needs the dmg built from the app that
// Apple stapled (finalize), so neither may rebuild or repack the app itself.
//
// Run `pnpm build` at the repo root first: this script packages existing build
// output and fails when any of it is missing.
//
// Layout of the staging directory (release/stage) and of the installed app:
//
//   stage/app      -> <app>/resources/app.asar    desktop main + preload, icon; no dependencies
//   stage/server   -> <app>/resources/server      @step-harness/web and its production dependency
//                                                  closure in a flat node_modules, plus the
//                                                  stepcode-release.json build identity,
//                                                  written beside the resolved server entry
//                                                  (node_modules/@step-harness/web/dist)
//
// The server stays outside the asar archive: it runs with its own directory as
// cwd and spawns helper processes (node-pty, subagents) from real files. The
// closure is copied from the installed pnpm tree, so the packaged app runs the
// exact versions pnpm-lock.yaml pins. Native modules ship N-API prebuilds for
// every platform (node-pty, @step-harness/pi-tui), so one server tree serves
// all targets; nothing is rebuilt.
//
// Signing: with CSC_LINK set (the release pipeline's Developer ID .p12) the mac
// app is signed with hardened runtime and the entitlements in resources/;
// notarization is a separate pipeline stage (.gitlab-ci.desktop-macos-signing.yml
// on the CI branch). Without it, macOS gets an ad-hoc signature so Apple
// Silicon can run the app. With WIN_SIGN=1 (scripts/pack-win.cjs --sign, on the
// Windows packager only) every Windows PE file, the installer and its
// uninstaller are signed with the EV certificate (scripts/win-signer.cjs);
// otherwise Windows executables are not signed.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import builder from "electron-builder";
import winSigner from "./win-signer.cjs";

const { Arch, build, Platform } = builder;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(root, "..", "..");
const webRoot = join(repoRoot, "apps", "web");
const releaseDir = join(root, "release");
const stageDir = join(releaseDir, "stage");
const appStage = join(stageDir, "app");
const serverStage = join(stageDir, "server");
const resources = join(root, "resources");

const desktopPackage = readJson(join(root, "package.json"));
const electronVersion = readJson(join(root, "node_modules", "electron", "package.json")).version;
const version = productVersion();

/** Bounds mirror apps/desktop/src/release-envelope.ts and the kernel's report fields. */
const MAX_COMMIT_LENGTH = 40;
const MAX_ENDPOINT_LENGTH = 2048;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
/** Must match `RELEASE_ENVELOPE_FILE` in apps/desktop/src/release-envelope.ts. */
const RELEASE_ENVELOPE_FILE = "stepcode-release.json";

/**
 * The installer carries the product version users see from `step --version`
 * and the web host, not the workspace package version (`0.84.4`, which tracks
 * the upstream Pi packages). Same sources as `packages/coding-agent/src/step/
 * version.ts`: a release tag in STEPCODE_BUILD_VERSION, else the root
 * package.json version (which matches its STEPCODE_FALLBACK_VERSION). A
 * Desktop release tag (`desktop-vX.Y.Z`, see infra/release/desktop-tag-release.mjs)
 * is accepted too, so CI can pass its tag through unchanged.
 */
function productVersion() {
	const tag = process.env.STEPCODE_BUILD_VERSION?.trim()
		.replace(/^refs\/tags\//iu, "")
		.replace(/^(?:step|pi|desktop)-v/iu, "")
		.replace(/^v(?=\d)/iu, "");
	const value = tag || readJson(join(repoRoot, "package.json")).version;
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)) {
		throw new Error(`Not a semver product version: ${JSON.stringify(value)}`);
	}
	return value;
}

/**
 * Identity the staged server reports as, read by src/release-envelope.ts.
 * Only the built installer carries this file, so feedback endpoints and release
 * metadata never enter the repository. Optional values are dropped when they do
 * not satisfy the same bounds the reader applies.
 */
function releaseEnvelope(installSource) {
	const commitValue = firstEnvironmentValue("STEPCODE_BUILD_COMMIT", "STEP_HARNESS_BUILD_COMMIT");
	const commit = boundedString(commitValue, MAX_COMMIT_LENGTH);
	if (commitValue !== undefined && commit === undefined) {
		console.warn("[package] ignoring invalid STEPCODE_BUILD_COMMIT/STEP_HARNESS_BUILD_COMMIT");
	}
	const feedbackEndpoint = feedbackUrl("STEPCODE_FEEDBACK_ENDPOINT");
	const feedbackBundleEndpoint = feedbackUrl("STEPCODE_FEEDBACK_BUNDLE_ENDPOINT");
	return {
		version,
		channel: "release",
		...(commit === undefined ? {} : { commit }),
		buildTime: new Date().toISOString(),
		installSource,
		...(feedbackEndpoint === undefined ? {} : { feedbackEndpoint }),
		...(feedbackBundleEndpoint === undefined ? {} : { feedbackBundleEndpoint }),
	};
}

/**
 * The directory the desktop resolves as the server entry's own.
 *
 * `resolveWebServerEntry` does `createRequire(<server>/package.json).resolve(
 * "@step-harness/web/server")` and the shell reads the envelope from
 * `dirname(entry)`. Resolving it here the same way keeps the writer and the
 * reader from drifting: an envelope one level up from the entry would simply
 * never be found. `apps/desktop/test/release-envelope.test.ts` pins the layout.
 */
function stagedServerEntryDirectory() {
	return dirname(createRequire(join(serverStage, "package.json")).resolve("@step-harness/web/server"));
}

function writeReleaseEnvelope(installSource) {
	const envelope = releaseEnvelope(installSource);
	const directory = stagedServerEntryDirectory();
	writeFileSync(join(directory, RELEASE_ENVELOPE_FILE), `${JSON.stringify(envelope, null, "\t")}\n`);
	console.log(`[package] release envelope ${version} (${installSource}) staged beside the server entry`);
}

function firstEnvironmentValue(...names) {
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

function boundedString(value, maxLength) {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > maxLength || CONTROL_CHARACTERS.test(trimmed)) return undefined;
	return trimmed;
}

/** http(s) only, with a host and without embedded credentials. */
function feedbackUrl(name) {
	const value = process.env[name];
	const bounded = boundedString(value, MAX_ENDPOINT_LENGTH);
	if (bounded !== undefined) {
		try {
			const url = new URL(bounded);
			const valid =
				(url.protocol === "http:" || url.protocol === "https:") &&
				Boolean(url.hostname) &&
				!url.username &&
				!url.password;
			if (valid) return url.toString();
		} catch {
			// Reported as invalid below.
		}
	}
	if (typeof value === "string" && value.trim() !== "") console.warn(`[package] ignoring invalid ${name}`);
	return undefined;
}

const argv = process.argv.slice(2);
const flag = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const archArg = flag("arch") ?? "all";
// An .app from a notarized checkpoint: package it, do not rebuild anything.
const fromApp = flag("from-app");
const args = new Set(argv.filter((arg) => !arg.startsWith("--arch=") && !arg.startsWith("--from-app=")));
const unknown = [...args].filter((arg) => arg !== "--mac" && arg !== "--win" && arg !== "--app-only");
if (unknown.length > 0) throw new Error(`Unknown arguments: ${unknown.join(" ")}`);
const macArches = { all: [Arch.arm64, Arch.x64], arm64: [Arch.arm64], x64: [Arch.x64] }[archArg];
if (macArches === undefined) throw new Error(`Unknown architecture: ${archArg}`);
const wantMac = args.has("--mac") || args.size === 0;
const wantWin = args.has("--win") || args.size === 0;
const appOnly = args.has("--app-only");
if (appOnly && (fromApp !== undefined || wantWin)) throw new Error("--app-only builds one mac .app; drop --win/--from-app");
if (appOnly && macArches.length !== 1) throw new Error("--app-only needs a single --arch=arm64|x64");
if (fromApp !== undefined && !existsSync(fromApp)) throw new Error(`--from-app does not exist: ${fromApp}`);

// Developer ID appears when the pipeline hands over a certificate (CSC_LINK) or
// names one already in the keychain (CSC_NAME); electron-builder reads both.
// Without either, the build keeps the ad-hoc signature Apple Silicon needs to
// start the app at all.
const signing = Boolean(process.env.CSC_LINK?.trim() || process.env.CSC_NAME?.trim());
const signingIdentity = signing ? undefined : "-";
if (appOnly && !signing) {
	throw new Error("--app-only builds the Developer ID signed app; set CSC_LINK (+ CSC_KEY_PASSWORD) or CSC_NAME");
}

// Windows Authenticode with the EV token; pack-win.cjs sets it only after probing the token.
const winSigning = process.env.WIN_SIGN === "1";
if (winSigning && process.platform !== "win32") {
	throw new Error("WIN_SIGN=1 signs with the EV token, which only the Windows packager has");
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function requireFiles(paths) {
	const missing = paths.filter((path) => !existsSync(path));
	if (missing.length > 0) {
		throw new Error(
			`Build output missing:\n  ${missing.map((path) => relative(repoRoot, path)).join("\n  ")}\nRun \`pnpm build\` at the repo root.`,
		);
	}
}

/** The installed directory of dependency `name` as Node would resolve it from `fromDir`. */
function installedDir(name, fromDir) {
	for (let dir = fromDir; ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", name, "package.json");
		if (existsSync(candidate)) return realpathSync(dirname(candidate));
		if (dirname(dir) === dir) return undefined;
	}
}

/** True for workspace packages (sources in this repo, not in the pnpm store). */
function isWorkspacePackage(dir) {
	return !relative(repoRoot, dir).startsWith("..") && !dir.includes(`${join("node_modules", ".pnpm")}`);
}

/**
 * What a workspace package publishes: package.json, README/LICENSE, and the
 * top-level directories its `files` globs name (dist when it has no `files`).
 */
function copyWorkspacePackage(source, target, manifest) {
	mkdirSync(target, { recursive: true });
	const entries = new Set(["package.json"]);
	for (const name of readdirSync(source)) if (/^(README|LICENSE)/i.test(name)) entries.add(name);
	const patterns = Array.isArray(manifest.files) ? manifest.files : ["dist"];
	for (const pattern of patterns) {
		const fixed = pattern.split("/").filter((segment, index, all) => !all.slice(0, index + 1).some((s) => s.includes("*")));
		if (fixed.length > 0) entries.add(fixed.join("/"));
	}
	// docs and examples are for the package's own consumers; the server this
	// installer ships imports only `dist`. They are also not signing-safe: signing
	// walks the bundle and dies on an example's WebAssembly ("codesign ... doom.wasm").
	const notRuntime = new Set(["docs", "examples"]);
	for (const entry of entries) {
		if (notRuntime.has(entry)) continue;
		const from = join(source, entry);
		// Nested node_modules (e.g. examples' own installs) are links into this checkout, not published files.
		if (existsSync(from)) {
			cpSync(from, join(target, entry), { recursive: true, filter: (path) => !/[\\/]node_modules$/.test(path) });
		}
	}
}

/**
 * Copy the production dependency closure of `rootDir` into `stage/node_modules`,
 * npm style: each package at the top level unless another version already
 * holds that name there, then nested under the package that needs it.
 * Optional dependencies that are not installed (other platforms) are skipped.
 */
function stageClosure(rootDir, stage) {
	const placed = new Map(); // stage path -> source realpath
	let copied = 0;

	const resolvesTo = (name, fromStageDir) => {
		for (let dir = fromStageDir; relative(stage, dir).startsWith("..") === false; dir = dirname(dir)) {
			const candidate = join(dir, "node_modules", name);
			if (placed.has(candidate)) return placed.get(candidate);
			if (dir === stage) break;
		}
		return undefined;
	};

	const visit = (source, stageDir) => {
		const manifest = readJson(join(source, "package.json"));
		const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies };
		for (const name of Object.keys(dependencies)) {
			const dependency = installedDir(name, source);
			if (dependency === undefined) {
				if (manifest.optionalDependencies?.[name] !== undefined) continue;
				throw new Error(`${manifest.name} depends on ${name}, which is not installed`);
			}
			const current = resolvesTo(name, stageDir);
			if (current === dependency) continue;
			const top = join(stage, "node_modules", name);
			const target = current === undefined && !placed.has(top) ? top : join(stageDir, "node_modules", name);
			placed.set(target, dependency);
			const dependencyManifest = readJson(join(dependency, "package.json"));
			if (isWorkspacePackage(dependency)) copyWorkspacePackage(dependency, target, dependencyManifest);
			else cpSync(dependency, target, { recursive: true });
			copied += 1;
			visit(dependency, target);
		}
	};

	const rootManifest = readJson(join(rootDir, "package.json"));
	const rootTarget = join(stage, "node_modules", rootManifest.name);
	placed.set(rootTarget, rootDir);
	copyWorkspacePackage(rootDir, rootTarget, rootManifest);
	visit(rootDir, rootTarget);
	return copied + 1;
}

function stage() {
	requireFiles([
		join(root, "dist", "main.js"),
		join(root, "dist", "preload.cjs"),
		join(resources, "icon.png"),
		join(resources, "icon.icns"),
		join(resources, "icon.ico"),
		join(webRoot, "dist", "server.js"),
		join(webRoot, "dist", "public", "index.html"),
		join(repoRoot, "packages", "coding-agent", "dist", "bundle", "step.js"),
	]);
	rmSync(stageDir, { recursive: true, force: true });

	mkdirSync(appStage, { recursive: true });
	cpSync(join(root, "dist"), join(appStage, "dist"), {
		recursive: true,
		filter: (source) => !source.endsWith(".map"),
	});
	cpSync(join(resources, "icon.png"), join(appStage, "resources", "icon.png"));
	writeFileSync(
		join(appStage, "package.json"),
		`${JSON.stringify(
			{
				name: "stepcode-desktop",
				productName: "StepCode",
				description: desktopPackage.description,
				version,
				private: true,
				type: "module",
				main: "dist/main.js",
				author: "StepFun",
			},
			null,
			"\t",
		)}\n`,
	);

	mkdirSync(serverStage, { recursive: true });
	writeFileSync(join(serverStage, "package.json"), `${JSON.stringify({ private: true, type: "module" }, null, "\t")}\n`);
	const count = stageClosure(webRoot, serverStage);
	console.log(`[package] staged desktop app and server (${count} packages) in ${relative(repoRoot, stageDir)}`);
}

// A fresh object per build: electron-builder normalizes (mutates) the configuration it is given.
const config = () => ({
	appId: "com.stepfun.stepcode",
	productName: "StepCode",
	copyright: `Copyright © ${new Date().getFullYear()} StepFun`,
	electronVersion,
	directories: { app: appStage, output: join(releaseDir, version), buildResources: resources },
	artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
	asar: true,
	npmRebuild: false,
	nodeGypRebuild: false,
	buildDependenciesFromSource: false,
	// The app archive holds only the shell; the server tree is copied by afterPack.
	files: ["**/*", "!**/node_modules{,/**}"],
	// Not extraResources: its copier drops node_modules directories.
	afterPack: async (context) => {
		const resourcesDir =
			context.electronPlatformName === "darwin"
				? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
				: join(context.appOutDir, "resources");
		const target = join(resourcesDir, "server");
		rmSync(target, { recursive: true, force: true });
		cpSync(serverStage, target, { recursive: true, verbatimSymlinks: true });
		// electron-builder signs the app's own executables after this hook, but not
		// this tree (node-pty's helpers, native addons): sign those here.
		if (winSigning && context.electronPlatformName === "win32") winSigner.signTree(target);
	},
	mac: {
		icon: join(resources, "icon.icns"),
		category: "public.app-category.developer-tools",
		// identity undefined = electron-builder discovers the Developer ID from the
		// certificate the pipeline imported; "-" is the ad-hoc signature.
		identity: signingIdentity,
		hardenedRuntime: signing,
		...(signing && {
			entitlements: join(resources, "entitlements.mac.plist"),
			entitlementsInherit: join(resources, "entitlements.mac.inherit.plist"),
		}),
		// Notarization belongs to the pipeline (falcon macos-signing), which submits
		// the signed app and staples the ticket into the app this script rebuilt.
		notarize: false,
	},
	dmg: { title: "StepCode ${version}" },
	win: {
		icon: join(resources, "icon.ico"),
		signAndEditExecutable: true,
		...(winSigning && {
			// Every PE electron-builder signs (StepCode.exe, its helpers, the installer
			// and uninstaller) goes through the EV token; SHA-256 only (Windows 10+).
			signtoolOptions: { sign: winSigner.electronBuilderSign, signingHashAlgorithms: ["sha256"] },
			signExts: [".dll", ".node"],
		}),
	},
	nsis: {
		oneClick: false,
		perMachine: false,
		allowToChangeInstallationDirectory: true,
		createDesktopShortcut: true,
		createStartMenuShortcut: true,
		shortcutName: "StepCode",
		installerIcon: join(resources, "icon.ico"),
		uninstallerIcon: join(resources, "icon.ico"),
	},
});

const artifacts = [];
if (fromApp !== undefined) {
	// The app is already signed (and notarized, possibly stapled); electron-builder
	// here only writes the dmg/zip around it. No staging, no rebuild.
	const outDir = join(releaseDir, version);
	artifacts.push(
		...(await build({
			prepackaged: fromApp,
			config: { ...config(), directories: { output: outDir }, extraMetadata: { version } },
			targets: Platform.MAC.createTarget(["dmg", "zip"], ...macArches),
			publish: "never",
		})),
	);
	const summary = artifacts.length > 0 ? artifacts : [join(releaseDir, version)];
console.log(`[package] artifacts:\n  ${summary.map((path) => relative(repoRoot, path)).join("\n  ")}`);
	process.exit(0);
}

stage();
if (wantMac) {
	// Both mac architectures share the dmg install source. Rewritten before each
	// target because afterPack copies one shared server stage into every app.
	writeReleaseEnvelope("dmg");
	artifacts.push(
		...(await build({
			projectDir: appStage,
			config: config(),
			targets: Platform.MAC.createTarget([appOnly ? "dir" : "dmg"], ...macArches),
			publish: "never",
		})),
	);
}
if (wantWin) {
	writeReleaseEnvelope("nsis");
	artifacts.push(
		...(await build({ projectDir: appStage, config: config(), targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64), publish: "never" })),
	);
}
const summary = artifacts.length > 0 ? artifacts : [join(releaseDir, version)];
console.log(`[package] artifacts:\n  ${summary.map((path) => relative(repoRoot, path)).join("\n  ")}`);
