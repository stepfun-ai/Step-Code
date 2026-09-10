#!/usr/bin/env node

// Four-state smoke for the apps/cli skeleton (S0-2 acceptance A4).
//
// It proves that the app-internal absolute import prefix declared in
// apps/cli/package.json "imports" resolves identically under all four toolchains the
// repository relies on: tsgo (types + emit), tsx (dev entry), esbuild (release bundle)
// and bun (single-file binary).
//
// Shape notes (measured, do not "simplify" back):
//   - The prefix maps "#*" -> "./src/*.ts": the ".ts" lives in the mapping target and
//     source specifiers stay extensionless ("#version", "#ui/index").
//   - "#/..." is not usable: Node's PACKAGE_IMPORTS_RESOLVE rejects any specifier that is
//     exactly "#" or starts with "#/" (ERR_INVALID_MODULE_SPECIFIER), and tsgo/bun refuse
//     to resolve it too. Only esbuild tolerates it, i.e. bundle-green but runtime-red.
//   - A ".ts" suffix on a non-relative specifier ("#version.ts") is a hard tsgo error
//     (TS2877) because tsconfig.base.json sets rewriteRelativeImportExtensions.
//   - Consequence: the unbundled tsgo output keeps "#" specifiers verbatim, so apps/cli
//     dist/ is not a self-contained runtime artifact. Runtime entries must go through the
//     esbuild/bun bundle, which resolves the prefix at build time.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const entryPath = join(repoRoot, "apps/cli/src/main.ts");
const buildConfigPath = "apps/cli/tsconfig.build.json";
const rootConfigPath = join(repoRoot, "tsconfig.json");
const notImplementedMarker = "entry not implemented";
const importedMarker = "SMOKE_IMPORTED";
const threwMarker = "SMOKE_THREW:";

const workingDirectory = mkdtempSync(join(tmpdir(), "step-harness-apps-cli-smoke-"));
const results = [];

function binaryPath(command) {
	const name = process.platform === "win32" ? `${command}.cmd` : command;
	return join(repoRoot, "node_modules/.bin", name);
}

function run(command, args) {
	return spawnSync(command, args, {
		cwd: repoRoot,
		encoding: "utf8",
		maxBuffer: 20 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
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

function checkTsx() {
	const probePath = join(workingDirectory, "tsx-probe.mts");
	writeFileSync(
		probePath,
		[
			`const module = await import(${JSON.stringify(pathToFileURL(entryPath).href)});`,
			`console.log(${JSON.stringify(importedMarker)});`,
			"try {",
			"\t(module as { main: () => never }).main();",
			"} catch (error) {",
			`\tconsole.log(${JSON.stringify(threwMarker)}, (error as Error).message);`,
			"}",
			"",
		].join("\n"),
		"utf8",
	);

	const result = run(binaryPath("tsx"), ["--tsconfig", rootConfigPath, probePath]);
	const output = combinedOutput(result);
	if (result.status !== 0) return record("tsx", false, `exit ${result.status}: ${output}`);
	if (!output.includes(importedMarker)) return record("tsx", false, `import produced no marker: ${output}`);
	if (!output.includes(threwMarker)) return record("tsx", false, `main() did not throw: ${output}`);
	if (!output.includes(notImplementedMarker)) {
		return record("tsx", false, `main() threw an unexpected message: ${output}`);
	}
	record("tsx", true, `imported apps/cli/src/main.ts and main() threw "${notImplementedMarker}"`);
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

function checkTsgo() {
	const result = run(binaryPath("tsgo"), ["-p", buildConfigPath, "--noEmit"]);
	if (result.status !== 0) return record("tsgo", false, `exit ${result.status}: ${combinedOutput(result)}`);
	record("tsgo", true, `${buildConfigPath} type-checks with no diagnostics`);
}

try {
	checkTsx();
	checkEsbuild();
	checkBun();
	checkTsgo();
} finally {
	rmSync(workingDirectory, { force: true, recursive: true });
}

const failures = results.filter((result) => result.ok === false);
const skipped = results.filter((result) => result.ok === "skip");
if (failures.length > 0) {
	console.error(`apps/cli four-state smoke failed: ${failures.map((result) => result.state).join(", ")}`);
	process.exit(1);
}

console.log(
	`apps/cli four-state smoke passed (${results.length - skipped.length}/${results.length} states run${
		skipped.length > 0 ? `, skipped: ${skipped.map((result) => result.state).join(", ")}` : ""
	}).`,
);
