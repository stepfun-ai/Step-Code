#!/usr/bin/env node

// S0-5 "tui stays a pure renderer" check.
//
// packages/tui must have ZERO AI dependency — no workspace-internal package (especially
// contracts/ai), and no LLM/AI SDK — in either its manifest or its source imports.
//   - manifest: runtime `dependencies` must be a subset of the renderer allowlist;
//     no section may reference an internal workspace scope or an AI SDK.
//   - source:   no packages/tui/src import may resolve to an internal scope or AI SDK.
//
// Run:  node scripts/check-tui-no-ai.mjs
//       node scripts/check-tui-no-ai.mjs --self-test

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "..");
const tuiManifestPath = join(repoRoot, "packages", "tui", "package.json");
const tuiSourceRoot = join(repoRoot, "packages", "tui", "src");
const fixtureDirectory = join(scriptDirectory, "__fixtures__", "tui-no-ai");

// Terminal / typesetting libraries the renderer is allowed to depend on at runtime.
const runtimeAllowlist = new Set(["get-east-asian-width", "marked"]);
// Internal workspace scopes are forbidden anywhere in the renderer.
const internalScopes = ["@earendil-works/", "@step-harness/"];
// Known AI/LLM SDKs (exact names or scope prefixes) forbidden anywhere in the renderer.
const aiPackages = new Set(["openai", "cohere-ai", "@mistralai/mistralai", "groq-sdk", "ollama"]);
const aiScopes = ["@anthropic-ai/", "@google/generative", "@google-cloud/vertexai", "@aws-sdk/client-bedrock", "@modelcontextprotocol/", "langchain"];

// --- pure helpers --------------------------------------------------------------------

function isInternal(name) {
	return internalScopes.some((scope) => name.startsWith(scope));
}

function isAi(name) {
	if (aiPackages.has(name)) return true;
	return aiScopes.some((scope) => name.startsWith(scope));
}

function bareModule(specifier) {
	if (specifier.startsWith(".") || specifier.startsWith("#") || specifier.startsWith("node:")) return undefined;
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

function checkManifest(manifest) {
	const violations = [];
	const runtime = manifest.dependencies ?? {};
	for (const name of Object.keys(runtime)) {
		if (!runtimeAllowlist.has(name)) {
			violations.push(`dependencies."${name}" is not in the tui renderer allowlist {${[...runtimeAllowlist].join(", ")}} — tui must stay a pure renderer`);
		}
	}
	for (const section of ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]) {
		for (const name of Object.keys(manifest[section] ?? {})) {
			if (isInternal(name)) violations.push(`${section}."${name}" pulls a workspace-internal package into tui`);
			else if (isAi(name)) violations.push(`${section}."${name}" is an AI SDK — forbidden in tui`);
		}
	}
	return violations;
}

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

function checkSourceImports(sourceFiles) {
	const violations = [];
	for (const { file, text } of sourceFiles) {
		for (const specifier of extractSpecifiers(text, file)) {
			const mod = bareModule(specifier);
			if (!mod) continue;
			if (isInternal(mod)) violations.push(`${file} imports workspace-internal "${specifier}" — tui must not depend on Agent-side packages`);
			else if (isAi(mod)) violations.push(`${file} imports AI SDK "${specifier}"`);
		}
	}
	return violations;
}

// --- filesystem ----------------------------------------------------------------------

function collectTsFiles(directory) {
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules" && entry.name !== "dist") walk(full);
			} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
				files.push({ file: full, text: readFileSync(full, "utf8") });
			}
		}
	};
	walk(directory);
	return files;
}

function runReal() {
	const manifest = JSON.parse(readFileSync(tuiManifestPath, "utf8"));
	const violations = [...checkManifest(manifest), ...checkSourceImports(collectTsFiles(tuiSourceRoot))];
	if (violations.length > 0) {
		console.error("tui zero-AI-dependency check failed:");
		for (const violation of violations) console.error(`  ${violation}`);
		process.exit(1);
	}
	console.log("tui zero-AI-dependency check passed.");
}

// --- self-test -----------------------------------------------------------------------

function runSelfTest() {
	const failures = [];
	const expect = (label, condition) => {
		if (!condition) failures.push(label);
	};

	const goodManifest = JSON.parse(readFileSync(join(fixtureDirectory, "good-package.json"), "utf8"));
	const badManifest = JSON.parse(readFileSync(join(fixtureDirectory, "bad-package.json"), "utf8"));
	const goodSrc = [{ file: "good-src.ts", text: readFileSync(join(fixtureDirectory, "good-src.ts"), "utf8") }];
	const badSrc = [{ file: "bad-src.ts", text: readFileSync(join(fixtureDirectory, "bad-src.ts"), "utf8") }];

	expect("good manifest passes", checkManifest(goodManifest).length === 0);
	expect("good source passes", checkSourceImports(goodSrc).length === 0);

	const badManifestViolations = checkManifest(badManifest);
	expect("bad manifest flags AI dep", badManifestViolations.some((v) => v.includes("openai") || v.includes("@anthropic-ai/")));
	expect("bad manifest flags internal dep", badManifestViolations.some((v) => v.includes("@step-harness/") || v.includes("@earendil-works/")));

	const badSrcViolations = checkSourceImports(badSrc);
	expect("bad source flags AI import", badSrcViolations.length > 0);

	if (failures.length > 0) {
		console.error("tui zero-AI-dependency self-test FAILED:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	console.log("tui zero-AI-dependency self-test passed.");
}

if (process.argv.includes("--self-test")) runSelfTest();
else runReal();
