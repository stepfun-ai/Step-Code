#!/usr/bin/env node

// S0-3 layer-direction check.
//
// Enforces the "依赖只许自上而下" rule between the three layers, keyed off the app-internal
// absolute import prefix "#" (apps/cli/package.json maps "#*" -> "./src/*.ts", so "#ui/index"
// means apps/<app>/src/ui/index.ts). Rules:
//   1  app shell/shared may reach the UI only through the single door "#ui/index" (or "#ui");
//      importing any deeper "#ui/..." internal is forbidden.
//   2  the UI (apps/<app>/src/ui/**) must not reverse-import the shell (main/args/bootstrap/modes/bun).
//   3  capability packages (packages/**) must not import an app package (@step-harness/<app>).
//   4  extensions (packages/extensions/*/src/**) must not import an app package.
//
// apps/cli currently has no ui/ or shell subdirs, so the real scan finds nothing to flag yet —
// the rules are in place for steps 3/4. The --self-test exercises every rule with synthetic
// (importer, specifier) pairs (no fixture files: an app-internal fixture would have to live under
// apps/<app>/src and would then be compiled/linted by the real gate).
//
// Run:  node scripts/check-layer-direction.mjs
//       node scripts/check-layer-direction.mjs --self-test

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const shellGroups = new Set(["main", "args", "bootstrap", "modes", "bun"]);

// --- pure classification -------------------------------------------------------------

// Path segments after "<app>/src/" for a repo-relative path under apps/<app>/src, else null.
function appSegmentsAfterSrc(repoRelPath) {
	const match = repoRelPath.replace(/\\/g, "/").match(/^apps\/[^/]+\/src\/(.+)$/);
	return match ? match[1].split("/") : null;
}

function firstSegmentBase(segments) {
	return (segments[0] ?? "").replace(/\.tsx?$/, "");
}

function groupOfSegments(segments) {
	if (segments[0] === "ui") {
		const rest = segments.slice(1).map((s) => s.replace(/\.tsx?$/, ""));
		const isDoor = rest.length === 0 || (rest.length === 1 && (rest[0] === "index" || rest[0] === ""));
		return { group: "ui", isDoor };
	}
	if (shellGroups.has(firstSegmentBase(segments))) return { group: "shell", isDoor: false };
	return { group: "shared", isDoor: false };
}

// Resolve a specifier to segments-after-src within the SAME app, or null.
function resolveInAppTarget(importerRepoRel, specifier) {
	if (specifier.startsWith("#")) {
		// form B: "#seg/rest" -> apps/<app>/src/seg/rest
		return specifier.slice(1).split("/").filter(Boolean);
	}
	if (specifier.startsWith(".")) {
		const importerAppSrc = importerRepoRel.replace(/\\/g, "/").match(/^(apps\/[^/]+\/src)\//);
		if (!importerAppSrc) return null;
		const abs = resolve(repoRoot, dirname(importerRepoRel), specifier);
		const rel = relative(repoRoot, abs).replace(/\\/g, "/");
		return appSegmentsAfterSrc(rel);
	}
	return null; // bare package specifier — not an in-app target
}

function appPackageMatch(specifier, appPackageNames) {
	return appPackageNames.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

// The single decision function. Returns a violation string or null.
function analyzeImport(importerRepoRel, specifier, ctx) {
	const importer = importerRepoRel.replace(/\\/g, "/");

	// Rules 3 & 4: capability packages / extensions must not import an app package.
	if (importer.startsWith("packages/")) {
		if (appPackageMatch(specifier, ctx.appPackageNames)) {
			const layer = importer.startsWith("packages/extensions/") ? "extension" : "capability package";
			return `${importer}: ${layer} must not import app package "${specifier}" (dependencies only flow top-down)`;
		}
		return null;
	}

	// Rules 1 & 2: app-internal direction.
	const importerSegments = appSegmentsAfterSrc(importer);
	if (!importerSegments) return null; // not an app source file
	const importerGroup = groupOfSegments(importerSegments).group;
	const targetSegments = resolveInAppTarget(importer, specifier);
	if (!targetSegments || targetSegments.length === 0) return null;
	const target = groupOfSegments(targetSegments);

	if (importerGroup !== "ui" && target.group === "ui" && !target.isDoor) {
		return `${importer}: ${importerGroup} imports UI internal "${specifier}" — the UI is only reachable through "#ui/index"`;
	}
	if (importerGroup === "ui" && target.group === "shell") {
		return `${importer}: UI must not reverse-import the shell ("${specifier}")`;
	}
	return null;
}

// --- filesystem ----------------------------------------------------------------------

function extractSpecifiers(sourceText, fileName) {
	const specifiers = [];
	const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
	const visit = (node) => {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
			specifiers.push(node.moduleSpecifier.text);
		}
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const [arg] = node.arguments;
			if (arg && ts.isStringLiteralLike(arg)) specifiers.push(arg.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return specifiers;
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

function discoverAppPackageNames() {
	const appsDir = join(repoRoot, "apps");
	if (!existsSync(appsDir)) return [];
	const names = [];
	for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
		const manifest = join(appsDir, entry.name, "package.json");
		if (entry.isDirectory() && existsSync(manifest)) names.push(JSON.parse(readFileSync(manifest, "utf8")).name);
	}
	return names;
}

function runReal() {
	const ctx = { appPackageNames: discoverAppPackageNames() };
	const roots = ["apps", "packages"].map((r) => join(repoRoot, r));
	const violations = [];
	for (const root of roots) {
		for (const file of collectTsFiles(root)) {
			const repoRel = relative(repoRoot, file);
			for (const specifier of extractSpecifiers(readFileSync(file, "utf8"), file)) {
				const violation = analyzeImport(repoRel, specifier, ctx);
				if (violation) violations.push(violation);
			}
		}
	}
	if (violations.length > 0) {
		console.error("layer-direction check failed:");
		for (const violation of violations) console.error(`  ${violation}`);
		process.exit(1);
	}
	console.log("layer-direction check passed.");
}

// --- self-test -----------------------------------------------------------------------

function runSelfTest() {
	const ctx = { appPackageNames: ["@step-harness/cli"] };
	const failures = [];
	const expectClean = (importer, specifier) => {
		if (analyzeImport(importer, specifier, ctx)) failures.push(`expected clean: ${importer} -> ${specifier}`);
	};
	const expectViolation = (importer, specifier) => {
		if (!analyzeImport(importer, specifier, ctx)) failures.push(`expected violation: ${importer} -> ${specifier}`);
	};

	// clean
	expectClean("apps/cli/src/main.ts", "#version");
	expectClean("apps/cli/src/index.ts", "#main");
	expectClean("apps/cli/src/bootstrap/boot.ts", "#ui/index");
	expectClean("apps/cli/src/ui/view/transcript.ts", "#ui/state");
	expectClean("apps/cli/src/ui/runtime/loop.ts", "./redraw.ts");
	expectClean("apps/cli/src/bootstrap/boot.ts", "@step-harness/coding-agent");
	expectClean("packages/coding-agent/src/x.ts", "@step-harness/providers");

	// rule 1 — shell/shared reaching into UI internals
	expectViolation("apps/cli/src/bootstrap/boot.ts", "#ui/runtime/loop");
	expectViolation("apps/cli/src/main.ts", "#ui/view/transcript");
	// rule 2 — UI reverse-importing the shell
	expectViolation("apps/cli/src/ui/view/x.ts", "#bootstrap/boot");
	expectViolation("apps/cli/src/ui/runtime/loop.ts", "#modes/print");
	// rule 3 — capability package importing an app
	expectViolation("packages/coding-agent/src/x.ts", "@step-harness/cli");
	expectViolation("packages/tui/src/x.ts", "@step-harness/cli/runtime");
	// rule 4 — extension importing an app
	expectViolation("packages/extensions/example/src/x.ts", "@step-harness/cli");

	if (failures.length > 0) {
		console.error("layer-direction self-test FAILED:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	console.log("layer-direction self-test passed.");
}

if (process.argv.includes("--self-test")) runSelfTest();
else runReal();
