#!/usr/bin/env node

/** Create the next Step Harness tag through the GitLab API. */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeNextReleaseTag, RELEASE_BUMP_KINDS } from "./next-version.mjs";

const PER_PAGE = 100;

function requiredEnv(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

async function request(input) {
	const response = await fetch(input.url, {
		method: input.method ?? "GET",
		headers: { "PRIVATE-TOKEN": input.token, accept: "application/json" },
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		const hint = response.status === 401 || response.status === 403 ? "; check the token has the api scope" : "";
		throw new Error(`${input.method ?? "GET"} ${input.url} failed: ${response.status}${hint}\n${body.slice(0, 400)}`);
	}
	return response;
}

export async function fetchAllTagNames(input) {
	const names = [];
	for (let page = 1; ; page += 1) {
		const url = `${input.apiUrl.replace(/\/+$/u, "")}/projects/${encodeURIComponent(input.projectId)}/repository/tags?per_page=${PER_PAGE}&page=${page}&order_by=name&sort=desc`;
		const response = await request({ url, token: input.token });
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

export async function createTag(input) {
	const url = `${input.apiUrl.replace(/\/+$/u, "")}/projects/${encodeURIComponent(input.projectId)}/repository/tags`;
	const query = new URLSearchParams({ tag_name: input.tag, ref: input.ref, message: input.message });
	const response = await fetch(`${url}?${query}`, {
		method: "POST",
		headers: { "PRIVATE-TOKEN": input.token, accept: "application/json" },
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		const hint = response.status === 401 || response.status === 403 ? "; check api scope and protected-tag permissions" : "";
		throw new Error(`creating ${input.tag} failed: ${response.status}${hint}\n${body.slice(0, 400)}`);
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
	if (!RELEASE_BUMP_KINDS.includes(bump)) {
		process.stderr.write(`Usage: node infra/release/tag-release.mjs --bump <${RELEASE_BUMP_KINDS.join("|")}> [--dry-run]\n`);
		process.exitCode = 1;
		return;
	}
	const token = requiredEnv("STEP_RELEASE_TOKEN");
	const apiUrl = requiredEnv("CI_API_V4_URL");
	const projectId = requiredEnv("CI_PROJECT_ID");
	const ref = requiredEnv("CI_COMMIT_SHA");
	const tags = await fetchAllTagNames({ apiUrl, projectId, token });
	const { latestTag, nextTag } = computeNextReleaseTag({ tags, bump });
	process.stderr.write(`latest release tag: ${latestTag}\n`);
	if (tags.includes(nextTag)) throw new Error(`tag ${nextTag} already exists; refusing to move it`);
	if (args.get("dry-run") === true || args.get("dry-run") === "true") {
		process.stdout.write(`${nextTag}\n`);
		return;
	}
	await createTag({ apiUrl, projectId, token, tag: nextTag, ref, message: `Release ${nextTag}` });
	process.stdout.write(`${nextTag}\n`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
