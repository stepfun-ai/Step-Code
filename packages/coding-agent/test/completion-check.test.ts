import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	completionCheckFeedback,
	createGitCompletionCheck,
	getCompletionCheckAttempts,
} from "../src/modes/completion-check.ts";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		[
			"-c",
			"user.name=Completion Test",
			"-c",
			"user.email=completion@example.invalid",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		{ cwd, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] },
	);
}

function makeRepo(): string {
	const cwd = mkdtempSync(join(tmpdir(), "completion-check-"));
	roots.push(cwd);
	git(cwd, "init", "--quiet", "--template=");
	writeFileSync(join(cwd, "source.txt"), "base\n");
	writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
	git(cwd, "add", "source.txt", ".gitignore");
	git(cwd, "commit", "--quiet", "-m", "base");
	return cwd;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("read-only git-committed check", () => {
	it("requires a nonempty starting-HEAD..HEAD commit range", async () => {
		const cwd = makeRepo();
		const base = git(cwd, "rev-parse", "HEAD").trim();
		const check = await createGitCompletionCheck(cwd, new AbortController().signal);
		expect(await check()).toEqual({
			hasNewCommit: false,
			hasCommittedChanges: false,
			trackedDirty: false,
			untrackedFiles: false,
		});
		writeFileSync(join(cwd, "source.txt"), "changed\n");
		git(cwd, "add", "source.txt");
		git(cwd, "commit", "--quiet", "-m", "task change");
		expect(await check()).toEqual({
			hasNewCommit: true,
			hasCommittedChanges: true,
			trackedDirty: false,
			untrackedFiles: false,
		});
		const afterCommit = await createGitCompletionCheck(cwd, new AbortController().signal);
		git(cwd, "checkout", "--quiet", "--detach", base);
		expect(await afterCommit()).toEqual({
			hasNewCommit: false,
			hasCommittedChanges: true,
			trackedDirty: false,
			untrackedFiles: false,
		});
	});

	it("rejects empty commits and a change fully reverted in later commits", async () => {
		const cwd = makeRepo();
		const check = await createGitCompletionCheck(cwd, new AbortController().signal);
		git(cwd, "commit", "--quiet", "--allow-empty", "-m", "empty task commit");
		expect(await check()).toEqual({
			hasNewCommit: true,
			hasCommittedChanges: false,
			trackedDirty: false,
			untrackedFiles: false,
		});
		writeFileSync(join(cwd, "source.txt"), "changed then reverted\n");
		git(cwd, "add", "source.txt");
		git(cwd, "commit", "--quiet", "-m", "temporary change");
		expect((await check()).hasCommittedChanges).toBe(true);
		git(cwd, "revert", "--no-edit", "HEAD");
		expect(await check()).toEqual({
			hasNewCommit: true,
			hasCommittedChanges: false,
			trackedDirty: false,
			untrackedFiles: false,
		});
	});

	it("recognizes binary tree differences using the quiet diff exit status", async () => {
		const cwd = makeRepo();
		const check = await createGitCompletionCheck(cwd, new AbortController().signal);
		writeFileSync(join(cwd, "binary"), Buffer.from([0, 255, 1, 0, 254]));
		git(cwd, "add", "binary");
		git(cwd, "commit", "--quiet", "-m", "binary task change");
		expect((await check()).hasCommittedChanges).toBe(true);
	});

	it("detects staged, unstaged, and unignored files without exposing paths or contents", async () => {
		const cwd = makeRepo();
		const check = await createGitCompletionCheck(cwd, new AbortController().signal);
		writeFileSync(join(cwd, "source.txt"), "private file contents\n");
		writeFileSync(join(cwd, "ignored.txt"), "ignored contents\n");
		expect(await check()).toEqual({
			hasNewCommit: false,
			hasCommittedChanges: false,
			trackedDirty: true,
			untrackedFiles: false,
		});
		git(cwd, "add", "source.txt");
		expect((await check()).trackedDirty).toBe(true);
		git(cwd, "commit", "--quiet", "-m", "task change");
		const privateName = "private\n?? file $(ignored).txt";
		writeFileSync(join(cwd, privateName), "more private contents\n");
		const state = await check();
		expect(state).toEqual({
			hasNewCommit: true,
			hasCommittedChanges: true,
			trackedDirty: false,
			untrackedFiles: true,
		});
		const feedback = completionCheckFeedback(state, false);
		expect(feedback).toContain("unignored untracked files remain");
		expect(feedback).toContain("final answer text is missing");
		expect(feedback).not.toContain("private");
		expect(feedback.length).toBeLessThan(500);
	});

	it("disables fsmonitor commands and leaves the index untouched", async () => {
		const cwd = makeRepo();
		const marker = join(cwd, "fsmonitor-ran");
		git(cwd, "config", "core.fsmonitor", `touch '${marker}'`);
		const index = join(cwd, ".git", "index");
		const before = readFileSync(index);
		const beforeStat = statSync(index);
		const check = await createGitCompletionCheck(cwd, new AbortController().signal);
		await check();
		expect(existsSync(marker)).toBe(false);
		expect(readFileSync(index)).toEqual(before);
		expect(statSync(index).mtimeMs).toBe(beforeStat.mtimeMs);
	});

	it("fails preflight for non-repositories and unborn HEADs", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "completion-no-git-"));
		roots.push(cwd);
		await expect(createGitCompletionCheck(cwd, new AbortController().signal)).rejects.toThrow("existing HEAD commit");
		git(cwd, "init", "--quiet", "--template=");
		await expect(createGitCompletionCheck(cwd, new AbortController().signal)).rejects.toThrow("existing HEAD commit");
	});

	it("bounds Git output and redacts the failure", async () => {
		const cwd = makeRepo();
		for (let index = 0; index < 400; index++) {
			writeFileSync(join(cwd, `sensitive-${index}-${"x".repeat(180)}`), "private contents");
		}
		await expect(createGitCompletionCheck(cwd, new AbortController().signal)).rejects.toThrow(
			"Completion check: git status failed (limit: 5s / 64 KiB).",
		);
	});

	it("obeys cancellation", async () => {
		const cwd = makeRepo();
		const abort = new AbortController();
		const check = await createGitCompletionCheck(cwd, abort.signal);
		abort.abort();
		await expect(check()).rejects.toThrow("Completion check: git rev-list failed");
	});
});

describe("completion-check option validation for direct print-mode callers", () => {
	it("defaults to off or two follow-ups when explicitly enabled", () => {
		expect(getCompletionCheckAttempts({})).toBeUndefined();
		expect(getCompletionCheckAttempts({ completionCheck: "git-committed" })).toBe(2);
	});

	it.each([0, 4, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid bound %s", (attempts) => {
		expect(() =>
			getCompletionCheckAttempts({ completionCheck: "git-committed", completionCheckAttempts: attempts }),
		).toThrow("integer from 1 to 3");
	});

	it("rejects attempts without an enabled check", () => {
		expect(() => getCompletionCheckAttempts({ completionCheckAttempts: 2 })).toThrow("requires --completion-check");
	});
});
