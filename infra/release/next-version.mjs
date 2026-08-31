#!/usr/bin/env node

/** Compute the next stable Step Harness release tag. */

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const RELEASE_BUMP_KINDS = ["patch", "minor", "major"];

export function parseReleaseTag(tag) {
	const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(String(tag).trim());
	if (!match) return null;
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareVersions(left, right) {
	return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function formatReleaseTag(version) {
	return `v${version.major}.${version.minor}.${version.patch}`;
}

export function selectLatestReleaseVersion(tags) {
	let latest = null;
	for (const tag of tags) {
		const version = parseReleaseTag(tag);
		if (version && (!latest || compareVersions(version, latest) > 0)) latest = version;
	}
	return latest;
}

export function bumpVersion(version, bump) {
	switch (bump) {
		case "major":
			return { major: version.major + 1, minor: 0, patch: 0 };
		case "minor":
			return { major: version.major, minor: version.minor + 1, patch: 0 };
		case "patch":
			return { major: version.major, minor: version.minor, patch: version.patch + 1 };
		default:
			throw new Error(`unsupported bump '${bump}'; expected ${RELEASE_BUMP_KINDS.join(", ")}`);
	}
}

export function computeNextReleaseTag({ tags, bump }) {
	if (!RELEASE_BUMP_KINDS.includes(bump)) {
		throw new Error(`unsupported bump '${bump}'; expected ${RELEASE_BUMP_KINDS.join(", ")}`);
	}
	const latest = selectLatestReleaseVersion(tags);
	if (!latest) {
		throw new Error("no vMAJOR.MINOR.PATCH tag found; refusing to guess a first version");
	}
	return { latestTag: formatReleaseTag(latest), nextTag: formatReleaseTag(bumpVersion(latest, bump)) };
}

export async function readGitTags(cwd) {
	const { stdout } = await execFileAsync("git", ["tag", "--list", "v*"], {
		cwd,
		maxBuffer: 8 * 1024 * 1024,
	});
	return stdout.split("\n").map((tag) => tag.trim()).filter(Boolean);
}

function parseArgs(argv) {
	const result = new Map();
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token.startsWith("--")) continue;
		const [key, inline] = token.slice(2).split("=", 2);
		if (inline !== undefined) result.set(key, inline);
		else if (argv[index + 1] && !argv[index + 1].startsWith("--")) result.set(key, argv[++index]);
		else result.set(key, true);
	}
	return result;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const bump = String(args.get("bump") ?? "").trim();
	if (!RELEASE_BUMP_KINDS.includes(bump)) {
		process.stderr.write(`Usage: node infra/release/next-version.mjs --bump <${RELEASE_BUMP_KINDS.join("|")}>\n`);
		process.exitCode = 1;
		return;
	}
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	const result = computeNextReleaseTag({ tags: await readGitTags(repoRoot), bump });
	process.stderr.write(`latest release tag: ${result.latestTag}\n`);
	process.stdout.write(`${result.nextTag}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
