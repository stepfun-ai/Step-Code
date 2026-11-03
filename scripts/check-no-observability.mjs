#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const forbidden = [
	/private-telemetry/iu,
	/\/api\/v1\/events/iu,
	/createStepTelemetryRuntime/iu,
	/\bx-step-(session|goal|attempt|harness|span|workspace|provider|model)\b/iu,
	/(?:git@|https?:\/\/|ssh:\/\/git@)gitlab\.(?!com(?:[\/:]|$))/iu,
	/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/iu,
	/[\w.+-]+@(?:[\w-]+\.)+(?:internal|corp|local)\b/iu,
];
const allowedFiles = new Set([
	"packages/coding-agent/src/step/telemetry-contract.ts",
	"packages/coding-agent/src/step/storage-root.ts",
	"packages/coding-agent/src/step/device-id.ts",
]);

function normalize(path) {
	return path.replaceAll("\\", "/");
}

function collectFiles(root) {
	const files = [];
	if (!existsSync(root)) return files;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const file = join(root, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules" && entry.name !== "dist") files.push(...collectFiles(file));
		} else if (/\.(?:ts|tsx|mjs|yml|yaml|json)$/u.test(entry.name)) files.push(file);
	}
	return files;
}

export function analyzeFile(repoPath, text) {
	const normalized = normalize(repoPath);
	if (allowedFiles.has(normalized)) return [];
	return forbidden.flatMap((pattern) => (pattern.test(text) ? [`${normalized}: forbidden observability or secret pattern ${pattern}`] : []));
}

function runReal() {
	const roots = [join(repoRoot, "apps", "cli", "src"), join(repoRoot, "packages", "coding-agent", "src")];
	const violations = [];
	for (const root of roots) {
		for (const file of collectFiles(root)) {
			violations.push(...analyzeFile(relative(repoRoot, file), readFileSync(file, "utf8")));
		}
	}
	if (violations.length) {
		console.error("no-observability check failed:");
		for (const violation of violations) console.error(`  ${violation}`);
		process.exit(1);
	}
	console.log("no-observability check passed.");
}

function runSelfTest() {
	const failures = [];
	const expect = (label, condition) => { if (!condition) failures.push(label); };
	expect("clean source passes", analyzeFile("packages/coding-agent/src/step/foo.ts", "export const value = 1;").length === 0);
	expect("collector host is detected", analyzeFile("packages/coding-agent/src/step/foo.ts", "https://private-telemetry.invalid").length > 0);
	expect("sensitive header is detected", analyzeFile("packages/coding-agent/src/step/foo.ts", "x-step-session-id").length > 0);
	expect("low sensitivity client is allowed", analyzeFile("packages/coding-agent/src/step/foo.ts", "x-step-client").length === 0);
	expect("high-sensitivity model header is detected", analyzeFile("packages/coding-agent/src/step/foo.ts", "x-step-model").length > 0);
	expect("collector base is no longer allowlisted in endpoints", analyzeFile("packages/coding-agent/src/step/feedback/endpoints.ts", "https://x/private-telemetry").length > 0);
	expect("feedback path suffix alone is allowed", analyzeFile("packages/coding-agent/src/step/feedback/endpoints.ts", "const suffix = '/api/v1/feedback';").length === 0);
	if (failures.length) {
		console.error("no-observability self-test FAILED:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	console.log("no-observability self-test passed.");
}

if (process.argv.includes("--self-test")) runSelfTest();
else runReal();
