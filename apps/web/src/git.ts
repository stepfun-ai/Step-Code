/**
 * Git branch state and branch switching for one workspace.
 *
 * The composer's branch pill needs three things: which branch the folder is on
 * (plus whether it is a repository at all), the local branches to switch to,
 * and a switch/create-and-switch action. Git is the authority for all three;
 * nothing here caches, so a branch changed in a terminal shows up on the next
 * read.
 *
 * Every git call runs with `--no-optional-locks`, so a background read never
 * takes `index.lock` away from a session's own commits, and with a timeout, so
 * a hung hook cannot wedge the host. Arguments are passed as an array, never
 * through a shell, and the branch name is validated before it reaches git.
 */

import { execFile } from "node:child_process";

/** `git` on PATH; a repo without a checkout is not a workspace this host can serve. */
const GIT = "git";
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
/** `git status` on a huge tree can be slow; this is a count for a label, not a full diff. */
const STATUS_TIMEOUT_MS = 15_000;

/**
 * Env vars an outer git process sets to redirect every inner git to itself: a
 * hook (husky pre-commit exports `GIT_DIR` and `GIT_INDEX_FILE`) or an editor
 * wrapper would otherwise make these runs target that outer repository instead
 * of `cwd` — under the pre-commit hook the test suite's throwaway repos literally
 * committed into this one. Stripping them pins every run to its `cwd`.
 */
const GIT_REDIRECT_ENV_KEYS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
] as const;

/** A copy of the environment with git's repository-redirect vars removed. */
export function gitRunEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of GIT_REDIRECT_ENV_KEYS) delete env[key];
	return env;
}

/** Why a branch operation was refused, mirroring the codes the client renders. */
export type GitBranchIssueCode =
	| "not-a-repository"
	| "git-unavailable"
	| "invalid-branch-name"
	| "branch-already-exists"
	| "target-branch-not-found"
	| "current-branch"
	| "tracked-changes-would-be-overwritten"
	| "untracked-changes-would-be-overwritten"
	| "conflicts-present"
	| "operation-in-progress"
	| "branch-in-other-worktree"
	| "unknown";

export interface GitBranchIssue {
	readonly code: GitBranchIssueCode;
	/** Files git named as blocking, relative to the repository root. */
	readonly paths?: readonly string[];
	/** Git's own message, for the client to show when no code applies. */
	readonly detail?: string;
}

/** One workspace's git state; `repository: false` covers every non-repository case. */
export interface GitWorkspaceState {
	readonly repository: boolean;
	/** Repository root, when `repository`; the pill switches branches of this repo. */
	readonly root?: string;
	/** Short branch name; absent on a detached HEAD. */
	readonly branch?: string;
	readonly detached?: boolean;
	/** Modified, staged and untracked files: what a checkout could carry, commit or lose. */
	readonly dirtyFiles?: number;
}

export interface GitBranchListEntry {
	readonly name: string;
	/** Upstream short name (`origin/main`) when the branch tracks one. */
	readonly upstream?: string;
}

export interface GitBranchList {
	readonly state: GitWorkspaceState;
	readonly branches: readonly GitBranchListEntry[];
}

export class GitBranchError extends Error {
	readonly code: GitBranchIssueCode;
	readonly paths: readonly string[];

	constructor(issue: GitBranchIssue) {
		super(issue.detail ?? issue.code);
		this.code = issue.code;
		this.paths = issue.paths ?? [];
	}
}

interface GitRun {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Run git in `cwd`. Never rejects: a failed run is a non-zero status with git's stderr. */
function runGit(cwd: string, args: readonly string[], timeout = GIT_TIMEOUT_MS): Promise<GitRun> {
	return new Promise((resolve) => {
		execFile(
			GIT,
			["--no-optional-locks", ...args],
			{ cwd, encoding: "utf8", timeout, maxBuffer: GIT_MAX_BUFFER, env: gitRunEnv() },
			(error, stdout, stderr) => {
				const status =
					error && typeof (error as { code?: unknown }).code === "number"
						? (error as { code: number }).code
						: error
							? 1
							: 0;
				resolve({ status, stdout: stdout ?? "", stderr: stderr ?? "" });
			},
		);
	});
}

/**
 * Branch names git and this host agree on: refs/heads goes through
 * `git check-ref-format`, which rejects `..`, leading `-`, `~^:?*[`, an empty
 * name and other shapes that would otherwise be parsed as an option.
 */
export function isPlausibleBranchName(name: string): boolean {
	if (!name || name.startsWith("-") || name.endsWith("/") || name.includes("//")) return false;
	if (name.endsWith(".lock") || name.includes("..") || name.includes("@{")) return false;
	// Refs forbid control characters and space; \u0020 covers the space itself.
	return !/[\u0000-\u0020\u007f~^:?*[\\]/.test(name);
}

/** Skip the ignored files: the pill counts what the user can still act on. */
function countDirtyFiles(status: string): number {
	let count = 0;
	for (const line of status.split("\n")) {
		if (line.trim()) count += 1;
	}
	return count;
}

/** Read the folder's git state. A non-repository, or no git at all, is `repository: false`. */
export async function readGitState(cwd: string): Promise<GitWorkspaceState> {
	const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], STATUS_TIMEOUT_MS);
	if (inside.status !== 0 || inside.stdout.trim() !== "true") return { repository: false };
	const rootResult = await runGit(cwd, ["rev-parse", "--show-toplevel"], STATUS_TIMEOUT_MS);
	const root = rootResult.stdout.trim();
	if (rootResult.status !== 0 || !root) return { repository: false };

	const symbolic = await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], STATUS_TIMEOUT_MS);
	const branch = symbolic.status === 0 ? symbolic.stdout.trim() : "";
	const [status] = await Promise.all([runGit(root, ["status", "--porcelain"], STATUS_TIMEOUT_MS)]);
	return {
		repository: true,
		root,
		...(branch ? { branch } : { detached: true }),
		dirtyFiles: status.status === 0 ? countDirtyFiles(status.stdout) : 0,
	};
}

/** Local branches, most recently committed first, plus the current state. */
export async function listLocalBranches(cwd: string, state?: GitWorkspaceState): Promise<GitBranchList> {
	const current = state ?? (await readGitState(cwd));
	if (!current.repository || !current.root) return { state: current, branches: [] };
	const result = await runGit(current.root, [
		"for-each-ref",
		"refs/heads",
		// `-committerdate` sorts newest first, which is the order people look for a branch in.
		"--sort=-committerdate",
		"--format=%(refname:short)%00%(upstream:short)",
	]);
	if (result.status !== 0) {
		throw new GitBranchError({ code: "unknown", detail: result.stderr.trim() || "git for-each-ref failed" });
	}
	const branches: GitBranchListEntry[] = [];
	for (const line of result.stdout.split("\n")) {
		if (!line) continue;
		const [name, upstream] = line.split("\u0000");
		if (!name) continue;
		branches.push(upstream ? { name, upstream } : { name });
	}
	return { state: current, branches };
}

/** Files git reports as blocking a checkout, from the two message shapes it prints. */
function blockingPaths(stderr: string, pattern: RegExp): string[] {
	const lines = stderr.replace(/\r\n/g, "\n").split("\n");
	const header = lines.findIndex((line) => pattern.test(line.toLowerCase()));
	if (header < 0) return [];
	const paths: string[] = [];
	for (let index = header + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (!line.trim()) continue;
		if (!/^\s/.test(line)) break;
		paths.push(line.trim());
	}
	return paths;
}

/**
 * Translate git's stderr into a code the client can render in its own words.
 * Matching git's prose is unavoidable: exit status 1 covers every refusal, and
 * the blocking-file lists only exist in the message.
 */
export function classifyBranchFailure(stderr: string): GitBranchIssue {
	const detail = stderr.trim();
	const lower = detail.toLowerCase();
	const tracked = blockingPaths(detail, /your local changes to the following files would be overwritten/);
	if (tracked.length) return { code: "tracked-changes-would-be-overwritten", paths: tracked, detail };
	const untracked = blockingPaths(detail, /untracked working tree files would be overwritten/);
	if (untracked.length) return { code: "untracked-changes-would-be-overwritten", paths: untracked, detail };
	if (lower.includes("already exists")) return { code: "branch-already-exists", detail };
	if (lower.includes("invalid reference:") || lower.includes("not a valid branch name")) {
		return { code: "invalid-branch-name", detail };
	}
	if (lower.includes("is already used by worktree at") || lower.includes("already checked out at")) {
		return { code: "branch-in-other-worktree", detail };
	}
	if (lower.includes("resolve your current index first")) return { code: "conflicts-present", detail };
	if (/cannot switch branch while (merging|rebasing|cherry-picking|reverting|bisecting)/.test(lower)) {
		return { code: "operation-in-progress", detail };
	}
	if (lower.includes("you have not concluded your merge") || lower.includes("rebase in progress")) {
		return { code: "operation-in-progress", detail };
	}
	if (lower.includes("not a git repository")) return { code: "not-a-repository", detail };
	return { code: "unknown", detail: detail || "git could not switch branches" };
}

/** Repo root and state for a switch; throws the codes the route turns into 400/409. */
async function repositoryFor(cwd: string): Promise<GitWorkspaceState & { root: string }> {
	let state: GitWorkspaceState;
	try {
		state = await readGitState(cwd);
	} catch {
		throw new GitBranchError({ code: "git-unavailable", detail: "git is not available" });
	}
	if (!state.repository || !state.root) {
		throw new GitBranchError({ code: "not-a-repository", detail: "Folder is not inside a git work tree" });
	}
	return { ...state, root: state.root };
}

/**
 * Switch to an existing local branch.
 *
 * `git switch` without `--force` or `--discard-changes` is the safety rule: a
 * switch that would lose work fails and reports the files, which the client
 * shows before offering to commit. Nothing is stashed, committed or discarded
 * here.
 */
export async function switchBranch(cwd: string, target: string): Promise<GitWorkspaceState> {
	const name = target.trim();
	if (!isPlausibleBranchName(name)) throw new GitBranchError({ code: "invalid-branch-name" });
	const repo = await repositoryFor(cwd);
	if (!repo.detached && repo.branch === name) return repo;
	// Check the ref first: `git switch` answers "invalid reference" for both a
	// missing branch and a malformed name, and the two need different advice.
	const exists = await runGit(repo.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
	if (exists.status !== 0) throw new GitBranchError({ code: "target-branch-not-found" });
	const result = await runGit(repo.root, ["switch", "--no-guess", name]);
	if (result.status !== 0) {
		throw new GitBranchError(classifyBranchFailure(result.stderr || result.stdout));
	}
	return await readGitState(repo.root);
}

/** Create a local branch at `startPoint` (the current HEAD) and switch to it. */
export async function createBranch(cwd: string, target: string, startPoint?: string): Promise<GitWorkspaceState> {
	const name = target.trim();
	if (!isPlausibleBranchName(name)) throw new GitBranchError({ code: "invalid-branch-name" });
	const repo = await repositoryFor(cwd);
	const from = startPoint?.trim();
	// `--` ends option parsing so a start point that looks like a flag stays a ref.
	const result = await runGit(
		repo.root,
		from ? ["switch", "--no-guess", "-c", name, "--", from] : ["switch", "--no-guess", "-c", name],
	);
	if (result.status !== 0) {
		throw new GitBranchError(classifyBranchFailure(result.stderr || result.stdout));
	}
	return await readGitState(repo.root);
}
