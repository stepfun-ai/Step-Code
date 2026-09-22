import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"];
const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ignoredDirectories = new Set([".git", ".claude", ".worktrees", ".artifacts", "dist", "node_modules", "binaries"]);
const packageJsonFiles = [];

function collectPackageJsonFiles(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) {
				collectPackageJsonFiles(join(directory, entry.name));
			}
			continue;
		}

		if (entry.isFile() && entry.name === "package.json") {
			packageJsonFiles.push(join(directory, entry.name));
		}
	}
}

function isInternalWorkspaceDependency(name) {
	return name.startsWith("@step-harness/");
}

function isNonRegistrySpecifier(specifier) {
	return /^(?:workspace:|file:|link:|portal:|git\+|github:|git:|https?:|ssh:|git:\/\/)/.test(specifier);
}

function getVersionSpecifier(specifier) {
	if (!specifier.startsWith("npm:")) return specifier;
	const aliasTarget = specifier.slice("npm:".length);
	const versionSeparator = aliasTarget.lastIndexOf("@");
	if (versionSeparator <= 0) return specifier;
	return aliasTarget.slice(versionSeparator + 1);
}

// Classify a single (name, specifier) pair exactly as the scan loop below does.
// Kept as a named predicate so the --self-test branch can verify the logic.
function classifyDependency(name, specifier) {
	if (isInternalWorkspaceDependency(name) || isNonRegistrySpecifier(specifier)) return "skip";
	return exactVersionPattern.test(getVersionSpecifier(specifier)) ? "pinned" : "violation";
}

// --- self-test ---------------------------------------------------------------------------
// Exercises the pin classification against known cases so the guard is verified in CI (via
// `node --test scripts/*.test.mjs`). Runs before the repo scan and exits, so normal
// invocation is unaffected.
if (process.argv.includes("--self-test")) {
	const failures = [];
	const expect = (actual, expected, label) => {
		if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
	};

	expect(classifyDependency("lodash", "4.17.21"), "pinned", "exact version");
	expect(classifyDependency("prerelease", "1.2.3-beta.1"), "pinned", "exact prerelease");
	expect(classifyDependency("aliased", "npm:left-pad@1.3.0"), "pinned", "npm alias exact");
	expect(classifyDependency("lodash", "^4.17.21"), "violation", "caret range");
	expect(classifyDependency("lodash", "~4.17.21"), "violation", "tilde range");
	expect(classifyDependency("lodash", "4.x"), "violation", "wildcard range");
	expect(classifyDependency("aliased", "npm:left-pad@^1.3.0"), "violation", "npm alias range");
	expect(classifyDependency("@step-harness/providers", "^1.0.0"), "skip", "internal workspace dep");
	expect(classifyDependency("dep", "workspace:*"), "skip", "workspace protocol");
	expect(classifyDependency("dep", "file:../local"), "skip", "file protocol");

	if (failures.length > 0) {
		console.error("pinned-deps self-test FAILED:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	console.log("pinned-deps self-test passed.");
	process.exit(0);
}

const failures = [];

collectPackageJsonFiles(".");

for (const file of packageJsonFiles.sort()) {
	const packageJson = JSON.parse(readFileSync(file, "utf8"));

	for (const section of dependencySections) {
		const dependencies = packageJson[section];
		if (!dependencies) continue;

		for (const [name, specifier] of Object.entries(dependencies)) {
			if (isInternalWorkspaceDependency(name) || isNonRegistrySpecifier(specifier)) continue;
			if (exactVersionPattern.test(getVersionSpecifier(specifier))) continue;
			failures.push(`${file}: ${section}.${name} must be pinned, found ${specifier}`);
		}
	}
}

if (failures.length > 0) {
	console.error("Direct external dependencies must use exact versions:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
