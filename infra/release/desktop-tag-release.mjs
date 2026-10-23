#!/usr/bin/env node

/**
 * Create the next StepCode Desktop tag (`desktop-vX.Y.Z`) on the commit this
 * pipeline builds, and hand its version to the rest of the pipeline.
 *
 * Desktop releases are tag-driven: this is the only place a Desktop version is
 * chosen. The release jobs of the same pipeline read the version from the
 * `--dotenv` file this script writes (a GitLab dotenv report), so a build that
 * never got a tag cannot publish one.
 *
 * The tag is pushed with `-o ci.skip`: a tag pipeline would run as the token's
 * bot user, which cannot read the falcon includes, and would build the same
 * release twice. Tags are listed through the API.
 *
 * Needs a project access token in STEP_RELEASE_TOKEN with the `api` and
 * `write_repository` scopes, allowed to create the protected `desktop-v*` tags.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeNextDesktopTag, DESKTOP_BUMP_KINDS } from "./desktop-next-version.mjs";

const PER_PAGE = 100;

function requiredEnv(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function projectUrl(apiUrl, projectId) {
	return `${String(apiUrl).replace(/\/+$/u, "")}/projects/${encodeURIComponent(projectId)}`;
}

function failure(method, url, response, body, hint) {
	const scope = response.status === 401 || response.status === 403 ? `; ${hint}` : "";
	return new Error(`${method} ${url} failed: ${response.status}${scope}\n${body.slice(0, 400)}`);
}

/** Only `desktop-v*` tags; the search keeps the listing short in a repository with many CLI tags. */
export async function fetchDesktopTagNames({ apiUrl, projectId, token }) {
	const names = [];
	for (let page = 1; ; page += 1) {
		const query = new URLSearchParams({ search: "^desktop-v", per_page: String(PER_PAGE), page: String(page) });
		const url = `${projectUrl(apiUrl, projectId)}/repository/tags?${query}`;
		const response = await fetch(url, { headers: { "PRIVATE-TOKEN": token, accept: "application/json" } });
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw failure("GET", url, response, body, "check the token has the api scope");
		}
		const batch = await response.json();
		if (!Array.isArray(batch) || batch.length === 0) break;
		for (const tag of batch) {
			if (tag && typeof tag.name === "string") names.push(tag.name);
		}
		const nextPage = Number(response.headers.get("x-next-page"));
		if (!Number.isInteger(nextPage) || nextPage <= page) break;
		page = nextPage - 1;
	}
	return names;
}

/** Remote URL carrying the token as password; never printed. */
export function tokenRemoteUrl({ serverUrl, projectPath, token }) {
	const url = new URL(`${String(serverUrl).replace(/\/+$/u, "")}/${projectPath}.git`);
	url.username = "release-tagger";
	url.password = token;
	return url.toString();
}

/**
 * Push `<commit>:refs/tags/<tag>` (a lightweight tag) without creating a
 * pipeline for it. Output is redacted because git echoes the remote URL on
 * some failures.
 */
export function pushDesktopTag({ remoteUrl, token, tag, commit, run = spawnSync }) {
	const result = run("git", ["push", "--porcelain", "-o", "ci.skip", remoteUrl, `${commit}:refs/tags/${tag}`], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const redact = (text) => String(text ?? "").replaceAll(token, "***");
	if (result.error) throw new Error(`git push ${tag} failed: ${redact(result.error.message)}`);
	if (result.status !== 0) {
		throw new Error(
			`git push ${tag} failed (exit ${result.status}); check write_repository scope and protected-tag permissions for desktop-v*\n${redact(result.stderr).slice(0, 400)}`,
		);
	}
}

/** GitLab dotenv report: the release jobs get DESKTOP_TAG / DESKTOP_VERSION as variables. */
export function desktopDotenv(tag) {
	return `DESKTOP_TAG=${tag}\nDESKTOP_VERSION=${tag.slice("desktop-v".length)}\n`;
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
	if (!DESKTOP_BUMP_KINDS.includes(bump)) {
		process.stderr.write(
			`Usage: node infra/release/desktop-tag-release.mjs --bump <${DESKTOP_BUMP_KINDS.join("|")}> [--dotenv <file>] [--dry-run]\n`,
		);
		process.exitCode = 1;
		return;
	}
	const token = requiredEnv("STEP_RELEASE_TOKEN");
	const apiUrl = requiredEnv("CI_API_V4_URL");
	const projectId = requiredEnv("CI_PROJECT_ID");
	// The tag points at the commit this pipeline checked; the same pipeline then
	// builds and publishes exactly that commit.
	const commit = requiredEnv("CI_COMMIT_SHA");
	const tags = await fetchDesktopTagNames({ apiUrl, projectId, token });
	const { latestTag, nextTag } = computeNextDesktopTag({ tags, bump });
	process.stderr.write(`latest Desktop tag: ${latestTag ?? "none"}\n`);
	if (tags.includes(nextTag)) throw new Error(`tag ${nextTag} already exists; refusing to move it`);
	if (args.has("dry-run")) {
		process.stdout.write(`${nextTag}\n`);
		return;
	}
	const remoteUrl = tokenRemoteUrl({
		serverUrl: requiredEnv("CI_SERVER_URL"),
		projectPath: requiredEnv("CI_PROJECT_PATH"),
		token,
	});
	pushDesktopTag({ remoteUrl, token, tag: nextTag, commit });
	const dotenv = args.get("dotenv");
	if (typeof dotenv === "string") writeFileSync(dotenv, desktopDotenv(nextTag));
	process.stdout.write(`${nextTag}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
