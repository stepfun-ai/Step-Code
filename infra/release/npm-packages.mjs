#!/usr/bin/env node

/**
 * Stage and publish the StepCode npm distribution.
 *
 * The npm packages wrap the exact archives already released to TOS: the job reads
 * `<base-url>/<version>/manifest.json`, downloads each platform archive, verifies
 * its SHA-256, extracts it into a platform package under `vendor/`, and publishes
 * the platform packages before the `@stepfun/stepcode` launcher package.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizeReleaseVersion } from "./release-bundle.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const npmTemplateDir = path.join(repoRoot, "infra", "release", "npm");

export const NPM_MAIN_PACKAGE = "@stepfun/stepcode";
const REPOSITORY_URL = "https://github.com/stepfun-ai/Step-Code";

/** Release target id (manifest key) -> npm platform package metadata. */
export const NPM_TARGETS = [
	{ id: "darwin-arm64", os: "darwin", cpu: "arm64", binary: "step" },
	{ id: "darwin-x64", os: "darwin", cpu: "x64", binary: "step" },
	{ id: "linux-arm64", os: "linux", cpu: "arm64", binary: "step", libc: "glibc" },
	{ id: "linux-x64", os: "linux", cpu: "x64", binary: "step", libc: "glibc" },
	{ id: "windows-arm64", os: "win32", cpu: "arm64", binary: "step.exe" },
	{ id: "windows-x64", os: "win32", cpu: "x64", binary: "step.exe" },
];

export function platformPackageName(target) {
	return `${NPM_MAIN_PACKAGE}-${target.os}-${target.cpu}`;
}

const sharedManifestFields = {
	license: "MIT",
	homepage: REPOSITORY_URL,
	repository: { type: "git", url: `git+${REPOSITORY_URL}.git` },
};

export function createPlatformManifest(version, target) {
	return {
		name: platformPackageName(target),
		version,
		description: `StepCode standalone binary for ${target.os}-${target.cpu}`,
		...sharedManifestFields,
		os: [target.os],
		cpu: [target.cpu],
		...(target.libc ? { libc: [target.libc] } : {}),
		files: ["vendor", "LICENSE"],
		preferUnplugged: true,
	};
}

export function createMainManifest(version) {
	return {
		name: NPM_MAIN_PACKAGE,
		version,
		description: "StepCode: a terminal coding agent by StepFun",
		...sharedManifestFields,
		bin: { step: "bin/step.cjs" },
		files: ["bin", "README.md", "LICENSE"],
		engines: { node: ">=18" },
		optionalDependencies: Object.fromEntries(NPM_TARGETS.map((target) => [platformPackageName(target), version])),
	};
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
	return execFileAsync(command, args, {
		cwd: options.cwd ?? repoRoot,
		env: { ...process.env, ...(options.env ?? {}) },
		maxBuffer: 64 * 1024 * 1024,
	});
}

async function fetchOk(url) {
	const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
	if (!response.ok) throw new Error(`GET ${url} failed (HTTP ${response.status})`);
	return response;
}

function sha256(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

/** Load the release manifest and each archive, either from TOS or a local `dist/release/<version>` dir. */
async function loadRelease({ version, baseUrl, archivesDir }) {
	const manifest = archivesDir
		? JSON.parse(await readFile(path.join(archivesDir, "manifest.json"), "utf8"))
		: await (await fetchOk(`${baseUrl}/${version}/manifest.json`)).json();
	if (manifest.version !== version) {
		throw new Error(`Release manifest version ${manifest.version} does not match ${version}`);
	}
	return {
		async archive(target) {
			const url = manifest.packages?.[target.id];
			const checksum = manifest.checksums?.[target.id];
			if (typeof url !== "string" || typeof checksum !== "string") {
				throw new Error(`Release ${version} manifest has no package for ${target.id}`);
			}
			const fileName = path.posix.basename(new URL(url).pathname);
			const bytes = archivesDir
				? await readFile(path.join(archivesDir, fileName))
				: Buffer.from(await (await fetchOk(url)).arrayBuffer());
			const actual = sha256(bytes);
			if (actual !== checksum) {
				throw new Error(`Checksum mismatch for ${fileName}: expected ${checksum}, got ${actual}`);
			}
			return { fileName, bytes };
		},
	};
}

/** Extract an archive and return the directory that contains the binary. */
async function extractArchive(archive, target, workDir) {
	const archivePath = path.join(workDir, archive.fileName);
	const extractDir = path.join(workDir, `extract-${target.id}`);
	await writeFile(archivePath, archive.bytes);
	await mkdir(extractDir, { recursive: true });
	if (archive.fileName.endsWith(".zip")) await run("unzip", ["-q", archivePath, "-d", extractDir]);
	else await run("tar", ["-xzf", archivePath, "-C", extractDir]);
	// Unix archives wrap their contents in a single `step/` directory; zips do not.
	const entries = await readdir(extractDir, { withFileTypes: true });
	const root =
		entries.length === 1 && entries[0].isDirectory() ? path.join(extractDir, entries[0].name) : extractDir;
	const names = await readdir(root);
	if (!names.includes(target.binary)) throw new Error(`${archive.fileName} does not contain ${target.binary}`);
	return root;
}

export async function stagePackages({ version, baseUrl, archivesDir, outDir }) {
	await rm(outDir, { recursive: true, force: true });
	await mkdir(outDir, { recursive: true });
	const license = path.join(repoRoot, "LICENSE");
	const release = await loadRelease({ version, baseUrl, archivesDir });
	const workDir = await mkdtemp(path.join(os.tmpdir(), "stepcode-npm-"));
	const packageDirs = [];
	try {
		for (const target of NPM_TARGETS) {
			const name = platformPackageName(target);
			process.stdout.write(`[stage] ${name}\n`);
			const archive = await release.archive(target);
			const root = await extractArchive(archive, target, workDir);
			const packageDir = path.join(outDir, name.replace("/", "__"));
			await mkdir(packageDir, { recursive: true });
			await rename(root, path.join(packageDir, "vendor"));
			await cp(license, path.join(packageDir, "LICENSE"));
			await writeFile(
				path.join(packageDir, "package.json"),
				`${JSON.stringify(createPlatformManifest(version, target), null, 2)}\n`,
			);
			packageDirs.push({ name, dir: packageDir });
		}
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}

	const mainDir = path.join(outDir, NPM_MAIN_PACKAGE.replace("/", "__"));
	await mkdir(path.join(mainDir, "bin"), { recursive: true });
	await cp(path.join(npmTemplateDir, "step.cjs"), path.join(mainDir, "bin", "step.cjs"));
	await cp(path.join(npmTemplateDir, "README.md"), path.join(mainDir, "README.md"));
	await cp(license, path.join(mainDir, "LICENSE"));
	await writeFile(path.join(mainDir, "package.json"), `${JSON.stringify(createMainManifest(version), null, 2)}\n`);
	// The launcher must be the last package published so it never points at
	// platform packages that do not exist yet.
	packageDirs.push({ name: NPM_MAIN_PACKAGE, dir: mainDir });
	return packageDirs;
}

/** `https://host/path/` -> `//host/path/:_authToken=${NPM_TOKEN}` (npm expands the variable itself). */
export function npmrcAuthLine(registry) {
	const url = new URL(registry);
	const pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
	return `//${url.host}${pathname}:_authToken=\${NPM_TOKEN}`;
}

async function isPublished(pkg, version, registry, npmEnv) {
	try {
		const { stdout } = await run("npm", ["view", `${pkg.name}@${version}`, "version", "--registry", registry], {
			cwd: pkg.dir,
			env: npmEnv,
		});
		return stdout.trim() === version;
	} catch {
		return false;
	}
}

async function publishPackages(packageDirs, { version, registry, distTag, dryRun }) {
	const workDir = await mkdtemp(path.join(os.tmpdir(), "stepcode-npmrc-"));
	try {
		const npmEnv = {};
		if (!dryRun) {
			if (!process.env.NPM_TOKEN?.trim()) throw new Error("NPM_TOKEN is required to publish");
			// npm expands ${NPM_TOKEN} itself, so the token never lands on disk.
			const userconfig = path.join(workDir, ".npmrc");
			await writeFile(userconfig, `${npmrcAuthLine(registry)}\n`, { mode: 0o600 });
			npmEnv.NPM_CONFIG_USERCONFIG = userconfig;
		}
		for (const pkg of packageDirs) {
			if (!dryRun && (await isPublished(pkg, version, registry, npmEnv))) {
				process.stdout.write(`[skip] ${pkg.name}@${version} is already published\n`);
				continue;
			}
			// `npm publish --dry-run` still contacts the registry; `npm pack --dry-run`
			// validates the same file list offline.
			const args = dryRun
				? ["pack", "--dry-run"]
				: ["publish", "--access", "public", "--tag", distTag, "--registry", registry];
			process.stdout.write(`[${dryRun ? "pack dry-run" : "publish"}] ${pkg.name}@${version}\n`);
			// Run inside the package so npm does not pick up the monorepo's pnpm-only .npmrc.
			const { stdout, stderr } = await run("npm", args, { cwd: pkg.dir, env: npmEnv });
			process.stdout.write(stdout);
			process.stderr.write(stderr);
		}
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.has("help")) {
		process.stdout.write(
			"Usage: node infra/release/npm-packages.mjs --version <vX.Y.Z> [--base-url <url> | --archives-dir <dir>] [--out <dir>] [--registry <url>] [--tag latest] [--publish] [--dry-run]\n",
		);
		return;
	}
	const version = normalizeReleaseVersion(args.get("version") ?? process.env.CI_COMMIT_TAG);
	const baseUrl = String(args.get("base-url") ?? process.env.STEP_RELEASE_PROD_BASE_URL ?? "").replace(/\/+$/u, "");
	const archivesDir = typeof args.get("archives-dir") === "string" ? path.resolve(args.get("archives-dir")) : undefined;
	if (!baseUrl && !archivesDir) throw new Error("--base-url or --archives-dir is required");
	const outDir = path.resolve(String(args.get("out") ?? path.join(repoRoot, "dist", "npm")));
	const distTag = String(args.get("tag") ?? "latest");
	const registry = String(args.get("registry") ?? process.env.STEP_NPM_REGISTRY ?? "");
	if (args.has("publish") && !registry) throw new Error("--registry or STEP_NPM_REGISTRY is required to publish");

	const packageDirs = await stagePackages({ version, baseUrl, archivesDir, outDir });
	if (args.has("publish") || args.has("dry-run")) {
		await publishPackages(packageDirs, { version, registry, distTag, dryRun: args.has("dry-run") });
	}
	process.stdout.write(`StepCode npm packages ${version} staged at ${outDir}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
