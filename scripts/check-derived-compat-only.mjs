#!/usr/bin/env node

// S5-2 "derivation is compat-only" check.
//
// The dialect resolver records whether a model's protocol was `declared`
// (explicit `model.api`) or `derived-from-provider` (a legacy compatibility
// path). Design §5.5 pins two invariants this gate enforces statically:
//
//   Rule 1 — single home. `deriveFromLegacyProvider` (the ONE sanctioned
//            old-provider -> dialect mapping) may be referenced only inside its
//            home, packages/providers/src/dialect/resolve.ts (and *.test.ts). Any other
//            reference means an ad-hoc name->dialect map is leaking elsewhere.
//
//   Rule 2 — `source` never selects an adapter. The DialectSource literal
//            "derived-from-provider" must not appear in the adapter-selection
//            zone (packages/providers/src/api/**, models.ts, dialect/registry.ts). The
//            dispatch key is always `.api`; branching an adapter choice on
//            `source === "derived-from-provider"` is forbidden.
//
// No new dependency; same node + --self-test convention as the sibling
// check-*.mjs scripts. Pure classification in analyzeFile(path, text).
//
// Run:  node scripts/check-derived-compat-only.mjs
//       node scripts/check-derived-compat-only.mjs --self-test

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");

const DERIVE_FN = "deriveFromLegacyProvider";
const SOURCE_LITERAL = "derived-from-provider";
const DERIVE_HOME = "packages/providers/src/dialect/resolve.ts";

// --- pure classification -------------------------------------------------------------

function normalize(p) {
	return p.replace(/\\/g, "/");
}

// May this path legitimately name deriveFromLegacyProvider? Its home + tests.
function isDeriveHome(p) {
	const n = normalize(p);
	return n === DERIVE_HOME || /\.test\.ts$/.test(n);
}

// Is this file part of the adapter-selection zone, where an adapter/dialect is
// chosen and the compat `source` must never appear as a branch?
function inSelectionZone(p) {
	const n = normalize(p);
	return n.startsWith("packages/providers/src/api/") || n === "packages/providers/src/models.ts" || n === "packages/providers/src/dialect/registry.ts";
}

// The single decision function. Returns an array of violation strings.
function analyzeFile(repoRelPath, text) {
	const n = normalize(repoRelPath);
	const violations = [];
	if (text.includes(DERIVE_FN) && !isDeriveHome(n)) {
		violations.push(`${n}: references ${DERIVE_FN} — the legacy provider->dialect derivation must live only in ${DERIVE_HOME}`);
	}
	if (inSelectionZone(n) && text.includes(SOURCE_LITERAL)) {
		violations.push(`${n}: uses the DialectSource literal "${SOURCE_LITERAL}" in the adapter-selection zone — source is telemetry-only, never a dispatch input (select by .api)`);
	}
	return violations;
}

// --- filesystem ----------------------------------------------------------------------

function collectTsFiles(absoluteDir) {
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

function runReal() {
	const roots = [join(repoRoot, "packages", "providers", "src"), join(repoRoot, "packages", "coding-agent", "src")];
	const violations = [];
	for (const root of roots) {
		for (const file of collectTsFiles(root)) {
			const repoRel = relative(repoRoot, file);
			for (const violation of analyzeFile(repoRel, readFileSync(file, "utf8"))) violations.push(violation);
		}
	}
	if (violations.length > 0) {
		console.error("derived-compat-only check failed:");
		for (const violation of violations) console.error(`  ${violation}`);
		process.exit(1);
	}
	console.log("derived-compat-only check passed.");
}

// --- self-test -----------------------------------------------------------------------

function runSelfTest() {
	const failures = [];
	const expectClean = (path, text) => {
		if (analyzeFile(path, text).length > 0) failures.push(`expected clean: ${path}`);
	};
	const expectViolation = (path, text) => {
		if (analyzeFile(path, text).length === 0) failures.push(`expected violation: ${path}`);
	};

	// clean — the home defines and uses both; callers use resolveModelApiDialect, not the derive fn.
	expectClean(DERIVE_HOME, `export function ${DERIVE_FN}() { return undefined; } // "${SOURCE_LITERAL}"`);
	expectClean("packages/providers/test/dialect-resolve.test.ts", `import { ${DERIVE_FN} } from "../src/dialect/resolve.ts"; // "${SOURCE_LITERAL}"`);
	expectClean("packages/providers/src/api/openai-completions.ts", "const adapter = byApi[model.api];"); // selects by api, no source literal
	expectClean("packages/coding-agent/src/core/model-request-observer.ts", `telemetry.record({ source: "${SOURCE_LITERAL}" });`); // telemetry outside the zone is fine

	// violation — rule 1: derive fn referenced outside its home
	expectViolation("packages/providers/src/models.ts", `import { ${DERIVE_FN} } from "./dialect/resolve.ts";`);
	expectViolation("packages/coding-agent/src/core/provider-composer.ts", `const api = ${DERIVE_FN}(model.provider);`);
	// violation — rule 2: source literal used inside the adapter-selection zone
	expectViolation("packages/providers/src/api/openai-responses.ts", `if (resolved.source === "${SOURCE_LITERAL}") pickAdapter();`);
	expectViolation("packages/providers/src/models.ts", `const isCompat = source === "${SOURCE_LITERAL}";`);

	if (failures.length > 0) {
		console.error("derived-compat-only self-test FAILED:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	console.log("derived-compat-only self-test passed.");
}

if (process.argv.includes("--self-test")) runSelfTest();
else runReal();
