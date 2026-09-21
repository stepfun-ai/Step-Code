#!/usr/bin/env node

/**
 * Create a Step CLI binary release tag.
 *
 * Usage:
 *   node scripts/release.mjs --step <x.y.z>
 *   STEP_CLI_RELEASE=1 STEP_CLI_VERSION=<x.y.z> node scripts/release.mjs --step
 *
 * The binary build, checksum manifest, object-store upload, and GitLab Release
 * are handled by infra/release/release-bundle.mjs and .gitlab-ci.yml after the
 * tag is pushed. This script intentionally has no npm publication path.
 */

import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CLI_ARGS = process.argv.slice(2);
const STEP_RELEASE_MODE =
	CLI_ARGS.includes("--step") ||
	CLI_ARGS.some((arg) => arg.startsWith("--step=")) ||
	isTruthy(process.env.STEP_CLI_RELEASE);
const STEP_VERSION_RE = /^\d+\.\d+\.\d+$/;

if (!STEP_RELEASE_MODE) {
	console.error("Only Step binary releases are supported. Use: node scripts/release.mjs --step <x.y.z>");
	process.exit(1);
}

function isTruthy(value) {
	return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase());
}

function isFalsy(value) {
	return ["0", "false", "no", "off"].includes(value?.trim().toLowerCase());
}

function run(command, options = {}) {
	console.log(`$ ${command}`);
	try {
		return execSync(command, {
			encoding: "utf8",
			stdio: options.silent ? "pipe" : "inherit",
			...options,
		});
	} catch (error) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${command}`);
			process.exit(1);
		}
		return null;
	}
}

function shellQuote(value) {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function normalizeStepVersion(value, source) {
	let normalized = value?.trim();
	if (!normalized) return undefined;

	// CI variables may contain a full ref; operators may pass vX.Y.Z or
	// step-vX.Y.Z. Normalize all supported spellings to the binary version.
	normalized = normalized.replace(/^refs\/tags\//iu, "");
	normalized = normalized.replace(/^step-v/iu, "");
	normalized = normalized.replace(/^step-/iu, "");
	normalized = normalized.replace(/^v/iu, "");
	if (!STEP_VERSION_RE.test(normalized)) {
		throw new Error(`Invalid Step release version from ${source}: ${value}`);
	}
	return normalized;
}

function readRootPackageVersion() {
	try {
		const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
		return typeof packageJson.version === "string" ? packageJson.version : undefined;
	} catch {
		return undefined;
	}
}

function resolveStepReleaseVersion(args) {
	const inlineStepArg = args.find((arg) => arg.startsWith("--step="));
	const stepIndex = args.indexOf("--step");
	const positional = args.filter((arg) => !arg.startsWith("--"));
	const cliValue =
		inlineStepArg?.slice("--step=".length) ||
		(stepIndex >= 0 && args[stepIndex + 1] && !args[stepIndex + 1].startsWith("--")
			? args[stepIndex + 1]
			: positional[0]);

	if (positional.length > 1) throw new Error("Step release accepts one version argument");

	const candidates = [
		[cliValue, "command line"],
		[process.env.STEP_CLI_VERSION, "STEP_CLI_VERSION"],
		[process.env.STEP_CLI_RELEASE_VERSION, "STEP_CLI_RELEASE_VERSION"],
		[process.env.STEP_CLI_VERSION_OVERRIDE, "STEP_CLI_VERSION_OVERRIDE"],
		[process.env.GITHUB_REF_NAME, "GITHUB_REF_NAME"],
		[process.env.CI_COMMIT_TAG, "CI_COMMIT_TAG"],
		[process.env.RELEASE_TAG, "RELEASE_TAG"],
		[readRootPackageVersion(), "root package.json"],
	];

	for (const [value, source] of candidates) {
		if (value?.trim()) return normalizeStepVersion(value, source);
	}
	throw new Error("Step release requires a version. Pass --step <x.y.z> or set STEP_CLI_VERSION.");
}

function assertCleanWorkingTree() {
	const status = run("git status --porcelain", { silent: true });
	if (status?.trim()) {
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
	const tag = `v${version}`;
	const dryRun = args.includes("--dry-run") || isTruthy(process.env.STEP_CLI_RELEASE_DRY_RUN);
	const push = !isFalsy(process.env.STEP_CLI_RELEASE_PUSH);

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
	if (push) run(`git push origin ${shellQuote(tag)}`);
	else console.log("Skipping push (STEP_CLI_RELEASE_PUSH is disabled).");

	console.log(`\n=== Prepared Step release ${tag}; binary CI starts after the tag push ===`);
}

runStepRelease(CLI_ARGS);
