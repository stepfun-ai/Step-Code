#!/usr/bin/env node

// S5-6 "metadata does not participate in dispatch" check.
//
// Model metadata (cost / context / thinking / compat) is DEGRADED to pure
// metadata: it answers "how much / how long / which thinking levels", never
// "which protocol". The dispatch key is always model.api. This gate freezes that
// by asserting the `metadata/` module is NOT imported by any dispatch point:
//
//   dispatch zone = packages/providers/src/api/** + models.ts + dialect/registry.ts
//
// An import of `../metadata/...` (or any path ending in `metadata/<file>`) from a
// dispatch-point file means metadata leaked into protocol selection — fail the build.
// The dispatch zone is every point that selects the protocol implementation by
// model.api: the adapters (api/**), the byApi map (models.ts), the live api-keyed
// lookup (compat.ts getApiProvider), and the dialect module (registry + resolve).
//
// No new dependency; same node + --self-test convention as the sibling check-*.mjs.
//
// Run:  node scripts/check-metadata-not-in-dispatch.mjs
//       node scripts/check-metadata-not-in-dispatch.mjs --self-test

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");

// Import of a metadata module: `from "<...>/metadata/<name>"` (relative or bare).
const METADATA_IMPORT = /\bfrom\s*["'][^"']*\bmetadata\/[^"']+["']/;

function normalize(p) {
	return p.replace(/\\/g, "/");
}

// Is this file a dispatch point, where selecting the protocol happens? Covers the
// adapters, the byApi map (models.ts), the live api-keyed lookup (compat.ts
// getApiProvider), and the whole dialect module (registry.ts / resolve.ts).
function inDispatchZone(repoRelPath) {
	const n = normalize(repoRelPath);
	return (
		n.startsWith("packages/providers/src/api/") ||
		n.startsWith("packages/providers/src/dialect/") ||
		n === "packages/providers/src/models.ts" ||
		n === "packages/providers/src/compat.ts"
	);
}

// The single decision function. Returns an array of violation strings.
function analyzeFile(repoRelPath, text) {
	const n = normalize(repoRelPath);
	if (inDispatchZone(n) && METADATA_IMPORT.test(text)) {
		return [`${n}: imports the metadata/ module from a dispatch point — metadata is telemetry/cost only and must never select a protocol (dispatch is by model.api)`];
	}
	return [];
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
	const violations = [];
	for (const file of collectTsFiles(join(repoRoot, "packages", "providers", "src"))) {
		const repoRel = relative(repoRoot, file);
		for (const violation of analyzeFile(repoRel, readFileSync(file, "utf8"))) violations.push(violation);
	}
	if (violations.length > 0) {
		console.error("metadata-not-in-dispatch check failed:");
		for (const violation of violations) console.error(`  ${violation}`);
		process.exit(1);
	}
	console.log("metadata-not-in-dispatch check passed.");
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

	// clean — metadata imported OUTSIDE the dispatch zone (flatten consumes it legitimately)
	expectClean("packages/providers/src/provider/flatten.ts", 'import type { MetadataLookup } from "../metadata/lookup.ts";');
	// clean — a dispatch-zone file importing non-metadata modules
	expectClean("packages/providers/src/api/openai-completions.ts", 'import type { Model } from "../types.ts";');
	expectClean("packages/providers/src/models.ts", 'import { getApiProvider } from "./compat.ts";');

	// violation — a dispatch-zone file importing the metadata module
	expectViolation("packages/providers/src/api/openai-responses.ts", 'import { createMetadataLookup } from "../metadata/lookup.ts";');
	expectViolation("packages/providers/src/models.ts", 'import type { ModelMetadata } from "./metadata/types.ts";');
	expectViolation("packages/providers/src/dialect/registry.ts", 'import { x } from "../metadata/types.ts";');
	expectViolation("packages/providers/src/dialect/resolve.ts", 'import { x } from "../metadata/lookup.ts";');
	expectViolation("packages/providers/src/compat.ts", 'import { createMetadataLookup } from "./metadata/lookup.ts";');

	if (failures.length > 0) {
		console.error("metadata-not-in-dispatch self-test FAILED:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	console.log("metadata-not-in-dispatch self-test passed.");
}

if (process.argv.includes("--self-test")) runSelfTest();
else runReal();
