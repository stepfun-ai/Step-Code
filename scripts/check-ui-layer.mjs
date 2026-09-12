#!/usr/bin/env node

// S4-1 ui-internal layer-direction check.
//
// The coarse check-layer-direction.mjs keeps the shell/UI/packages boundaries. This finer
// gate encodes the direction rule *inside* apps/<app>/src/ui, keyed off the same "#*" ->
// "./src/*.ts" mapping. The UI is stratified into four layers (top-to-bottom):
//
//   host   — apps/<app>/src/ui/*.ts at the ui root (interactive-mode.ts, index.ts door,
//            startup-ui.ts, the picker/selector helpers). The composition root / state-holder.
//   runtime— apps/<app>/src/ui/runtime/** (redraw, interrupt, input-dispatch, session-events,
//            approval, the runInteractiveRuntime root). Orchestration, no drawing.
//   view   — apps/<app>/src/ui/components/**, ui/view/**, ui/dialogs/** — components & how
//            things look. May be constructed by runtime (runtime->view is allowed).
//   state  — apps/<app>/src/ui/state/** — interface-state holders (introduced in S4-3).
//
// Allowed downward edges: host->runtime, host->view, host->state, runtime->view, runtime->state,
// runtime->runtime, view->view, view->state (leaf). Forbidden edges (this gate's job):
//   A  view    -> runtime   (view must not reach up into orchestration)
//   B  runtime -> host      (runtime must not reverse-import the ui root / state-holder;
//                            it depends on RuntimeContext defined *within* runtime instead)
//   C  runtime -> shell     (main/args/bootstrap/modes/bun — redundant with rule 2 of the
//                            coarse check, encoded here too so this gate stands alone)
//   D  state   -> runtime and state -> host and state -> view (state is a leaf)
//
// No new dependency (no eslint-plugin-boundaries / dependency-cruiser); same node+typescript
// AST walk and --self-test convention as the sibling check-*.mjs scripts.
//
// Run:  node scripts/check-ui-layer.mjs
//       node scripts/check-ui-layer.mjs --self-test

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const shellGroups = new Set(["main", "args", "bootstrap", "modes", "bun"]);
const viewDirs = new Set(["components", "view", "dialogs"]);

// --- pure classification -------------------------------------------------------------

// Path segments after "<app>/src/" for a repo-relative path under apps/<app>/src, else null.
function appSegmentsAfterSrc(repoRelPath) {
	const match = repoRelPath.replace(/\\/g, "/").match(/^apps\/[^/]+\/src\/(.+)$/);
	return match ? match[1].split("/") : null;
}

function firstSegmentBase(segments) {
	return (segments[0] ?? "").replace(/\.tsx?$/, "");
}

// Classify a file's segments-after-src into a top-level app group and, for ui files, a ui-layer.
function classify(segments) {
	if (segments[0] === "ui") {
		const rest = segments.slice(1);
		if (rest.length === 0) return { group: "ui", uiLayer: "host" };
		const head = rest[0];
		if (head === "runtime") return { group: "ui", uiLayer: "runtime" };
		if (viewDirs.has(head)) return { group: "ui", uiLayer: "view" };
		if (head === "state") return { group: "ui", uiLayer: "state" };
		// A bare file directly under ui/ (interactive-mode.ts, index.ts, startup-ui.ts, ...)
		return { group: "ui", uiLayer: "host" };
	}
	if (shellGroups.has(firstSegmentBase(segments))) return { group: "shell", uiLayer: null };
	return { group: "shared", uiLayer: null };
}

// Resolve a specifier to segments-after-src within the SAME app, or null.
function resolveInAppTarget(importerRepoRel, specifier) {
	if (specifier.startsWith("#")) {
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

// The single decision function. Returns a violation string or null.
function analyzeImport(importerRepoRel, specifier) {
	const importer = importerRepoRel.replace(/\\/g, "/");
	const importerSegments = appSegmentsAfterSrc(importer);
	if (!importerSegments) return null; // not an app source file
	const from = classify(importerSegments);
	if (from.group !== "ui") return null; // only the UI is stratified here

	const targetSegments = resolveInAppTarget(importer, specifier);
	if (!targetSegments || targetSegments.length === 0) return null;
	const to = classify(targetSegments);

	// Rule C: runtime (and any ui layer) must not reach the shell.
	if (to.group === "shell") {
		return `${importer}: ui/${from.uiLayer} must not import shell ("${specifier}") — the UI never reverse-imports the shell`;
	}

	if (to.group !== "ui") return null; // shared target — not a ui-internal edge

	// Rule A: view -> runtime.
	if (from.uiLayer === "view" && to.uiLayer === "runtime") {
		return `${importer}: ui/view must not import ui/runtime ("${specifier}") — view is below runtime, dependencies flow runtime→view`;
	}
	// Rule B: runtime -> host (the ui root / state-holder).
	if (from.uiLayer === "runtime" && to.uiLayer === "host") {
		return `${importer}: ui/runtime must not import ui host root ("${specifier}") — runtime depends on RuntimeContext, not the state-holder (runtime↛index)`;
	}
	// Rule D: state is a leaf — it imports nothing else in the ui.
	if (from.uiLayer === "state" && (to.uiLayer === "runtime" || to.uiLayer === "host" || to.uiLayer === "view")) {
		return `${importer}: ui/state must not import ui/${to.uiLayer} ("${specifier}") — state is a leaf layer`;
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

function runReal() {
	const appsDir = join(repoRoot, "apps");
	const violations = [];
	if (existsSync(appsDir)) {
		for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			for (const file of collectTsFiles(join(appsDir, entry.name, "src", "ui"))) {
				const repoRel = relative(repoRoot, file);
				for (const specifier of extractSpecifiers(readFileSync(file, "utf8"), file)) {
					const violation = analyzeImport(repoRel, specifier);
					if (violation) violations.push(violation);
				}
			}
		}
	}
	if (violations.length > 0) {
		console.error("ui-layer check failed:");
		for (const violation of violations) console.error(`  ${violation}`);
		process.exit(1);
	}
	console.log("ui-layer check passed.");
}

// --- self-test -----------------------------------------------------------------------

function runSelfTest() {
	const failures = [];
	const expectClean = (importer, specifier) => {
		if (analyzeImport(importer, specifier)) failures.push(`expected clean: ${importer} -> ${specifier}`);
	};
	const expectViolation = (importer, specifier) => {
		if (!analyzeImport(importer, specifier)) failures.push(`expected violation: ${importer} -> ${specifier}`);
	};

	// clean — allowed downward / lateral edges
	expectClean("apps/cli/src/ui/interactive-mode.ts", "./runtime/redraw.ts"); // host -> runtime
	expectClean("apps/cli/src/ui/interactive-mode.ts", "./components/footer.ts"); // host -> view
	expectClean("apps/cli/src/ui/runtime/session-events.ts", "../components/tool-execution.ts"); // runtime -> view (legal)
	expectClean("apps/cli/src/ui/runtime/session-events.ts", "./redraw.ts"); // runtime -> runtime
	expectClean("apps/cli/src/ui/runtime/session-events.ts", "./context.ts"); // runtime -> runtime (RuntimeContext)
	expectClean("apps/cli/src/ui/runtime/interrupt.ts", "../state/interface-state.ts"); // runtime -> state
	expectClean("apps/cli/src/ui/components/footer.ts", "./step-message.ts"); // view -> view
	expectClean("apps/cli/src/ui/components/footer.ts", "../state/interface-state.ts"); // view -> state
	expectClean("apps/cli/src/ui/runtime/redraw.ts", "@step-harness/pi-tui"); // runtime -> package
	expectClean("apps/cli/src/ui/runtime/index.ts", "#ui/state"); // resolves to ui/state (host-ish door), allowed

	// rule A — view importing runtime
	expectViolation("apps/cli/src/ui/components/tool-execution.ts", "../runtime/redraw.ts");
	expectViolation("apps/cli/src/ui/components/footer.ts", "#ui/runtime/session-events");
	// rule B — runtime importing the ui host root
	expectViolation("apps/cli/src/ui/runtime/session-events.ts", "../interactive-mode.ts");
	expectViolation("apps/cli/src/ui/runtime/input-dispatch.ts", "#ui/interactive-mode");
	// rule C — runtime importing the shell
	expectViolation("apps/cli/src/ui/runtime/index.ts", "#bootstrap/boot");
	expectViolation("apps/cli/src/ui/runtime/interrupt.ts", "#modes/print");
	// rule D — state reaching up
	expectViolation("apps/cli/src/ui/state/interface-state.ts", "../runtime/redraw.ts");
	expectViolation("apps/cli/src/ui/state/interface-state.ts", "../components/footer.ts");

	if (failures.length > 0) {
		console.error("ui-layer self-test FAILED:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	console.log("ui-layer self-test passed.");
}

if (process.argv.includes("--self-test")) runSelfTest();
else runReal();
