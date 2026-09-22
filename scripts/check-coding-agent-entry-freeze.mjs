#!/usr/bin/env node

// S0-6 coding-agent entry-surface freeze.
//
// Freezes packages/coding-agent's *entry* responsibility: during the refactor it must not
// grow new process entry points. Concretely, the live "bin" keys and "exports" subpaths
// must stay a SUBSET of the baseline snapshot (scripts/__baseline__/coding-agent-bin.json).
//   - Adding a bin key or export subpath -> FAIL (new entry responsibility crept in).
//   - Removing one -> OK (step 1 deletes pi / ./rpc-entry / ./client; step 3 moves step).
// It is a soft gate: it never demands parity, only forbids growth.
//
// Run:  node scripts/check-coding-agent-entry-freeze.mjs
//       node scripts/check-coding-agent-entry-freeze.mjs --self-test

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const baselinePath = join(scriptDirectory, "__baseline__", "coding-agent-bin.json");
const manifestPath = join(repoRoot, "packages", "coding-agent", "package.json");

// --- pure helper ---------------------------------------------------------------------

function surfaceOf(manifest) {
	return {
		bin: Object.keys(manifest.bin ?? {}),
		exports: Object.keys(manifest.exports ?? {}),
	};
}

// Returns the additions (present live, absent in baseline) — the only thing that fails.
function detectGrowth(live, baseline) {
	const growth = [];
	for (const key of live.bin) {
		if (!baseline.bin.includes(key)) growth.push(`new bin "${key}"`);
	}
	for (const subpath of live.exports) {
		if (!baseline.exports.includes(subpath)) growth.push(`new export subpath "${subpath}"`);
	}
	return growth;
}

// --- real check ----------------------------------------------------------------------

function runReal() {
	const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const growth = detectGrowth(surfaceOf(manifest), { bin: baseline.bin, exports: baseline.exports });

	if (growth.length > 0) {
		console.error("coding-agent entry-freeze check failed — entry surface grew beyond baseline:");
		for (const item of growth) console.error(`  ${item}`);
		console.error("  packages/coding-agent must not gain new bin/argv/TTY entry responsibilities.");
		process.exit(1);
	}
	console.log("coding-agent entry-freeze check passed (no new bin/export entry points).");
}

// --- self-test -----------------------------------------------------------------------

function runSelfTest() {
	const baseline = { bin: ["pi", "step"], exports: [".", "./rpc-entry", "./client"] };
	const failures = [];
	const expect = (label, condition) => {
		if (!condition) failures.push(label);
	};

	expect("unchanged surface passes", detectGrowth(baseline, baseline).length === 0);
	expect("shrunk surface passes", detectGrowth({ bin: ["step"], exports: ["."] }, baseline).length === 0);
	expect("new bin fails", detectGrowth({ bin: ["pi", "step", "pi-voice"], exports: [".", "./rpc-entry", "./client"] }, baseline).some((g) => g.includes("pi-voice")));
	expect("new export fails", detectGrowth({ bin: ["pi", "step"], exports: [".", "./rpc-entry", "./client", "./voice"] }, baseline).some((g) => g.includes("./voice")));

	if (failures.length > 0) {
		console.error("coding-agent entry-freeze self-test FAILED:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	console.log("coding-agent entry-freeze self-test passed.");
}

if (process.argv.includes("--self-test")) runSelfTest();
else runReal();
