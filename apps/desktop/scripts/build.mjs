#!/usr/bin/env node
// Bundle the Electron main process and preload.
//
//   src/main.ts    -> dist/main.js     ESM, loaded by Electron as package.json "main"
//   src/preload.ts -> dist/preload.cjs CommonJS: sandboxed preloads cannot load ES modules
//
// `--ensure-web` builds the workspace packages the server imports and
// @step-harness/web when their output is missing or older than their sources,
// so `pnpm dev` and `pnpm start` work after a checkout or branch switch without
// a manual root build.

import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { staleProbes } from "../src/dist-freshness.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(root, "..", "..");
const webRoot = join(root, "..", "web");
const outdir = join(root, "dist");

/**
 * Workspace packages reachable from the web host, in build order. The scripts
 * emit types only: `build:offline` skips model generation and `build:unbundled`
 * skips the CLI bundle, so a launch never rewrites tracked sources or pays for
 * packaging it does not use.
 */
const workspacePackages = [
	{ name: "@step-harness/pi-tui", directory: "tui", script: "build" },
	{ name: "@step-harness/telemetry", directory: "telemetry", script: "build" },
	{ name: "@step-harness/providers", directory: "providers", script: "build:offline" },
	{ name: "@step-harness/agent-core", directory: "agent-core", script: "build" },
	{ name: "@step-harness/config", directory: "config", script: "build" },
	{ name: "@step-harness/coding-agent", directory: "coding-agent", script: "build:unbundled" },
];

const workspaceProbes = workspacePackages.map(({ name, directory }) => {
	const packageRoot = join(repoRoot, "packages", directory);
	return {
		name,
		outputs: [join(packageRoot, "dist", "index.d.ts")],
		sourceRoots: [join(packageRoot, "src")],
	};
});

const webProbe = {
	name: "@step-harness/web",
	outputs: [join(webRoot, "dist", "server.js"), join(webRoot, "dist", "public", "index.html")],
	sourceRoots: [join(webRoot, "src"), join(webRoot, "client")],
};

if (process.argv.includes("--ensure-web")) {
	const stale = new Set(staleProbes([...workspaceProbes, webProbe]));
	const firstStale = workspacePackages.findIndex(({ name }) => stale.has(name));
	if (firstStale !== -1) {
		// Later packages were compiled against the stale declarations, so rebuild the chain from there.
		const rebuild = workspacePackages.slice(firstStale);
		console.log(`[desktop] workspace build output out of date (${rebuild.map(({ name }) => name).join(", ")})`);
		for (const { name, script } of rebuild) run("pnpm", ["--filter", name, script]);
	}
	if (firstStale !== -1 || stale.has(webProbe.name)) {
		console.log("[desktop] building @step-harness/web");
		run("pnpm", ["--filter", "@step-harness/web", "build"]);
	}
}

function run(command, args) {
	const result = spawnSync(command, args, {
		cwd: root,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

await rm(outdir, { recursive: true, force: true });

const shared = {
	bundle: true,
	platform: "node",
	target: "node24",
	external: ["electron"],
	sourcemap: true,
	logLevel: "info",
	absWorkingDir: root,
};

await Promise.all([
	build({
		...shared,
		entryPoints: ["src/main.ts"],
		outfile: join(outdir, "main.js"),
		format: "esm",
	}),
	build({
		...shared,
		entryPoints: ["src/preload.ts"],
		outfile: join(outdir, "preload.cjs"),
		format: "cjs",
	}),
]);
