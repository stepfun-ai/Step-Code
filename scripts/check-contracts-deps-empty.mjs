#!/usr/bin/env node

// S2-5 invariant guard: packages/contracts must stay dependency-free.
//
// contracts is the shared type/contract package; it may only carry devDependencies
// (test tooling). Any runtime dependency/peer/optional dependency — especially an
// internal workspace package (ai/tui/apps/*) or an I/O library — breaks its "empty
// deps" contract and would let the wire/frame codec pull in side effects.
//
// Run:  node scripts/check-contracts-deps-empty.mjs
//       node scripts/check-contracts-deps-empty.mjs --self-test

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const manifestPath = join(repoRoot, "packages", "contracts", "package.json");

// devDependencies are allowed (vitest/@types for the frame codec test); these three
// runtime-facing sections must be empty.
const guardedSections = ["dependencies", "peerDependencies", "optionalDependencies"];

function checkManifest(manifest) {
	const violations = [];
	for (const section of guardedSections) {
		for (const name of Object.keys(manifest[section] ?? {})) {
			violations.push(`packages/contracts must stay dependency-free, but ${section}."${name}" is declared`);
		}
	}
	return violations;
}

function runReal() {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const violations = checkManifest(manifest);
	if (violations.length > 0) {
		console.error("contracts dependency-free check failed:");
		for (const violation of violations) console.error(`  ${violation}`);
		process.exit(1);
	}
	console.log("contracts dependency-free check passed (no runtime dependencies).");
}

function runSelfTest() {
	const failures = [];
	const expect = (label, condition) => {
		if (!condition) failures.push(label);
	};
	expect("empty manifest passes", checkManifest({ devDependencies: { vitest: "4.1.9" } }).length === 0);
	expect("runtime dependency flagged", checkManifest({ dependencies: { chalk: "5.6.2" } }).some((v) => v.includes("chalk")));
	expect("peer dependency flagged", checkManifest({ peerDependencies: { "@step-harness/ai": "workspace:*" } }).length === 1);
	expect("optional dependency flagged", checkManifest({ optionalDependencies: { foo: "1.0.0" } }).length === 1);
	if (failures.length > 0) {
		console.error("contracts dependency-free self-test FAILED:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	console.log("contracts dependency-free self-test passed.");
}

if (process.argv.includes("--self-test")) runSelfTest();
else runReal();
