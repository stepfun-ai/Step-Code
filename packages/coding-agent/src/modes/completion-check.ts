import { execFile } from "node:child_process";

export interface CompletionCheckOptions {
	/** Opt-in check after all user prompts; never starts a new session or attempt. */
	completionCheck?: "git-committed";
	/** Maximum additional prompts, 1..3 (default 2). */
	completionCheckAttempts?: number;
}

export interface GitCompletionState {
	hasNewCommit: boolean;
	hasCommittedChanges: boolean;
	trackedDirty: boolean;
	untrackedFiles: boolean;
}

export function getCompletionCheckAttempts(options: CompletionCheckOptions): number | undefined {
	if (options.completionCheck === undefined) {
		if (options.completionCheckAttempts !== undefined) {
			throw new Error("--completion-check-attempts requires --completion-check git-committed");
		}
		return undefined;
	}
	if (options.completionCheck !== "git-committed") {
		throw new Error("--completion-check must be git-committed");
	}
	const attempts = options.completionCheckAttempts ?? 2;
	if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) {
		throw new Error("--completion-check-attempts must be an integer from 1 to 3");
	}
	return attempts;
}

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 64 * 1024;

function readGit(
	cwd: string,
	args: string[],
	signal: AbortSignal,
	allowDifference = false,
): Promise<{ stdout: string; exitCode: 0 | 1 }> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			[
				"--no-pager",
				"--no-optional-locks",
				"-c",
				"core.fsmonitor=false",
				"-c",
				"core.untrackedCache=false",
				...args,
			],
			{
				cwd,
				encoding: "utf8",
				shell: false,
				timeout: GIT_TIMEOUT_MS,
				maxBuffer: GIT_MAX_BUFFER,
				killSignal: "SIGKILL",
				signal,
				windowsHide: true,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" },
			},
			(error, stdout) => {
				// Git's stderr can contain paths or config values. Never relay it to
				// the model or stdout, including on timeout/output-limit failures.
				if (!error) resolve({ stdout, exitCode: 0 });
				else if (allowDifference && error.code === 1 && !error.killed && !error.signal && !signal.aborted) {
					// diff --quiet uses exit 1 for a difference. Neither decoded
					// stdout nor killed/aborted commands can establish this result.
					resolve({ stdout, exitCode: 1 });
				} else reject(new Error(`Completion check: git ${args[0]} failed (limit: 5s / 64 KiB).`));
			},
		);
	});
}

/** Capture HEAD and validate every read before extensions can start a model call. */
export async function createGitCompletionCheck(
	cwd: string,
	signal: AbortSignal,
): Promise<() => Promise<GitCompletionState>> {
	let startHead: string;
	try {
		const insideWorktree = await readGit(cwd, ["rev-parse", "--is-inside-work-tree"], signal);
		if (insideWorktree.stdout.trim() !== "true") throw new Error("not a worktree");
		startHead = (await readGit(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).stdout.trim();
		if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(startHead)) throw new Error("invalid HEAD");
	} catch {
		throw new Error("Completion check requires a readable Git worktree with an existing HEAD commit.");
	}

	const check = async (): Promise<GitCompletionState> => {
		// The only variable argument is the validated object ID captured above.
		// A changed HEAD alone is insufficient: rewinding to an ancestor adds no commit.
		const newCommit = await readGit(cwd, ["rev-list", "--max-count=1", `${startHead}..HEAD`, "--"], signal);
		const committedDiff = await readGit(
			cwd,
			[
				"diff",
				"--quiet",
				"--no-ext-diff",
				"--no-textconv",
				"--no-renames",
				"--ignore-submodules=none",
				startHead,
				"HEAD",
				"--",
			],
			signal,
			true,
		);
		const status = await readGit(
			cwd,
			["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal", "--ignore-submodules=none"],
			signal,
		);
		// --no-renames gives one NUL-delimited record per path, including paths
		// containing newlines. No filenames or file contents leave this function.
		const entries = status.stdout.split("\0").filter((entry) => entry.length > 0);
		return {
			hasNewCommit: newCommit.stdout.trim().length > 0,
			hasCommittedChanges: committedDiff.exitCode === 1,
			trackedDirty: entries.some((entry) => !entry.startsWith("?? ")),
			untrackedFiles: entries.some((entry) => entry.startsWith("?? ")),
		};
	};
	await check();
	return check;
}

export function completionCheckFeedback(git: GitCompletionState, hasFinalText: boolean): string {
	const missing: string[] = [];
	if (!git.hasNewCommit) missing.push("no new commit since the starting HEAD");
	if (!git.hasCommittedChanges) missing.push("no committed tree changes from the starting HEAD");
	if (git.trackedDirty) missing.push("tracked changes remain");
	if (git.untrackedFiles) missing.push("unignored untracked files remain");
	if (!hasFinalText) missing.push("final answer text is missing");
	return (
		`Completion check: ${missing.join("; ")}. ` +
		"Complete the task's required verification and commit any remaining task changes, then provide a brief final answer. " +
		"Preserve unrelated user changes and respect permission denials."
	);
}
