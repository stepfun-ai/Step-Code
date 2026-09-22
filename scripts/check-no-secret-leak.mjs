#!/usr/bin/env node

// S5-7 "no credential leak" check.
//
// Availability probes and any trace/telemetry built from them must never carry a
// resolved credential in plaintext (design §5.8 / §5.14 condition 5). A probe's
// `error.reason` is the classic leak: `reason: \`401 for ${apiKey}\``. This gate
// forbids interpolating a credential-like variable into a string anywhere in the
// availability/trace zone; the reason must be built from redacted text instead
// (see redactCredential in availability/probe.ts).
//
// Zone: packages/providers/src/availability/** (+ dialect/** where dialect/profileId traces
// live). No new dependency; same node + --self-test convention as the sibling checks.
//
// Run:  node scripts/check-no-secret-leak.mjs
//       node scripts/check-no-secret-leak.mjs --self-test

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");

// A `${...}` template interpolation whose expression names a credential-like variable.
const CREDENTIAL_INTERPOLATION = /\$\{[^}]*\b(credential|apiKey|apikey|token|secret|password)\b[^}]*\}/;

function normalize(p) {
	return p.replace(/\\/g, "/");
}

function inSecretZone(repoRelPath) {
	const n = normalize(repoRelPath);
	return n.startsWith("packages/providers/src/availability/") || n.startsWith("packages/providers/src/dialect/");
}

// The single decision function. Returns an array of violation strings.
function analyzeFile(repoRelPath, text) {
	const n = normalize(repoRelPath);
	if (inSecretZone(n) && CREDENTIAL_INTERPOLATION.test(text)) {
		return [`${n}: interpolates a credential-like value into a string — never put a secret in a probe reason / trace / telemetry (redact it first, e.g. redactCredential)`];
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
		console.error("no-secret-leak check failed:");
		for (const violation of violations) console.error(`  ${violation}`);
		process.exit(1);
	}
	console.log("no-secret-leak check passed.");
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

	// clean — probe.ts redacts (splits on the credential), never interpolates it
	expectClean("packages/providers/src/availability/probe.ts", "return reason.split(credential).join('[redacted]');");
	expectClean("packages/providers/src/availability/probe.ts", "reason: redactCredential(message, credential)");
	// clean — a credential interpolation OUTSIDE the zone is not this gate's concern
	expectClean("packages/providers/src/api/openai-completions.ts", "headers.Authorization = `Bearer ${apiKey}`;");

	// violation — a credential interpolated into a reason/string inside the zone
	expectViolation("packages/providers/src/availability/probe.ts", "reason: `401 Unauthorized for ${credential}`,");
	expectViolation("packages/providers/src/dialect/registry.ts", "log(`probe with ${apiKey} failed`);");
	expectViolation("packages/providers/src/availability/probe.ts", "throw new Error(`bad ${token}`);");

	if (failures.length > 0) {
		console.error("no-secret-leak self-test FAILED:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	console.log("no-secret-leak self-test passed.");
}

if (process.argv.includes("--self-test")) runSelfTest();
else runReal();
