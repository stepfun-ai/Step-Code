import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const releaseScript = fileURLToPath(new URL("./release.mjs", import.meta.url));

function runGit(root, args) {
	execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

async function makeGitFixture(version) {
	const root = await mkdtemp(join(tmpdir(), "step-release-version-"));
	await writeFile(join(root, "package.json"), `${JSON.stringify({ version })}\n`);
	runGit(root, ["init", "-q"]);
	runGit(root, ["config", "user.email", "step-release-test@example.invalid"]);
	runGit(root, ["config", "user.name", "Step release test"]);
	runGit(root, ["add", "package.json"]);
	runGit(root, ["commit", "-qm", "fixture"]);
	return root;
}

function runStepDryRun(root, args = [], overrides = {}) {
	const env = { ...process.env, STEP_HARNESS_RELEASE_PUSH: "0", ...overrides };
	for (const name of [
		"STEP_HARNESS_VERSION",
		"STEP_HARNESS_RELEASE_VERSION",
		"STEP_HARNESS_VERSION_OVERRIDE",
		"GITHUB_REF_NAME",
		"CI_COMMIT_TAG",
		"RELEASE_TAG",
	]) {
		if (!(name in overrides)) delete env[name];
	}
	return spawnSync(process.execPath, [releaseScript, "--step", "--dry-run", ...args], {
		cwd: root,
		encoding: "utf8",
		env,
	});
}

test("Step dry-run falls back to the root package version", async () => {
	const root = await makeGitFixture("9.8.7");
	try {
		const result = runStepDryRun(root);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Step version: 9\.8\.7/);
		assert.match(result.stdout, /Git tag: v9\.8\.7/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("an explicit Step version still overrides the package fallback", async () => {
	const root = await makeGitFixture("9.8.7");
	try {
		const result = runStepDryRun(root, ["v9.9.0"]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Step version: 9\.9\.0/);
		assert.match(result.stdout, /Git tag: v9\.9\.0/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
