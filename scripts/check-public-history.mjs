#!/usr/bin/env node

// Pre-publication boundary check.
//
// Unlike check-public-boundary.mjs, this guard inspects every object reachable
// from every approved ref. Run it in a clean clone with an explicit ref
// allowlist, for example:
//
//   node scripts/check-public-history.mjs \
//     --allow-ref refs/heads/github-opensource \
//     --allow-ref refs/remotes/origin/github-opensource
//
// The checker reports labels and paths only. It never prints matching secret
// values or blob contents.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const guardPath = "scripts/check-public-history.mjs";
const publicGuardPaths = new Set([guardPath, "scripts/check-public-boundary.mjs"]);

const FORBIDDEN_PATHS = [
	{ label: "GitLab CI configuration", pattern: /^\.gitlab(?:-|\/|$)/u },
	{ label: "private .pi resource", pattern: /^\.pi(?:\/|$)/u },
	{ label: "execution plan", pattern: /^docs\/exec-plans(?:\/|$)/u },
	{ label: "issue analysis workflow", pattern: /^\.github\/workflows\/issue-analysis\.yml$/u },
	{ label: "private release workflow", pattern: /^\.github\/workflows\/.*(?:release|publish).*$/iu },
	{ label: "private release helper", pattern: /^infra\/release\/(?:next-version|tag-release)\.mjs$/u },
	{ label: "private publication helper", pattern: /^scripts\/(?:publish-model-catalog|publish-release-announcement(?:\.test)?|release-packages|release|release-step\.test)\.mjs$/u },
	{ label: "session sharing implementation", pattern: /(?:^|\/)session-share\.ts$/u },
	{ label: "debug or screenshot artifact", pattern: /(?:^|\/)(?:screenshots?|debug(?:-|_|\.)).*$/iu },
];

const FORBIDDEN_TEXT = [
	{ label: "private GitLab host", pattern: /gitlab\.basemind\.com/iu },
	{ label: "private Step host", pattern: /(?:stepfun-inc\.(?:net|com)|(?:[a-z0-9-]+\.)?(?:ivolces|volces)\.com)/iu },
	{ label: "release webhook credential name", pattern: /\bSTEP_RELEASE_BOT_WEBHOOK_TOKEN\b/u },
	{ label: "agent workflow credential name", pattern: /\b(?:PI_GIST_TOKEN|PI_AUTH_JSON|PI_AUTH_UPDATE_TOKEN)\b/u },
	{ label: "private project identifier", pattern: /projects\/10933/u },
	{ label: "agent stealth compatibility", pattern: /\b(?:stealth mode|claudeCodeTools|fromClaudeCodeName|toClaudeCodeName)\b/iu },
];

const COMBINED_EXFIL_PATTERNS = [
	{ label: "session export and upload path", pattern: /(?:session\.jsonl|export-html|Radius).{0,240}(?:gist|upload|POST)|(?:gist|upload|POST).{0,240}(?:session\.jsonl|export-html|Radius)/isu },
	{ label: "authorization bearer in session workflow", pattern: /Authorization:\s*Bearer.{0,240}(?:session|gist|artifact)|(?:session|gist|artifact).{0,240}Authorization:\s*Bearer/isu },
];

const ARCHIVE_FORBIDDEN_PATHS = [
	{ label: "git metadata", pattern: /^\.?\/?\.git(?:\/|$)/u },
	{ label: "installed dependency", pattern: /(?:^|\/)node_modules(?:\/|$)/u },
	{ label: "binary artifact", pattern: /\.(?:app|bin|dylib|dll|exe|so)$/iu },
	{ label: "source map", pattern: /\.map$/iu },
];

function normalize(value) {
	return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function analyzePath(repoPath) {
	const normalizedPath = normalize(repoPath);
	if (publicGuardPaths.has(normalizedPath)) return [];
	return FORBIDDEN_PATHS.filter(({ pattern }) => pattern.test(normalizedPath)).map(({ label }) => `${normalizedPath}: ${label}`);
}

export function analyzeText(repoPath, text) {
	const normalizedPath = normalize(repoPath);
	if (publicGuardPaths.has(normalizedPath)) return [];
	const violations = [];
	for (const { label, pattern } of FORBIDDEN_TEXT) {
		if (pattern.test(text)) violations.push(`${normalizedPath}: ${label}`);
	}
	if (
		/^packages\/coding-agent\/test\/fixtures\/(?:before-compaction|large-session)\.jsonl$/u.test(normalizedPath) &&
		(/"branchedFrom"\s*:/u.test(text) || /"cwd"\s*:\s*"\//u.test(text) || /"provider"\s*:\s*"(?:anthropic|openai)"/iu.test(text))
	) {
		violations.push(`${normalizedPath}: raw session fixture`);
	}
	for (const { label, pattern } of COMBINED_EXFIL_PATTERNS) {
		if (pattern.test(text) && /(?:session-share|issue-analysis|\.pi\/)/iu.test(normalizedPath)) {
			violations.push(`${normalizedPath}: ${label}`);
		}
	}
	return violations;
}

export function analyzeRef(refName, allowedRefs) {
	if (allowedRefs.has(refName)) return [];
	if (/refs\/tags\/(?:step-harness-bootstrap|v0\.3\.[1-7])$/u.test(refName)) {
		return [`${refName}: retired public tag must be removed`];
	}
	return [`${refName}: ref is outside the approved public allowlist`];
}

function git(args, options = {}) {
	return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
}

function parseArgs(argv) {
	const allowedRefs = new Set();
	let archivePath;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--allow-ref") {
			const value = argv[index + 1];
			if (!value) throw new Error("--allow-ref requires a ref name");
			allowedRefs.add(value);
			index += 1;
		} else if (arg === "--archive") {
			archivePath = argv[index + 1];
			if (!archivePath) throw new Error("--archive requires a path");
			index += 1;
		} else if (arg !== "--self-test") {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	if (allowedRefs.size === 0) {
		allowedRefs.add("refs/heads/github-opensource");
		allowedRefs.add("refs/remotes/origin/github-opensource");
	}
	return { allowedRefs, archivePath };
}

function checkRemoteUrls() {
	const output = git(["remote", "-v"]);
	return /gitlab\.basemind\.com/iu.test(output) ? ["git remote: private GitLab origin"] : [];
}

function checkCommits() {
	const output = git(["log", "--all", "--format=%H%x00%B%x00"]);
	const violations = [];
	const commitPattern = /(?:gitlab\.basemind|stepfun-inc|\b(?:PI_GIST_TOKEN|PI_AUTH_JSON|STEP_RELEASE_BOT_WEBHOOK_TOKEN)\b|\[(?:Main|Public)-only\]|session-share|radius artifact)/iu;
	const records = output.split("\0");
	for (let index = 0; index + 1 < records.length; index += 2) {
		const hash = records[index];
		const message = records[index + 1];
		if (hash && commitPattern.test(message)) violations.push(`${hash}: forbidden commit metadata`);
	}
	return violations;
}

function checkReachableObjects() {
	const objectLines = git(["rev-list", "--objects", "--all"]).split("\n").filter(Boolean);
	const violations = [];
	const blobs = [];
	for (const line of objectLines) {
		const separator = line.indexOf(" ");
		if (separator === -1) continue;
		const oid = line.slice(0, separator);
		const objectPath = line.slice(separator + 1);
		violations.push(...analyzePath(objectPath));
		blobs.push({ oid, objectPath });
	}

	if (blobs.length === 0) return violations;
	const batch = git(["cat-file", "--batch"], { input: `${blobs.map(({ oid }) => oid).join("\n")}\n`, encoding: null });
	let offset = 0;
	for (const { objectPath } of blobs) {
		const headerEnd = batch.indexOf(10, offset);
		if (headerEnd === -1) break;
		const header = batch.subarray(offset, headerEnd).toString("utf8").split(" ");
		const size = Number(header[2]);
		offset = headerEnd + 1;
		if (Number.isFinite(size) && size >= 0) {
			const content = batch.subarray(offset, offset + size);
			if (header[1] === "blob") violations.push(...analyzeText(objectPath, content.toString("utf8")));
			offset += size;
		}
		if (batch[offset] === 10) offset += 1;
	}
	return violations;
}

function checkArchive(archivePath) {
	const entries = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" }).split("\n").filter(Boolean);
	const violations = [];
	for (const entry of entries) {
		const normalized = normalize(entry);
		for (const { label, pattern } of ARCHIVE_FORBIDDEN_PATHS) {
			if (pattern.test(normalized)) violations.push(`${normalized}: ${label}`);
		}
	}
	return violations;
}

function runReal({ allowedRefs, archivePath }) {
	const violations = [...checkRemoteUrls()];
	const refs = git(["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean);
	for (const ref of refs) violations.push(...analyzeRef(ref, allowedRefs));
	violations.push(...checkCommits());
	violations.push(...checkReachableObjects());
	if (archivePath) violations.push(...checkArchive(archivePath));
	if (violations.length > 0) {
		console.error("public-history check failed:");
		for (const violation of [...new Set(violations)]) console.error(`  ${violation}`);
		process.exit(1);
	}
	console.log("public-history check passed.");
}

function runSelfTest() {
	const failures = [];
	if (analyzePath(".gitlab-ci.yml").length === 0) failures.push("expected .gitlab path violation");
	if (analyzePath("docs/exec-plans/active/plan.md").length === 0) failures.push("expected exec-plan violation");
	if (analyzeText("README.md", "STEP_RELEASE_BOT_WEBHOOK_TOKEN").length === 0) failures.push("expected credential-name violation");
	if (analyzeText("packages/coding-agent/src/modes/interactive/session-share.ts", "session.jsonl uploaded to a gist").length === 0) failures.push("expected exfiltration violation");
	if (analyzeText("packages/coding-agent/test/fixtures/large-session.jsonl", '{"cwd":"synthetic-workspace"}').length !== 0) failures.push("synthetic fixture must be clean");
	if (analyzeText("packages/coding-agent/test/fixtures/large-session.jsonl", '{"cwd":"/private/workspace","provider":"anthropic"}').length === 0) failures.push("expected raw fixture violation");
	if (analyzeText("packages/providers/src/api/anthropic-messages.ts", "// stealth mode claudeCodeTools").length === 0) {
		failures.push("provider compatibility markers must be rejected");
	}
	if (analyzeRef("refs/tags/v0.3.7", new Set(["refs/heads/github-opensource"])).length === 0) failures.push("expected retired-tag violation");
	for (const exemptPath of publicGuardPaths) {
		if (analyzePath(exemptPath).length !== 0 || analyzeText(exemptPath, "gitlab.basemind.com STEP_RELEASE_BOT_WEBHOOK_TOKEN").length !== 0) {
			failures.push(`checker must exempt ${exemptPath}`);
		}
	}
	if (failures.length > 0) {
		console.error("public-history self-test FAILED:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}
	console.log("public-history self-test passed.");
}

const options = parseArgs(process.argv.slice(2));
if (process.argv.includes("--self-test")) runSelfTest();
else runReal(options);
