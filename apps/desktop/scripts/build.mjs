#!/usr/bin/env node
// Bundle the Electron main process and preload.
//
//   src/main.ts    -> dist/main.js     ESM, loaded by Electron as package.json "main"
//   src/preload.ts -> dist/preload.cjs CommonJS: sandboxed preloads cannot load ES modules
//
// `--ensure-web` additionally builds @step-harness/web when its server or client
// output is missing, so `pnpm dev` works from a fresh checkout without rebuilding
// the web app on every launch.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(root, "..", "web");
const outdir = join(root, "dist");

if (process.argv.includes("--ensure-web")) {
	const required = [join(webRoot, "dist", "server.js"), join(webRoot, "dist", "public", "index.html")];
	const missing = required.filter((path) => !existsSync(path));
	if (missing.length > 0) {
		console.log(`[desktop] web build output missing (${missing.join(", ")}); building @step-harness/web`);
		const result = spawnSync("pnpm", ["--filter", "@step-harness/web", "build"], {
			cwd: root,
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		if (result.status !== 0) process.exit(result.status ?? 1);
	}
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
		// electron-updater (bundled; the packaged app ships no node_modules for the
		// shell) is CommonJS and `require`s Node built-ins and electron. An ES module
		// has no `require`, so give the bundle one.
		banner: {
			js: 'import { createRequire as __stepcodeCreateRequire } from "node:module"; const require = __stepcodeCreateRequire(import.meta.url);',
		},
	}),
	build({
		...shared,
		entryPoints: ["src/preload.ts"],
		outfile: join(outdir, "preload.cjs"),
		format: "cjs",
	}),
]);
