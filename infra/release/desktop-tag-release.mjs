#!/usr/bin/env node

/**
 * Create the next StepCode Desktop tag (`desktop-vX.Y.Z`) through the GitLab API.
 *
 * Desktop releases are tag-driven: this is the only place a Desktop version is
 * chosen. Every other Desktop job reads `CI_COMMIT_TAG`, so a build that never
 * had a tag cannot publish one.
 *
 * Needs a project access token with the `api` scope in STEP_RELEASE_TOKEN, and
 * permission to create protected tags for `desktop-v*`.
 */

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

export async function createDesktopTag({ apiUrl, projectId, token, tag, ref, message }) {
	const url = `${projectUrl(apiUrl, projectId)}/repository/tags`;
	const query = new URLSearchParams({ tag_name: tag, ref, message });
	const response = await fetch(`${url}?${query}`, {
		method: "POST",
		headers: { "PRIVATE-TOKEN": token, accept: "application/json" },
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw failure("POST", url, response, body, "check api scope and protected-tag permissions for desktop-v*");
	}
	return response.json();
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
			`Usage: node infra/release/desktop-tag-release.mjs --bump <${DESKTOP_BUMP_KINDS.join("|")}> [--dry-run]\n`,
		);
		process.exitCode = 1;
		return;
	}
	const token = requiredEnv("STEP_RELEASE_TOKEN");
	const apiUrl = requiredEnv("CI_API_V4_URL");
	const projectId = requiredEnv("CI_PROJECT_ID");
	// The tag points at the commit this pipeline tested; the tag pipeline then
	// builds and publishes exactly that commit.
	const ref = requiredEnv("CI_COMMIT_SHA");
	const tags = await fetchDesktopTagNames({ apiUrl, projectId, token });
	const { latestTag, nextTag } = computeNextDesktopTag({ tags, bump });
	process.stderr.write(`latest Desktop tag: ${latestTag ?? "none"}\n`);
	if (tags.includes(nextTag)) throw new Error(`tag ${nextTag} already exists; refusing to move it`);
	if (args.has("dry-run")) {
		process.stdout.write(`${nextTag}\n`);
		return;
	}
	await createDesktopTag({ apiUrl, projectId, token, tag: nextTag, ref, message: `StepCode Desktop ${nextTag}` });
	process.stdout.write(`${nextTag}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
