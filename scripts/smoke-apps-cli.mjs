#!/usr/bin/env node

// Real-entry smoke for @step-harness/cli.
//
// apps/cli/src/main.ts is now the product entry (not the S0 skeleton), so the
// former "import main() and expect it to throw 'not implemented'" probe is gone:
// main.ts is a top-level-await launcher, not a main() export. This smoke instead
// runs the real dev entry through tsx (--version / --help) and keeps the two
// bundler resolution proofs that guard the app-internal import prefix.
//
// Import-prefix notes (measured, do not "simplify" back):
//   - apps/cli/package.json maps "#*" -> "./src/*.ts": the ".ts" lives in the
//     mapping target and source specifiers stay extensionless ("#version",
//     "#ui/index").
//   - "#/..." is not usable: Node's PACKAGE_IMPORTS_RESOLVE rejects any specifier
//     that is exactly "#" or starts with "#/" (ERR_INVALID_MODULE_SPECIFIER), and
//     tsgo/bun refuse it too. Only esbuild tolerates it (bundle-green, runtime-red).
//   - A ".ts" suffix on a non-relative specifier ("#version.ts") is a hard tsgo
//     error (TS2877) because tsconfig.base.json sets rewriteRelativeImportExtensions.
//   - Consequence: the unbundled tsgo output keeps "#" specifiers verbatim, so
//     apps/cli dist/ is not a self-contained runtime artifact. Release runtimes go
//     through the esbuild/bun bundle, which inlines the prefix at build time — which
//     is exactly what the esbuild/bun checks below assert.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const entryPath = join(repoRoot, "apps/cli/src/main.ts");
const rootConfigPath = join(repoRoot, "tsconfig.json");

const workingDirectory = mkdtempSync(join(tmpdir(), "step-harness-apps-cli-smoke-"));
const results = [];

function binaryPath(command) {
	const name = process.platform === "win32" ? `${command}.cmd` : command;
	return join(repoRoot, "node_modules/.bin", name);
}

function run(command, args, extraEnv) {
	return spawnSync(command, args, {
		cwd: repoRoot,
		encoding: "utf8",
		maxBuffer: 20 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...extraEnv },
	});
}

function combinedOutput(result) {
	if (result.error) return String(result.error.message);
	return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function record(state, ok, detail) {
	results.push({ detail, ok, state });
	const status = ok === "skip" ? "SKIP" : ok ? "PASS" : "FAIL";
	console.log(`${status}  ${state.padEnd(8)}  ${detail}`);
}

function isCommandAvailable(command) {
	const result = spawnSync(command, ["--version"], { stdio: "ignore" });
	return !result.error && result.status === 0;
}

// The real dev runtime: tsx runs apps/cli/src/main.ts, resolving "#*" at runtime.
// Isolate the Step storage namespace so the smoke never touches a real home.
const entryEnv = {
	STEP_CODING_AGENT_DIR: join(workingDirectory, "agent"),
};

function checkEntryVersion() {
	const result = run(binaryPath("tsx"), ["--tsconfig", rootConfigPath, entryPath, "--version"], entryEnv);
	const output = combinedOutput(result);
	if (result.status !== 0) return record("--version", false, `exit ${result.status}: ${output}`);
	if (!/\d+\.\d+\.\d+/.test(result.stdout ?? "")) {
		return record("--version", false, `stdout is not a version: ${output}`);
	}
	record("--version", true, `real entry printed ${result.stdout.trim()}`);
}

function checkEntryHelp() {
	const result = run(binaryPath("tsx"), ["--tsconfig", rootConfigPath, entryPath, "--help"], entryEnv);
	const output = combinedOutput(result);
	if (result.status !== 0) return record("--help", false, `exit ${result.status}: ${output}`);
	if (!(result.stdout ?? "").includes("Usage:")) {
		return record("--help", false, `stdout has no Usage: ${output}`);
	}
	record("--help", true, "real entry printed --help to stdout");
}

function checkEsbuild() {
	const outputPath = join(workingDirectory, "esbuild-bundle.js");
	const result = run(binaryPath("esbuild"), [
		"--bundle",
		entryPath,
		"--platform=node",
		"--format=esm",
		"--log-level=warning",
		`--outfile=${outputPath}`,
	]);
	if (result.status !== 0) return record("esbuild", false, `exit ${result.status}: ${combinedOutput(result)}`);
	record("esbuild", true, `bundled apps/cli/src/main.ts to ${outputPath}`);
}

function checkBun() {
	if (!isCommandAvailable("bun")) {
		return record("bun", "skip", "bun is not installed on this machine");
	}

	const outputPath = join(workingDirectory, "bun-bundle.js");
	const result = run("bun", ["build", entryPath, "--target=node", "--outfile", outputPath]);
	if (result.status !== 0) return record("bun", false, `exit ${result.status}: ${combinedOutput(result)}`);
	record("bun", true, `bundled apps/cli/src/main.ts to ${outputPath}`);
}

try {
	checkEntryVersion();
	checkEntryHelp();
	checkEsbuild();
	checkBun();
} finally {
	rmSync(workingDirectory, { force: true, recursive: true });
}

const failures = results.filter((result) => result.ok === false);
const skipped = results.filter((result) => result.ok === "skip");
if (failures.length > 0) {
	console.error(`apps/cli smoke failed: ${failures.map((result) => result.state).join(", ")}`);
	process.exit(1);
}

console.log(
	`apps/cli smoke passed (${results.length - skipped.length}/${results.length} checks run${
		skipped.length > 0 ? `, skipped: ${skipped.map((result) => result.state).join(", ")}` : ""
	}).`,
);
