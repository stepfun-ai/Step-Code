import type { ExecFileException, ExecFileOptions } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGitCompletionCheck } from "../src/modes/completion-check.ts";

const { execFileMock } = vi.hoisted(() => ({
	execFileMock:
		vi.fn<
			(
				command: string,
				args: string[],
				options: ExecFileOptions,
				callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
			) => void
		>(),
}));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const head = "a".repeat(40);
let diffError: ExecFileException | null;
let diffStdout: string;

beforeEach(() => {
	execFileMock.mockReset();
	diffError = null;
	diffStdout = "";
	execFileMock.mockImplementation((_command, args, _options, callback) => {
		if (args.includes("diff")) callback(diffError, diffStdout, "private driver/config error");
		else if (args.includes("--is-inside-work-tree")) callback(null, "true\n", "");
		else if (args.includes("rev-parse")) callback(null, `${head}\n`, "");
		else callback(null, "", "");
	});
});

describe("completion-check fixed Git command boundary", () => {
	it("disables shell, fsmonitor, external diffs, textconv and lazy fetching with fixed limits", async () => {
		const signal = new AbortController().signal;
		await createGitCompletionCheck("/worktree with spaces", signal);
		for (const [command, args, options] of execFileMock.mock.calls) {
			expect(command).toBe("git");
			expect(args.slice(0, 6)).toEqual([
				"--no-pager",
				"--no-optional-locks",
				"-c",
				"core.fsmonitor=false",
				"-c",
				"core.untrackedCache=false",
			]);
			expect(options).toMatchObject({
				cwd: "/worktree with spaces",
				shell: false,
				encoding: "utf8",
				timeout: 5_000,
				maxBuffer: 64 * 1024,
				killSignal: "SIGKILL",
				signal,
				windowsHide: true,
				env: { GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" },
			});
		}
		const diffArgs = execFileMock.mock.calls.find(([, args]) => args.includes("diff"))?.[1];
		expect(diffArgs?.slice(6)).toEqual([
			"diff",
			"--quiet",
			"--no-ext-diff",
			"--no-textconv",
			"--no-renames",
			"--ignore-submodules=none",
			head,
			"HEAD",
			"--",
		]);
	});

	it("uses exit status, not decoded stdout, to distinguish unchanged and changed trees", async () => {
		diffStdout = "nonempty stdout is not evidence of a tree diff";
		const check = await createGitCompletionCheck("/worktree", new AbortController().signal);
		expect((await check()).hasCommittedChanges).toBe(false);
		diffStdout = "";
		diffError = Object.assign(new Error("quiet diff found changes"), { code: 1, killed: false });
		expect((await check()).hasCommittedChanges).toBe(true);
	});

	it.each([2, 128, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "ABORT_ERR"])(
		"treats diff exit/error %s as unavailable and redacts its output",
		async (code) => {
			const check = await createGitCompletionCheck("/worktree", new AbortController().signal);
			diffError = Object.assign(new Error("private configuration value"), { code });
			await expect(check()).rejects.toThrow("Completion check: git diff failed (limit: 5s / 64 KiB).");
		},
	);

	it.each([{ killed: true }, { signal: "SIGKILL" as const }])(
		"does not accept an interrupted diff even if its reported exit code is 1: %j",
		async (interrupted) => {
			const check = await createGitCompletionCheck("/worktree", new AbortController().signal);
			diffError = Object.assign(new Error("timeout"), { code: 1, ...interrupted });
			await expect(check()).rejects.toThrow("git diff failed");
		},
	);

	it("does not accept a diff result after cancellation", async () => {
		const abort = new AbortController();
		const check = await createGitCompletionCheck("/worktree", abort.signal);
		diffError = Object.assign(new Error("cancelled"), { code: 1 });
		abort.abort();
		await expect(check()).rejects.toThrow("git diff failed");
	});
});
