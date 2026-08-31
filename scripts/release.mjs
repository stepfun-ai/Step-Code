#!/usr/bin/env node
/**
 * Release script for the Pi workspace and the Step binary facade.
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *   node scripts/release.mjs --step <x.y.z>   # creates vX.Y.Z
 *   STEP_HARNESS_RELEASE=1 STEP_HARNESS_VERSION=<x.y.z> node scripts/release.mjs --step
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Verify every public workspace package is registered on npm
 * 3. Bump version via npm run version:xxx or set an explicit version
 * 4. Update CHANGELOG.md files: [Unreleased] -> [version] - date
 * 5. Regenerate release artifacts
 * 6. Run checks and tests
 * 7. Commit and tag the release (Pi releases use `pi-vX.Y.Z`)
 * 8. Add new [Unreleased] section to changelogs
 * 9. Commit next-cycle changelog updates
 * 10. Push main and the tag to trigger Step CI publication
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const CLI_ARGS = process.argv.slice(2);
const STEP_RELEASE_MODE =
	CLI_ARGS.includes("--step") || CLI_ARGS.some((arg) => arg.startsWith("--step=")) || isTruthy(process.env.STEP_HARNESS_RELEASE);
const RELEASE_TARGET = CLI_ARGS[0];
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const STEP_VERSION_RE = /^\d+\.\d+\.\d+$/;

if (!STEP_RELEASE_MODE && (!RELEASE_TARGET || (!BUMP_TYPES.has(RELEASE_TARGET) && !SEMVER_RE.test(RELEASE_TARGET)))) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z>");
	process.exit(1);
}

function isTruthy(value) {
	return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase());
}

function isFalsy(value) {
	return ["0", "false", "no", "off"].includes(value?.trim().toLowerCase());
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function getVersion() {
	const pkg = JSON.parse(readFileSync("packages/ai/package.json", "utf-8"));
	return pkg.version;
}

function assertPackagesAreRegisteredWithNpm() {
	const packageNames = getPublicWorkspacePackages().map((pkg) => pkg.name);
	const unregisteredPackages = [];

	console.log("Checking npm package registration...");
	for (const packageName of packageNames) {
		const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["view", packageName, "version", "--json"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});

		if (result.status === 0 && result.stdout.trim()) {
			console.log(`  ${packageName}`);
			continue;
		}

		const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
		if (output.includes("E404") || output.includes("404 Not Found")) {
			unregisteredPackages.push(packageName);
			continue;
		}

		throw new Error(output ? `Failed to query npm registration for ${packageName}\n${output}` : `Failed to query npm registration for ${packageName}`);
	}

	if (unregisteredPackages.length > 0) {
		throw new Error(`The following public workspace packages are not registered on npm:\n${unregisteredPackages.map((packageName) => `  ${packageName}`).join("\n")}\nRegister them before running a release.`);
	}

	console.log("  All public workspace packages are registered on npm\n");
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stepVersionFromValue(value, source) {
	let normalized = value?.trim();
	if (!normalized) return undefined;

	// CI variables may contain a full ref (refs/tags/v0.3.1), while release
	// operators commonly pass either v0.3.1 or step-v0.3.1. Normalize all of
	// those spellings to the product version used by the binary and tag.
	normalized = normalized.replace(/^refs\/tags\//i, "");
	normalized = normalized.replace(/^step-v/i, "");
	normalized = normalized.replace(/^step-/i, "");
	normalized = normalized.replace(/^v/i, "");

	if (!STEP_VERSION_RE.test(normalized)) {
		throw new Error(`Invalid Step release version from ${source}: ${value}`);
	}

	return normalized;
}

function resolveStepReleaseVersion(args) {
	const inlineStepArg = args.find((arg) => arg.startsWith("--step="));
	const stepIndex = args.indexOf("--step");
	const positional = args.filter((arg) => !arg.startsWith("--"));
	const cliValue = inlineStepArg?.slice("--step=".length) ||
		(stepIndex >= 0 && args[stepIndex + 1] && !args[stepIndex + 1].startsWith("--")
			? args[stepIndex + 1]
			: positional[0]);

	if (positional.length > 1) {
		throw new Error("Step release accepts one version argument");
	}

	const candidates = [
		[cliValue, "command line"],
		[process.env.STEP_HARNESS_VERSION, "STEP_HARNESS_VERSION"],
		[process.env.STEP_HARNESS_RELEASE_VERSION, "STEP_HARNESS_RELEASE_VERSION"],
		[process.env.STEP_HARNESS_VERSION_OVERRIDE, "STEP_HARNESS_VERSION_OVERRIDE"],
		[process.env.GITHUB_REF_NAME, "GITHUB_REF_NAME"],
		[process.env.CI_COMMIT_TAG, "CI_COMMIT_TAG"],
		[process.env.RELEASE_TAG, "RELEASE_TAG"],
		[readRootPackageVersion(), "root package.json"],
	];

	for (const [value, source] of candidates) {
		if (value?.trim()) return stepVersionFromValue(value, source);
	}

	throw new Error(
		"Step release requires a version. Pass --step <x.y.z> or set STEP_HARNESS_VERSION.",
	);
}

function readRootPackageVersion() {
	try {
		const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
		return typeof packageJson.version === "string" ? packageJson.version : undefined;
	} catch {
		return undefined;
	}
}

function assertCleanWorkingTree() {
	const status = run("git status --porcelain", { silent: true });
	if (status && status.trim()) {
		throw new Error(`Uncommitted changes detected. Commit or stash first.\n${status.trim()}`);
	}
}

function localTagExists(tag) {
	const result = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], {
		encoding: "utf8",
		stdio: "ignore",
	});
	if (result.status === 0) return true;
	if (result.status === 1) return false;
	throw new Error(`Unable to inspect local Git tags (exit ${result.status ?? "unknown"})`);
}

function remoteTagExists(tag) {
	const result = spawnSync("git", ["ls-remote", "--refs", "origin", `refs/tags/${tag}`], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		const detail = [result.stderr, result.error?.message].filter(Boolean).join("\n").trim();
		throw new Error(detail || `Unable to inspect tags on remote origin (exit ${result.status ?? "unknown"})`);
	}
	return Boolean(result.stdout?.trim());
}

function runStepRelease(args) {
	const version = resolveStepReleaseVersion(args);
	// Step follows the legacy Step CLI release convention: the product tag is
	// the ordinary `vX.Y.Z` spelling. The upstream Pi workflow is isolated on
	// `pi-v*`, so one tag cannot start two competing release jobs.
	const tag = `v${version}`;
	const dryRun = args.includes("--dry-run") || isTruthy(process.env.STEP_HARNESS_RELEASE_DRY_RUN);
	const push = !isFalsy(process.env.STEP_HARNESS_RELEASE_PUSH);

	console.log("\n=== Step Release Script ===\n");
	console.log(`  Step version: ${version}`);
	console.log(`  Git tag: ${tag}`);
	console.log(`  Push tag: ${push ? "yes" : "no"}`);

	console.log("Checking for uncommitted changes...");
	try {
		assertCleanWorkingTree();
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	console.log("  Working directory clean\n");

	if (localTagExists(tag)) {
		console.error(`Error: local tag ${tag} already exists.`);
		process.exit(1);
	}

	// Avoid creating a local tag that can never be pushed. Skip remote access in
	// dry-run mode so operators can preview a release offline.
	if (push && !dryRun && remoteTagExists(tag)) {
		console.error(`Error: remote tag origin/${tag} already exists.`);
		process.exit(1);
	}

	if (dryRun) {
		console.log(`[dry-run] Would create tag ${tag} at HEAD.`);
		if (push) console.log(`[dry-run] Would push ${tag} to origin.`);
		return;
	}

	run(`git tag ${shellQuote(tag)}`);
	if (push) {
		run(`git push origin ${shellQuote(tag)}`);
	} else {
		console.log("Skipping push (STEP_HARNESS_RELEASE_PUSH is disabled).");
	}

	console.log(`\n=== Prepared Step release ${tag}; binary CI starts after the tag push ===`);
}

function removeStaleWorkspaceLockEntries() {
	const workspaceVersions = new Map(
		getPublicWorkspacePackages().map((pkg) => [pkg.name, pkg.version]),
	);
	const lockPath = "package-lock.json";
	const lock = JSON.parse(readFileSync(lockPath, "utf8"));
	let removed = 0;

	for (const [path, pkg] of Object.entries(lock.packages)) {
		if (!path.startsWith("packages/") || pkg.link === true) {
			continue;
		}
		for (const [name, version] of workspaceVersions) {
			if (path.endsWith(`/node_modules/${name}`) && pkg.version !== version) {
				delete lock.packages[path];
				removed++;
				break;
			}
		}
	}

	if (removed > 0) {
		writeFileSync(lockPath, `${JSON.stringify(lock, null, "\t")}\n`);
		console.log(`Removed ${removed} stale workspace package lock ${removed === 1 ? "entry" : "entries"}.`);
	}
}

function stageChangedFiles() {
	const output = run("git ls-files -m -o -d --exclude-standard", { silent: true });
	const paths = [...new Set((output || "").split("\n").map((line) => line.trim()).filter(Boolean))];
	if (paths.length === 0) {
		return;
	}

	run(`git add -- ${paths.map(shellQuote).join(" ")}`);
}

function bumpOrSetVersion(target) {
	const currentVersion = getVersion();

	if (BUMP_TYPES.has(target)) {
		console.log(`Bumping version (${target})...`);
		run(`npm run version:${target}`);
	} else {
		if (compareVersions(target, currentVersion) <= 0) {
			console.error(`Error: explicit version ${target} must be greater than current version ${currentVersion}.`);
			process.exit(1);
		}

		console.log(`Setting explicit version (${target})...`);
		run(`npm version ${target} --workspaces --no-git-tag-version --no-workspaces-update && node scripts/sync-versions.js && npm install --package-lock-only --ignore-scripts`);
	}

	// npm version can temporarily install the previous workspace versions before
	// sync-versions updates inter-package ranges. Remove those stale lock entries,
	// refresh the lockfile, then hydrate from the final dependency graph.
	removeStaleWorkspaceLockEntries();
	run("npm install --package-lock-only --ignore-scripts");
	run("npm ci --ignore-scripts");
	return getVersion();
}

function getChangelogs() {
	return findPackageDirectories()
		.map((directory) => join(directory, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		const updated = content.replace(
			"## [Unreleased]",
			`## [${version}] - ${date}`
		);
		writeFileSync(changelog, updated);
		console.log(`  Updated ${changelog}`);
	}
}

function addUnreleasedSection() {
	const changelogs = getChangelogs();
	const unreleasedSection = "## [Unreleased]\n\n";

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		// Insert after "# Changelog\n\n"
		const updated = content.replace(
			/^(# Changelog\n\n)/,
			`$1${unreleasedSection}`
		);
		writeFileSync(changelog, updated);
		console.log(`  Added [Unreleased] to ${changelog}`);
	}
}

if (STEP_RELEASE_MODE) {
	runStepRelease(CLI_ARGS);
	process.exit(0);
}

// Main flow
console.log("\n=== Release Script ===\n");

// 1. Check for uncommitted changes
console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// 2. Verify npm package registration before modifying the worktree.
assertPackagesAreRegisteredWithNpm();

// 3. Bump or set version
const version = bumpOrSetVersion(RELEASE_TARGET);
console.log(`  New version: ${version}\n`);

// 4. Update changelogs
console.log("Updating CHANGELOG.md files...");
updateChangelogsForRelease(version);
console.log();

// 5. Regenerate release artifacts
console.log("Regenerating release artifacts...");
run("npm run generate:models");
run("npm run check:model-data");
run("npm run shrinkwrap:coding-agent");
run("npm run install-lock:coding-agent");
console.log();

// 6. Run checks and tests
console.log("Running checks...");
run("npm run check");
console.log();

console.log("Building packages for tests...");
run("npm run build:offline");
console.log();

console.log("Running tests...");
run("./test.sh");
console.log();

// 7. Commit and tag
console.log("Committing and tagging...");
stageChangedFiles();
run(`git commit -m "Release Pi v${version}"`);
run(`git tag pi-v${version}`);
console.log();

// 8. Add new [Unreleased] sections
console.log("Adding [Unreleased] sections for next cycle...");
addUnreleasedSection();
console.log();

// 9. Commit
console.log("Committing changelog updates...");
stageChangedFiles();
run(`git commit -m "Add [Unreleased] section for next cycle"`);
console.log();

// 10. Push
console.log("Pushing to remote...");
run("git push origin main");
run(`git push origin pi-v${version}`);
console.log();

console.log(`=== Prepared Pi release pi-v${version}; Pi CI publication starts after the tag push ===`);
