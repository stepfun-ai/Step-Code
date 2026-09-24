#!/usr/bin/env node

// Public-source boundary check.
//
// The public branch is allowed to build local artifacts, but it must not carry
// the private repository's CI, release publication, or planning surface. This
// guard scans the tracked tree (the same view a fresh checkout receives), so a
// staged deletion is immediately reflected in the result.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guardPath = "scripts/check-public-boundary.mjs";
const publicGuardPaths = new Set([guardPath, "scripts/check-no-observability.mjs"]);

const FORBIDDEN_PATHS = [
	/^\.gitlab-ci\.yml$/u,
	/^\.gitlab\//u,
	/^docs\/exec-plans\//u,
	/^docs\/improvement-plan\.md$/u,
	/^infra\/release\/next-version\.mjs$/u,
	/^infra\/release\/tag-release\.mjs$/u,
	/^scripts\/publish-model-catalog\.mjs$/u,
	/^scripts\/publish-release-announcement(?:\.test)?\.mjs$/u,
	/^scripts\/release-packages\.mjs$/u,
	/^scripts\/release\.mjs$/u,
	/^scripts\/release-step\.test\.mjs$/u,
];

const FORBIDDEN_TEXT = [
	{ label: "self-hosted source control", pattern: /(?:git@|https?:\/\/|ssh:\/\/git@)gitlab\.(?!com(?:[\/:]|$))/iu },
	{ label: "private infrastructure hostname", pattern: /https?:\/\/(?:[^/\s]+\.)+\b(?:internal|corp|local)(?:[/:]|$)/iu },
	{ label: "GitLab API variable", pattern: /\b(?:CI_API_V4_URL|CI_PROJECT_ID)\b/u },
	{ label: "private object-store variable", pattern: /\bSTEP_TOS_[A-Z0-9_]+\b/u },
	{ label: "private object-store SDK", pattern: /@volcengine\/tos-sdk/u },
];

function normalize(value) {
	return value.replaceAll("\\", "/");
}

function trackedFiles() {
	const output = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot });
	return output
		.toString("utf8")
		.split("\0")
		.filter(Boolean)
		.map(normalize);
}

export function analyzeTrackedFile(repoPath, text) {
	const normalizedPath = normalize(repoPath);
	if (publicGuardPaths.has(normalizedPath)) return [];
	const violations = [];
	for (const pattern of FORBIDDEN_PATHS) {
		if (pattern.test(normalizedPath)) {
			violations.push(`${normalizedPath}: forbidden public-boundary path`);
			break;
		}
	}
	for (const { label, pattern } of FORBIDDEN_TEXT) {
		if (pattern.test(text)) violations.push(`${normalizedPath}: ${label}`);
	}
	return violations;
}

function runReal() {
	const violations = [];
	for (const repoPath of trackedFiles()) {
		if (repoPath === guardPath) continue;
		const absolutePath = path.join(repoRoot, repoPath);
		// A deleted tracked path is already absent from the public working tree;
		// do not turn an intentional deletion into a false-positive read error.
		if (!existsSync(absolutePath)) continue;
		let text;
		text = readFileSync(absolutePath, "utf8");
		violations.push(...analyzeTrackedFile(repoPath, text));
	}
	if (violations.length > 0) {
		console.error("public-boundary check failed:");
		for (const violation of violations) console.error(`  ${violation}`);
		process.exit(1);
	}
	console.log("public-boundary check passed.");
}

function runSelfTest() {
	const failures = [];
	const expectClean = (repoPath, text) => {
		if (analyzeTrackedFile(repoPath, text).length > 0) failures.push(`expected clean: ${repoPath}`);
	};
	const expectViolation = (repoPath, text) => {
		if (analyzeTrackedFile(repoPath, text).length === 0) failures.push(`expected violation: ${repoPath}`);
	};

	expectClean("README.md", "Public builds create local artifacts only.");
	for (const exemptPath of publicGuardPaths) {
		expectClean(exemptPath, "https://gitlab.example.invalid CI_PROJECT_ID");
	}
	expectViolation(".gitlab-ci.yml", "stages: [.pre]");
	expectViolation("docs/improvement-plan.md", "internal planning notes");
	expectViolation("docs/public.md", "https://gitlab.example.invalid/example/project");
	expectViolation("infra/release/private.mjs", "process.env.CI_API_V4_URL");
	expectViolation("scripts/private.mjs", "STEP_TOS_BUCKET");
	expectViolation("scripts/private.mjs", "@volcengine/tos-sdk");

	if (failures.length > 0) {
		console.error("public-boundary self-test FAILED:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	console.log("public-boundary self-test passed.");
}

if (process.argv.includes("--self-test")) runSelfTest();
else runReal();
