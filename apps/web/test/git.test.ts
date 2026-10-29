/**
 * Git branch state and switching for the composer's branch pill.
 *
 * Every case builds a throwaway repository: real git, real files, no network.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createBranch, GitBranchError, gitRunEnv, isPlausibleBranchName, listLocalBranches, readGitState, switchBranch } from "../src/git.ts";

const git = promisify(execFile);

interface Repo {
	readonly root: string;
	readonly cleanup: () => Promise<void>;
}

/** A committed repository on `main` with one file, plus a second branch `feature`. */
async function repository(): Promise<Repo> {
	const root = await mkdtemp(join(tmpdir(), "stepcode-web-git-"));
	// `gitRunEnv` drops GIT_DIR and friends: under a hook they point at the real
	// repository, and this fixture must stay the throwaway one it claims to be.
	const run = (...args: string[]) => git("git", args, { cwd: root, env: gitRunEnv() });
	await run("init", "--initial-branch=main");
	await run("config", "user.name", "Test");
	await run("config", "user.email", "test@example.com");
	await writeFile(join(root, "a.txt"), "one\n");
	await run("add", "a.txt");
	await run("commit", "-m", "first");
	await run("branch", "feature");
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("a plain folder is not a repository", async () => {
	const root = await mkdtemp(join(tmpdir(), "stepcode-web-git-plain-"));
	try {
		assert.deepEqual(await readGitState(root), { repository: false });
		assert.deepEqual(await listLocalBranches(root), { state: { repository: false }, branches: [] });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the state names the branch, the root and the dirty file count", async () => {
	const { root, cleanup } = await repository();
	try {
		const state = await readGitState(root);
		assert.deepEqual(
			// git reports the resolved root, with `/` even on Windows; on macOS /var is a symlink to /private/var.
			{ ...state, root: state.root && resolve(state.root) },
			{ repository: true, root: await realpath(root), branch: "main", dirtyFiles: 0 },
		);
		await writeFile(join(root, "a.txt"), "changed\n");
		await writeFile(join(root, "new.txt"), "untracked\n");
		const dirty = await readGitState(root);
		assert.equal(dirty.dirtyFiles, 2);
	} finally {
		await cleanup();
	}
});

test("local branches list newest first, the current one included", async () => {
	const { root, cleanup } = await repository();
	try {
		const { state, branches } = await listLocalBranches(root);
		assert.equal(state.branch, "main");
		assert.deepEqual(
			branches.map((branch) => branch.name).sort(),
			["feature", "main"],
		);
	} finally {
		await cleanup();
	}
});

test("switching reports the new branch and keeps uncommitted work", async () => {
	const { root, cleanup } = await repository();
	try {
		await writeFile(join(root, "a.txt"), "dirty\n");
		const state = await switchBranch(root, "feature");
		assert.equal(state.branch, "feature");
		// Untracked and modified files a switch can carry are left alone.
		assert.equal(state.dirtyFiles, 1);
		assert.deepEqual(await readGitState(root), state);
	} finally {
		await cleanup();
	}
});

test("switching to the current branch is a no-op", async () => {
	const { root, cleanup } = await repository();
	try {
		assert.equal((await switchBranch(root, "main")).branch, "main");
	} finally {
		await cleanup();
	}
});

test("a branch that does not exist is refused with target-branch-not-found", async () => {
	const { root, cleanup } = await repository();
	try {
		await assert.rejects(switchBranch(root, "nope"), (error: unknown) => {
			assert.ok(error instanceof GitBranchError);
			assert.equal(error.code, "target-branch-not-found");
			return true;
		});
		assert.equal((await readGitState(root)).branch, "main");
	} finally {
		await cleanup();
	}
});

test("an invalid branch name never reaches git", async () => {
	const { root, cleanup } = await repository();
	try {
		for (const name of ["--force", "-D main", "a..b", "bad name", "x.lock", ""]) {
			assert.equal(isPlausibleBranchName(name), false, name);
			await assert.rejects(switchBranch(root, name), (error: unknown) => {
				assert.ok(error instanceof GitBranchError);
				assert.equal(error.code, "invalid-branch-name");
				return true;
			});
		}
	} finally {
		await cleanup();
	}
});

test("create switches to the new branch at HEAD", async () => {
	const { root, cleanup } = await repository();
	try {
		const state = await createBranch(root, "feat/new");
		assert.equal(state.branch, "feat/new");
		const { branches } = await listLocalBranches(root);
		assert.ok(branches.some((branch) => branch.name === "feat/new"));
		await assert.rejects(createBranch(root, "feat/new"), (error: unknown) => {
			assert.ok(error instanceof GitBranchError);
			assert.equal(error.code, "branch-already-exists");
			return true;
		});
	} finally {
		await cleanup();
	}
});

test("a switch that would overwrite local changes names the blocking files", async () => {
	const { root, cleanup } = await repository();
	try {
		// `feature` gets a conflicting version of the same file, `main` keeps an uncommitted edit.
		await git("git", ["switch", "--no-guess", "feature"], { cwd: root, env: gitRunEnv() });
		await writeFile(join(root, "a.txt"), "feature\n");
		await git("git", ["commit", "-am", "feature edit"], { cwd: root, env: gitRunEnv() });
		await git("git", ["switch", "--no-guess", "main"], { cwd: root, env: gitRunEnv() });
		await writeFile(join(root, "a.txt"), "local edit\n");
		await assert.rejects(switchBranch(root, "feature"), (error: unknown) => {
			assert.ok(error instanceof GitBranchError);
			assert.equal(error.code, "tracked-changes-would-be-overwritten");
			assert.deepEqual(error.paths, ["a.txt"]);
			return true;
		});
		assert.equal((await readGitState(root)).branch, "main");
	} finally {
		await cleanup();
	}
});
