#!/usr/bin/env node
// Pre-fetch the ripgrep (rg) and fd search-tool binaries for ONE release target
// and place them under `<out>/tools/`, so the release archive ships them and the
// installer can copy them into `~/.step-cli/agent/bin` WITHOUT any GitHub download
// on the user's machine. The runtime (packages/coding-agent tools-manager) looks
// in that dir first, so a bundled tool is found before the network fallback.
//
// This runs on the BUILD machine (CI), which is expected to have network access.
// Versions are PINNED here for reproducible archives; keep the asset-name scheme
// in sync with packages/coding-agent/src/utils/tools-manager.ts (TOOLS) and the
// installers' managed-tool asset maps.
//
// Set STEP_SKIP_BUNDLED_TOOLS=1 to skip (offline dev builds); the installer/runtime
// GitHub download then remains the only source (the fallback path).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Pinned versions. fd is pinned to 10.3.0 to match the macOS-x64 special case in
// tools-manager.ts; ripgrep is a recent stable release.
export const RG_VERSION = "14.1.1";
export const FD_VERSION = "10.3.0";

const TARGET_ARCH = {
	"darwin-arm64": { os: "darwin", cpu: "aarch64", ext: "tar.gz", exe: "" },
	"darwin-x64": { os: "darwin", cpu: "x86_64", ext: "tar.gz", exe: "" },
	"linux-arm64": { os: "linux", cpu: "aarch64", ext: "tar.gz", exe: "" },
	"linux-x64": { os: "linux", cpu: "x86_64", ext: "tar.gz", exe: "" },
	"windows-arm64": { os: "windows", cpu: "aarch64", ext: "zip", exe: ".exe" },
	"windows-x64": { os: "windows", cpu: "x86_64", ext: "zip", exe: ".exe" },
};

// Resolve the download descriptor for a tool/target. Pure (no network) so tests
// can assert the asset naming without hitting GitHub.
export function assetInfoFor(tool, target, versions = {}) {
	const arch = TARGET_ARCH[target];
	if (!arch) throw new Error(`Unknown target: ${target}`);
	const rgVersion = versions.rgVersion ?? RG_VERSION;
	const fdVersion = versions.fdVersion ?? FD_VERSION;

	if (tool === "fd") {
		const tripleByOs = {
			darwin: `${arch.cpu}-apple-darwin`,
			linux: `${arch.cpu}-unknown-linux-gnu`,
			windows: `${arch.cpu}-pc-windows-msvc`,
		};
		const assetName = `fd-v${fdVersion}-${tripleByOs[arch.os]}.${arch.ext}`;
		return {
			repo: "sharkdp/fd",
			tag: `v${fdVersion}`,
			assetName,
			binaryName: `fd${arch.exe}`,
			url: `https://github.com/sharkdp/fd/releases/download/v${fdVersion}/${assetName}`,
		};
	}
	if (tool === "rg") {
		// ripgrep uses musl for linux-x64 (fully static) and gnu for linux-arm64,
		// mirroring tools-manager.ts.
		const tripleByOs = {
			darwin: `${arch.cpu}-apple-darwin`,
			linux: arch.cpu === "x86_64" ? "x86_64-unknown-linux-musl" : "aarch64-unknown-linux-gnu",
			windows: `${arch.cpu}-pc-windows-msvc`,
		};
		const assetName = `ripgrep-${rgVersion}-${tripleByOs[arch.os]}.${arch.ext}`;
		return {
			repo: "BurntSushi/ripgrep",
			tag: `${rgVersion}`,
			assetName,
			binaryName: `rg${arch.exe}`,
			url: `https://github.com/BurntSushi/ripgrep/releases/download/${rgVersion}/${assetName}`,
		};
	}
	throw new Error(`Unknown tool: ${tool}`);
}

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--target") args.target = argv[++i];
		else if (argv[i] === "--out") args.out = argv[++i];
	}
	return args;
}

async function download(url, dest) {
	const response = await fetch(url, { redirect: "follow", headers: { "User-Agent": "step-cli-build" } });
	if (!response.ok) throw new Error(`download failed ${response.status} for ${url}`);
	const buffer = Buffer.from(await response.arrayBuffer());
	const { writeFileSync } = await import("node:fs");
	writeFileSync(dest, buffer);
}

function extract(archivePath, destDir) {
	mkdirSync(destDir, { recursive: true });
	if (archivePath.endsWith(".zip")) {
		const r = spawnSync("unzip", ["-q", archivePath, "-d", destDir], { stdio: "inherit" });
		if (r.status !== 0) throw new Error(`unzip failed for ${archivePath}`);
	} else {
		const r = spawnSync("tar", ["xf", archivePath, "-C", destDir], { stdio: "inherit" });
		if (r.status !== 0) throw new Error(`tar failed for ${archivePath}`);
	}
}

function findBinary(dir, binaryName) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			const nested = findBinary(full, binaryName);
			if (nested) return nested;
		} else if (entry === binaryName) {
			return full;
		}
	}
	return null;
}

// Try each candidate URL in order; first success wins. Returns true if the tool
// binary landed in toolsDir, false if every source failed. NEVER throws on a
// download/extract failure — bundling rg/fd is a best-effort optimization and
// must not break the release build (the installer/runtime still fetch on demand).
async function fetchTool(tool, target, toolsDir) {
	const info = assetInfoFor(tool, target);
	const destBinary = join(toolsDir, info.binaryName);
	if (existsSync(destBinary)) return true; // idempotent

	// Prefer an internal mirror (e.g. the TOS release bucket) when configured, so
	// locked-down CI runners that cannot reach github.com still bundle the tools.
	const mirror = (process.env.STEP_TOOLS_BASE_URL ?? "").trim().replace(/\/+$/, "");
	const candidates = [mirror ? `${mirror}/${info.assetName}` : null, info.url].filter(Boolean);

	for (const url of candidates) {
		const workDir = mkdtempSync(join(tmpdir(), `step-tool-${tool}-`));
		try {
			const archivePath = join(workDir, info.assetName);
			await download(url, archivePath);
			const extractDir = join(workDir, "extract");
			extract(archivePath, extractDir);
			const found = findBinary(extractDir, info.binaryName);
			if (!found) throw new Error(`binary ${info.binaryName} not found in ${info.assetName}`);
			mkdirSync(toolsDir, { recursive: true });
			renameSync(found, destBinary);
			const { chmodSync } = await import("node:fs");
			if (!info.binaryName.endsWith(".exe")) chmodSync(destBinary, 0o755);
			return true;
		} catch (error) {
			console.warn(`copy-search-tools: ${tool} from ${url} failed: ${error instanceof Error ? error.message : error}`);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	}
	return false;
}

async function main() {
	if (process.env.STEP_SKIP_BUNDLED_TOOLS) {
		console.log("copy-search-tools: STEP_SKIP_BUNDLED_TOOLS set, skipping rg/fd prefetch");
		return;
	}
	const { target, out } = parseArgs(process.argv.slice(2));
	if (!target || !out) {
		console.error("usage: copy-search-tools.mjs --target <os-arch> --out <targetDir>");
		process.exit(2);
	}
	const toolsDir = resolve(out, "tools");
	mkdirSync(toolsDir, { recursive: true });
	let skipped = 0;
	for (const tool of ["rg", "fd"]) {
		const ok = await fetchTool(tool, target, toolsDir);
		if (ok) {
			console.log(`copy-search-tools: ${tool} ready for ${target} at ${join(toolsDir, assetInfoFor(tool, target).binaryName)}`);
		} else {
			skipped++;
			console.warn(`copy-search-tools: ${tool} not bundled for ${target}; installer/runtime will fetch it on demand`);
		}
	}
	if (skipped > 0) {
		// Best-effort: a missing bundled tool must not fail the release. Set
		// STEP_TOOLS_BASE_URL to an internal mirror (e.g. the TOS bucket) to bundle
		// them on runners that cannot reach github.com.
		console.warn(`copy-search-tools: ${skipped}/2 tool(s) unbundled (non-fatal)`);
	}
}

// Only run when invoked as a script, not when imported by tests.
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const thisPath = resolve(dirname(new URL(import.meta.url).pathname), "copy-search-tools.mjs");
if (invokedPath === thisPath) {
	main().catch((error) => {
		console.error(`copy-search-tools: ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	});
}
