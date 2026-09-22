#!/usr/bin/env node

// S5-3 "no vendor-name dispatch" check.
//
// The dispatch key is always model.api (models.ts `byApi?.[model.api]`, compat.ts
// getApiProvider(model.api)). A provider's identity must NEVER select the protocol
// implementation. This gate freezes that invariant inside the adapter zone
// (packages/providers/src/api/**):
//
//   - No `switch (provider)` / `switch (model.provider)` — adapters never select
//     an implementation by vendor name (there are zero today; keep it zero).
//   - A `model.provider === "<literal>"` / `!== "<literal>"` branch (either
//     operator, either operand order) is a MAJ-7 compatibility quirk (tuning
//     headers/params/thinking/capability for a real gateway), NOT adapter
//     selection. Such quirks are allowed only in the files + provider literals
//     registered in scripts/adapter-provider-quirks.json. A quirk in any other
//     api/ file, or a NEW un-registered provider literal, fails the build.
//
// Field-to-field comparisons (`X.provider === model.provider`) are not quirks and
// are excluded by the literal-only regex. Scope is intentionally packages/providers/src/api
// ONLY — coding-agent product-side attribution (provider-attribution.ts) is legal
// and out of scope (A1 handles step-provider).
//
// No new dependency; same node + --self-test convention as the sibling check-*.mjs.
//
// Run:  node scripts/check-no-provider-dispatch.mjs
//       node scripts/check-no-provider-dispatch.mjs --self-test

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const apiDirRelative = "packages/providers/src/api";

// Matches a provider-vs-literal comparison in either direction and with either
// operator: `provider === "x"`, `model.provider !== "x"`, `"x" === model.provider`.
// It does NOT match field-to-field `X.provider === model.provider` (no quoted side).
const PROVIDER_LITERAL = /\bprovider\s*(?:===|!==)\s*"([^"]+)"/g;
const PROVIDER_LITERAL_REVERSED = /"([^"]+)"\s*(?:===|!==)\s*[\w.]*\bprovider\b/g;
// Matches `switch (provider)` / `switch (model.provider)`.
const PROVIDER_SWITCH = /\bswitch\s*\(\s*[\w.]*\bprovider\s*\)/;

function normalize(p) {
	return p.replace(/\\/g, "/");
}

// key relative to packages/providers/src, e.g. "api/openai-responses.ts".
function aiSrcRelative(repoRelPath) {
	const n = normalize(repoRelPath);
	const m = n.match(/^packages\/providers\/src\/(.+)$/);
	return m ? m[1] : n;
}

// The single decision function. Returns an array of violation strings.
function analyzeApiFile(repoRelPath, text, whitelist) {
	const key = aiSrcRelative(repoRelPath);
	const violations = [];
	const allowed = whitelist[key]; // undefined => file not registered for any quirk

	if (PROVIDER_SWITCH.test(text)) {
		violations.push(`${key}: switch on provider — adapters must select by model.api, never by vendor name`);
	}
	const seen = new Set();
	for (const pattern of [PROVIDER_LITERAL, PROVIDER_LITERAL_REVERSED]) {
		for (const match of text.matchAll(pattern)) {
			const literal = match[1];
			if (seen.has(literal)) continue;
			seen.add(literal);
			if (!allowed) {
				violations.push(`${key}: provider === "${literal}" quirk in a non-registered adapter — dispatch is by model.api; register in scripts/adapter-provider-quirks.json only if it is a real MAJ-7 compat quirk`);
			} else if (!allowed.includes(literal)) {
				violations.push(`${key}: NEW provider === "${literal}" quirk not in the whitelist — add it to scripts/adapter-provider-quirks.json with a rationale, or select by model.api`);
			}
		}
	}
	return violations;
}

// --- filesystem ----------------------------------------------------------------------

function loadWhitelist() {
	const raw = JSON.parse(readFileSync(join(repoRoot, "scripts", "adapter-provider-quirks.json"), "utf8"));
	return raw.quirks ?? {};
}

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
	const whitelist = loadWhitelist();
	const violations = [];
	for (const file of collectTsFiles(join(repoRoot, apiDirRelative))) {
		const repoRel = relative(repoRoot, file);
		for (const violation of analyzeApiFile(repoRel, readFileSync(file, "utf8"), whitelist)) violations.push(violation);
	}
	if (violations.length > 0) {
		console.error("no-provider-dispatch check failed:");
		for (const violation of violations) console.error(`  ${violation}`);
		process.exit(1);
	}
	console.log("no-provider-dispatch check passed.");
}

// --- self-test -----------------------------------------------------------------------

function runSelfTest() {
	const failures = [];
	const wl = {
		"api/openai-responses.ts": ["openrouter", "github-copilot", "xai"],
		"api/anthropic-messages.ts": ["github-copilot", "anthropic"],
	};
	const expectClean = (path, text) => {
		if (analyzeApiFile(path, text, wl).length > 0) failures.push(`expected clean: ${path} :: ${text}`);
	};
	const expectViolation = (path, text) => {
		if (analyzeApiFile(path, text, wl).length === 0) failures.push(`expected violation: ${path} :: ${text}`);
	};

	// clean — registered quirk, registered literal (=== and !==, both operand orders)
	expectClean("packages/providers/src/api/openai-responses.ts", 'if (model.provider === "github-copilot") tune();');
	expectClean("packages/providers/src/api/openai-responses.ts", 'const x = provider === "xai" ? 1 : 0;');
	expectClean("packages/providers/src/api/anthropic-messages.ts", 'if (model.provider !== "anthropic") return false;');
	expectClean("packages/providers/src/api/openai-responses.ts", 'if ("xai" === model.provider) alt();');
	// clean — field-to-field comparison is not a quirk (no quoted literal)
	expectClean("packages/providers/src/api/anthropic-messages.ts", "if (fallback.provider === model.provider) reuse();");
	// clean — dispatch by api is the sanctioned form
	expectClean("packages/providers/src/api/openai-completions.ts", "const adapter = byApi[model.api];");

	// violation — quirk literal in a file with NO registered quirks
	expectViolation("packages/providers/src/api/pi-messages.ts", 'if (model.provider === "unknown-provider") special();');
	// violation — NEW literal not in a registered file's whitelist (=== and !==)
	expectViolation("packages/providers/src/api/openai-responses.ts", 'if (model.provider === "brand-new-vendor") hack();');
	expectViolation("packages/providers/src/api/anthropic-messages.ts", 'if (model.provider !== "brand-x") skip();');
	// violation — switch on provider selects an adapter
	expectViolation("packages/providers/src/api/openai-responses.ts", "switch (model.provider) { case 'openrouter': return a; }");

	if (failures.length > 0) {
		console.error("no-provider-dispatch self-test FAILED:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	console.log("no-provider-dispatch self-test passed.");
}

if (process.argv.includes("--self-test")) runSelfTest();
else runReal();
