#!/usr/bin/env node

// A1 closing gate (design §7.8.7): after internal-scope unification, product source must
// use only the new @step-harness/* scope. The legacy org scope (@earendil-works/pi-*) and
// the earliest personal scope (@mariozechner/pi-*) survive ONLY as external-promise
// backward-compat surfaces — the extension loader's virtualModules/alias tables and the
// theme globalThis Symbol.for keys (§7.8.5, only-add-never-remove). Everything else in
// packages/*/src and apps/*/src must be on the new scope.
//
// Scope: packages/*/src/** + apps/*/src/** (product source only). Tests, examples, docs,
// scripts, configs, CHANGELOGs and the lockfile are out of scope — examples and the
// backward-compat resolution aliases (tsconfig/vitest) legitimately keep the legacy scope.
//
// The prefixes are matched WITHOUT a trailing slash so an escaped-slash regex literal
// (e.g. /^@earendil-works\/pi-x$/) cannot hide from the scan (pitfall §7.8.3).
//
// Run:  node scripts/check-legacy-scope-prefix.mjs
//       node scripts/check-legacy-scope-prefix.mjs --self-test

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");

const LEGACY_PREFIXES = ["@earendil-works/pi-", "@mariozechner/pi-"];

// The only product-source files allowed to carry the legacy scope: the extension loader's
// three-generation compatibility mapping and the theme cross-version Symbol.for keys.
const EXEMPT = new Set([
	"packages/coding-agent/src/core/extensions/loader.ts",
	"packages/coding-agent/src/theme/theme.ts",
]);

function normalize(p) {
	return p.replace(/\\/g, "/");
}

// The single decision function. Returns an array of violation strings.
function analyzeFile(repoRelPath, text) {
	const n = normalize(repoRelPath);
	if (EXEMPT.has(n)) return [];
	const violations = [];
	for (const prefix of LEGACY_PREFIXES) {
		if (text.includes(prefix)) {
			violations.push(
				`${n}: legacy scope "${prefix}" in product source — internal references must use @step-harness/* (the legacy scope survives only in the extension loader mapping and theme Symbol.for keys, §7.8.5)`,
			);
		}
	}
	return violations;
}

// --- filesystem ----------------------------------------------------------------------

function collectSrcTsFiles(absoluteDir) {
	const files = [];
	const walk = (dir) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules" && entry.name !== "dist") walk(full);
			} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
				files.push(full);
			}
		}
	};
	walk(absoluteDir);
	return files;
}

// packages/*/src and apps/*/src — product source roots only.
function srcRoots() {
	const roots = [];
	for (const group of ["packages", "apps"]) {
		const groupDir = join(repoRoot, group);
		if (!existsSync(groupDir)) continue;
		for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
			if (entry.isDirectory()) roots.push(join(groupDir, entry.name, "src"));
		}
	}
	return roots;
}

function runReal() {
	const violations = [];
	for (const root of srcRoots()) {
		for (const file of collectSrcTsFiles(root)) {
			const repoRel = relative(repoRoot, file);
			for (const violation of analyzeFile(repoRel, readFileSync(file, "utf8"))) violations.push(violation);
		}
	}
	if (violations.length > 0) {
		console.error("legacy-scope-prefix check failed:");
		for (const violation of violations) console.error(`  ${violation}`);
		process.exit(1);
	}
	console.log("legacy-scope-prefix check passed.");
}

// --- self-test -----------------------------------------------------------------------

function runSelfTest() {
	const failures = [];
	const expectClean = (path, text) => {
		if (analyzeFile(path, text).length > 0) failures.push(`expected clean: ${path} :: ${text}`);
	};
	const expectViolation = (path, text) => {
		if (analyzeFile(path, text).length === 0) failures.push(`expected violation: ${path} :: ${text}`);
	};

	// clean — new-scope imports are fine
	expectClean("packages/coding-agent/src/core/model-runtime.ts", 'import { createModels } from "@step-harness/providers";');
	expectClean("apps/cli/src/main.ts", 'import { registerBunOAuthFlows } from "@step-harness/providers/bun-oauth";');
	// clean — the two exempt backward-compat surfaces keep the legacy scope on purpose
	expectClean("packages/coding-agent/src/core/extensions/loader.ts", '"@earendil-works/pi-tui": _bundledPiTui,');
	expectClean("packages/coding-agent/src/theme/theme.ts", 'Symbol.for("@mariozechner/pi-coding-agent:theme")');

	// violation — a legacy import in ordinary product source
	expectViolation("packages/coding-agent/src/core/x.ts", 'import { y } from "@earendil-works/pi-ai";');
	expectViolation("apps/cli/src/ui/x.ts", 'import type { KeyId } from "@earendil-works/pi-tui";');
	expectViolation("packages/providers/src/x.ts", 'import { z } from "@mariozechner/pi-ai/compat";');

	if (failures.length > 0) {
		console.error("legacy-scope-prefix self-test FAILED:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	console.log("legacy-scope-prefix self-test passed.");
}

if (process.argv.includes("--self-test")) runSelfTest();
else runReal();
