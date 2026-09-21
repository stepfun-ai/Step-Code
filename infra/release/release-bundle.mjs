#!/usr/bin/env node

/** Build and optionally publish the versioned StepCode binary bundle. */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TARGETS = [
	{ id: "darwin-arm64", archiveType: "tar.gz" },
	{ id: "darwin-x64", archiveType: "tar.gz" },
	{ id: "linux-arm64", archiveType: "tar.gz" },
	{ id: "linux-x64", archiveType: "tar.gz" },
	{ id: "windows-arm64", archiveType: "zip" },
	{ id: "windows-x64", archiveType: "zip" },
];

export function normalizeReleaseVersion(value) {
	const normalized = String(value ?? "").trim().replace(/^refs\/tags\//iu, "").replace(/^v/iu, "");
	if (!/^\d+\.\d+\.\d+$/u.test(normalized)) throw new Error(`Invalid release version: ${value}`);
	return normalized;
}

export function archiveName(version, target) {
	return `step-${version}-${target.id}.${target.archiveType}`;
}

export function createReleaseManifest({ version, baseUrl, artifacts, generatedAt = new Date().toISOString() }) {
	const root = String(baseUrl).replace(/\/+$/u, "");
	return {
		version,
		generatedAt,
		packages: Object.fromEntries(
			artifacts.map((artifact) => [artifact.id, `${root}/${version}/${artifact.fileName}`]),
		),
		checksums: Object.fromEntries(artifacts.map((artifact) => [artifact.id, artifact.sha256])),
	};
}

export function renderInstallTemplate(template, baseUrl) {
	return template.replaceAll("__STEP_RELEASE_BASE_URL__", String(baseUrl).replace(/\/+$/u, ""));
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

async function run(command, args, options = {}) {
	const result = await execFileAsync(command, args, {
		cwd: options.cwd ?? repoRoot,
		env: { ...process.env, ...(options.env ?? {}) },
		maxBuffer: 32 * 1024 * 1024,
	});
	return result.stdout;
}

async function sha256(filePath) {
	const digest = createHash("sha256");
	digest.update(await readFile(filePath));
	return digest.digest("hex");
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.has("help")) {
		process.stdout.write("Usage: node infra/release/release-bundle.mjs --version <vX.Y.Z> --base-url <url> [--dry-run]\n");
		return;
	}
	const version = normalizeReleaseVersion(args.get("version") ?? process.env.CI_COMMIT_TAG ?? process.env.RELEASE_BUNDLE_VERSION);
	const baseUrl = String(args.get("base-url") ?? process.env.STEP_RELEASE_BASE_URL ?? "https://release.example.test/stepcode").replace(/\/+$/u, "");
	const dryRun = args.has("dry-run");
	const releaseDir = path.join(repoRoot, "dist", "release");
	if (dryRun) {
		for (const target of TARGETS) process.stdout.write(`${target.id}: ${archiveName(version, target)}\n`);
		return;
	}

	await rm(releaseDir, { recursive: true, force: true });
	await mkdir(releaseDir, { recursive: true });
	const buildDir = await mkdtemp(path.join(os.tmpdir(), "stepcode-release-build-"));
	try {
		await run("bash", ["scripts/build-binaries.sh", "--product", "step", "--offline-model-data", "--out", buildDir], {
			env: {
				STEPCODE_BUILD_VERSION: version,
				STEPCODE_BUILD_CHANNEL: "release",
				STEPCODE_BUILD_COMMIT: process.env.CI_COMMIT_SHORT_SHA ?? "",
			},
		});
		const versionDir = path.join(releaseDir, version);
		await mkdir(versionDir, { recursive: true });
		const artifacts = [];
		for (const target of TARGETS) {
			const sourceName = `step-${target.id}.${target.archiveType}`;
			const sourcePath = path.join(buildDir, sourceName);
			const fileName = archiveName(version, target);
			const destination = path.join(versionDir, fileName);
			await cp(sourcePath, destination);
			artifacts.push({ id: target.id, fileName, sha256: await sha256(destination) });
		}
		const checksumsPath = path.join(versionDir, "SHA256SUMS");
		await writeFile(checksumsPath, `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.fileName}`).join("\n")}\n`);
		const manifest = createReleaseManifest({ version, baseUrl, artifacts });
		const manifestPath = path.join(versionDir, "manifest.json");
		const latestPath = path.join(releaseDir, "latest.json");
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		await writeFile(latestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		for (const scriptName of ["install.sh", "install.ps1"]) {
			const template = await readFile(path.join(repoRoot, "infra", "release", scriptName), "utf8");
			await writeFile(path.join(releaseDir, scriptName), renderInstallTemplate(template, baseUrl), {
				mode: scriptName.endsWith(".sh") ? 0o755 : 0o644,
			});
		}

		process.stdout.write(`StepCode ${version} bundle ready at ${releaseDir}\n`);
	} finally {
		await rm(buildDir, { recursive: true, force: true });
	}
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
