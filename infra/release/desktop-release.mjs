#!/usr/bin/env node

/**
 * Stage the StepCode Desktop installers as a versioned release and, with
 * --upload, publish it to TOS.
 *
 * Input: the electron-builder output of `apps/desktop/scripts/package.mjs`
 * (`apps/desktop/release/<version>/`). Installers do not embed any download
 * URL, so the same bytes go to every environment; only manifest.json and
 * latest.json carry the environment's base URL.
 *
 * Layout under --out (default dist/release) and in the bucket under
 * STEP_TOS_PREFIX (default stepcode):
 *
 *   desktop/<version>/StepCode-<version>-mac-arm64.dmg   immutable, first install
 *   desktop/<version>/StepCode-<version>-mac-x64.dmg     immutable, first install
 *   desktop/<version>/StepCode-<version>-mac-arm64.zip   immutable, in-app update payload (Squirrel.Mac)
 *   desktop/<version>/StepCode-<version>-mac-x64.zip     immutable, in-app update payload (Squirrel.Mac)
 *   desktop/<version>/StepCode-<version>-win-x64.exe     immutable, first install and in-app update
 *   desktop/<version>/SHA256SUMS                         immutable
 *   desktop/<version>/manifest.json                      immutable record of the release
 *   desktop/latest.json                                  the channel; a copy of the manifest
 *
 * Uploads run in that order, so latest.json never names a file that is not in
 * the bucket yet. latest.json is also the in-app update channel the packaged
 * app reads (apps/desktop/src/update-feed.ts): every asset carries the base64
 * SHA-512 electron-updater verifies, besides the hex SHA-256 of SHA256SUMS.
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TosClient } from "@volcengine/tos-sdk";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const DESKTOP_TARGETS = [
	{ platform: "darwin", arch: "arm64", kind: "dmg", suffix: "mac-arm64.dmg" },
	{ platform: "darwin", arch: "x64", kind: "dmg", suffix: "mac-x64.dmg" },
	{ platform: "darwin", arch: "arm64", kind: "zip", suffix: "mac-arm64.zip" },
	{ platform: "darwin", arch: "x64", kind: "zip", suffix: "mac-x64.zip" },
	{ platform: "win32", arch: "x64", kind: "nsis", suffix: "win-x64.exe" },
];

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const POINTER_CACHE = "no-cache, max-age=0";

/** `desktop-v1.2.3`, `v1.2.3` and `1.2.3` all name 1.2.3. */
export function normalizeDesktopVersion(input) {
	const value = String(input ?? "")
		.trim()
		.replace(/^refs\/tags\//u, "")
		.replace(/^desktop-v/u, "")
		.replace(/^v(?=\d)/u, "");
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)) {
		throw new Error(`not a semver Desktop version: ${JSON.stringify(input)}`);
	}
	return value;
}

export function installerFileName(version, target) {
	return `StepCode-${version}-${target.suffix}`;
}

function joinUrl(...parts) {
	return parts
		.map((part, index) => (index === 0 ? String(part).replace(/\/+$/u, "") : String(part).replace(/^\/+|\/+$/gu, "")))
		.filter(Boolean)
		.join("/");
}

/** The release record written to desktop/<v>/manifest.json and copied to desktop/latest.json. */
export function buildDesktopManifest({ version, baseUrl, assets, commit, publishedAt }) {
	return {
		product: "stepcode-desktop",
		version,
		commit: commit ?? null,
		publishedAt,
		assets: assets.map((asset) => ({
			platform: asset.platform,
			arch: asset.arch,
			kind: asset.kind,
			fileName: asset.fileName,
			url: joinUrl(baseUrl, "desktop", version, asset.fileName),
			size: asset.size,
			sha256: asset.sha256,
			sha512: asset.sha512,
		})),
	};
}

/** Ordered upload list: versioned objects first, the channel pointer last. */
export function desktopUploadPlan({ outDir, version, assets }) {
	const versionDir = path.join(outDir, "desktop", version);
	const immutable = (fileName) => ({
		localPath: path.join(versionDir, fileName),
		remoteKey: joinUrl("desktop", version, fileName),
		cacheControl: IMMUTABLE_CACHE,
	});
	return [
		...assets.map((asset) => immutable(asset.fileName)),
		immutable("SHA256SUMS"),
		immutable("manifest.json"),
		{ localPath: path.join(outDir, "desktop", "latest.json"), remoteKey: "desktop/latest.json", cacheControl: POINTER_CACHE },
	];
}

function contentType(fileName) {
	if (fileName.endsWith(".json")) return "application/json; charset=utf-8";
	if (fileName.endsWith("SHA256SUMS")) return "text/plain; charset=utf-8";
	if (fileName.endsWith(".dmg")) return "application/x-apple-diskimage";
	if (fileName.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
	if (fileName.endsWith(".zip")) return "application/zip";
	return "application/octet-stream";
}

/** Hex SHA-256 (SHA256SUMS) and base64 SHA-512 (electron-updater) in one read. */
async function digests(filePath) {
	const bytes = await readFile(filePath);
	return {
		sha256: createHash("sha256").update(bytes).digest("hex"),
		sha512: createHash("sha512").update(bytes).digest("base64"),
	};
}

/** Copy every installer into desktop/<v>/ and write SHA256SUMS, manifest.json and latest.json. */
export async function stageDesktopRelease({ version, baseUrl, inputDir, outDir, commit, publishedAt }) {
	const versionDir = path.join(outDir, "desktop", version);
	await mkdir(versionDir, { recursive: true });
	const assets = [];
	const missing = [];
	for (const target of DESKTOP_TARGETS) {
		const fileName = installerFileName(version, target);
		const source = path.join(inputDir, fileName);
		const info = await stat(source).catch(() => undefined);
		if (!info?.isFile()) {
			missing.push(fileName);
			continue;
		}
		const destination = path.join(versionDir, fileName);
		await copyFile(source, destination);
		assets.push({ ...target, fileName, size: info.size, ...(await digests(destination)) });
	}
	if (missing.length > 0) {
		throw new Error(`installers missing in ${path.relative(repoRoot, inputDir) || inputDir}: ${missing.join(", ")}`);
	}
	await writeFile(path.join(versionDir, "SHA256SUMS"), assets.map((a) => `${a.sha256}  ${a.fileName}\n`).join(""));
	const manifest = `${JSON.stringify(buildDesktopManifest({ version, baseUrl, assets, commit, publishedAt }), null, 2)}\n`;
	await writeFile(path.join(versionDir, "manifest.json"), manifest);
	await writeFile(path.join(outDir, "desktop", "latest.json"), manifest);
	return { assets, files: desktopUploadPlan({ outDir, version, assets }) };
}

function requiredEnv(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required for release upload`);
	return value;
}

/** TOS destination; credentials come only from the environment (masked CI variables). */
function readUploadConfig() {
	return {
		endpoint: requiredEnv("STEP_TOS_ENDPOINT"),
		region: requiredEnv("STEP_TOS_REGION"),
		bucket: requiredEnv("STEP_TOS_BUCKET"),
		accessKeyId: requiredEnv("STEP_TOS_ACCESS_KEY"),
		accessKeySecret: requiredEnv("STEP_TOS_SECRET_KEY"),
		prefix: process.env.STEP_TOS_PREFIX ?? "stepcode",
	};
}

/** Sequential, in plan order: the order is what keeps the pointer safe. */
async function uploadFiles(files, config) {
	const client = new TosClient({
		endpoint: config.endpoint,
		region: config.region,
		accessKeyId: config.accessKeyId,
		accessKeySecret: config.accessKeySecret,
	});
	for (const file of files) {
		const key = joinUrl(config.prefix, file.remoteKey);
		process.stdout.write(`[upload] ${path.relative(repoRoot, file.localPath)} -> tos://${config.bucket}/${key}\n`);
		await client.putObjectFromFile({
			bucket: config.bucket,
			key,
			filePath: file.localPath,
			contentType: contentType(file.localPath),
			cacheControl: file.cacheControl,
		});
	}
}

function parseArgs(argv) {
	const result = new Map();
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token.startsWith("--")) continue;
		const [key, inline] = token.slice(2).split("=", 2);
		if (inline !== undefined) result.set(key, inline);
		else if (argv[index + 1] && !argv[index + 1].startsWith("--")) result.set(key, argv[++index]);
		else result.set(key, true);
	}
	return result;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const baseUrl = args.get("base-url");
	if (args.has("help") || !args.get("version") || typeof baseUrl !== "string") {
		process.stdout.write(
			"Usage: node infra/release/desktop-release.mjs --version <desktop-vX.Y.Z|X.Y.Z> --base-url <url> [--input <dir>] [--out <dir>] [--upload]\n" +
				"  --input   electron-builder output (default apps/desktop/release/<version>)\n" +
				"  --out     release root (default dist/release); writes desktop/<version>/ and desktop/latest.json\n" +
				"  --upload  Upload to TOS (STEP_TOS_ENDPOINT/REGION/BUCKET/ACCESS_KEY/SECRET_KEY[/PREFIX])\n",
		);
		if (!args.has("help")) process.exitCode = 1;
		return;
	}
	const version = normalizeDesktopVersion(args.get("version"));
	const uploadConfig = args.has("upload") ? readUploadConfig() : undefined;
	const inputDir = path.resolve(String(args.get("input") ?? path.join(repoRoot, "apps", "desktop", "release", version)));
	const outDir = path.resolve(String(args.get("out") ?? path.join(repoRoot, "dist", "release")));
	const { files } = await stageDesktopRelease({
		version,
		baseUrl,
		inputDir,
		outDir,
		commit: process.env.CI_COMMIT_SHA?.trim() || undefined,
		publishedAt: new Date().toISOString(),
	});
	for (const file of files) process.stdout.write(`[stage] ${path.relative(repoRoot, file.localPath)}\n`);
	if (uploadConfig) await uploadFiles(files, uploadConfig);
	process.stdout.write(
		`StepCode Desktop ${version}: ${joinUrl(baseUrl, "desktop", "latest.json")}${uploadConfig ? " (uploaded)" : " (staged only)"}\n`,
	);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
