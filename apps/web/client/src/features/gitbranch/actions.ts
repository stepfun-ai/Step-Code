/**
 * Branch actions with fixed names, callable from any feature. The host owns git
 * (src/git.ts); these wrap its three routes. State stays in the component that
 * shows the pill, so a branch read never touches the session store.
 */

import { t } from "../../i18n";
import { api, apiSend, errorMessage } from "../../lib/api";
import { showError } from "../../state/session";
import type { GitBranchEntry, GitWorkspaceState } from "../../state/types";

export interface GitBranchSnapshot {
	readonly state: GitWorkspaceState;
	readonly branches: readonly GitBranchEntry[];
}

/**
 * Turn a failed branch mutation into one line. The host answers with a stable
 * `code` and, for an overwrite refusal, the files git named; the client says
 * what those mean rather than passing git's prose through.
 */
export function branchFailureMessage(error: unknown): string {
	const body = (error as { body?: Record<string, unknown> }).body;
	const code = typeof body?.code === "string" ? body.code : "";
	const paths = Array.isArray(body?.paths)
		? body.paths.filter((path): path is string => typeof path === "string")
		: [];
	switch (code) {
		case "not-a-repository":
			return t("branchErrorNotRepository");
		case "git-unavailable":
			return t("branchErrorGitUnavailable");
		case "invalid-branch-name":
			return t("branchErrorInvalidName");
		case "branch-already-exists":
			return t("branchErrorAlreadyExists");
		case "target-branch-not-found":
			return t("branchErrorNotFound");
		case "tracked-changes-would-be-overwritten":
		case "untracked-changes-would-be-overwritten":
			return t("branchErrorOverwrite", { paths: paths.slice(0, 3).join(", ") });
		case "conflicts-present":
			return t("branchErrorConflicts");
		case "operation-in-progress":
			return t("branchErrorOperation");
		case "branch-in-other-worktree":
			return t("branchErrorWorktree");
		default:
			return errorMessage(error);
	}
}

/** `GET /api/v1/workspace/git`: the folder's state plus its local branches. */
export async function loadBranches(cwd: string): Promise<GitBranchSnapshot> {
	return await api(`/api/v1/workspace/git?${new URLSearchParams({ cwd })}`);
}

/**
 * Switch to an existing local branch (`create: false`), or create one at HEAD
 * and switch to it. Throws an ApiError carrying the host's `code` and `paths`;
 * the caller decides whether to keep its list open.
 */
export async function switchToBranch(cwd: string, branch: string, create = false): Promise<GitWorkspaceState> {
	const { state } = await apiSend<{ state: GitWorkspaceState }>(
		`/api/v1/workspace/git/switch?${new URLSearchParams({ cwd })}`,
		"POST",
		create ? { branch, create: true } : { branch },
	);
	showError(t(create ? "branchCreated" : "branchSwitched", { name: state.branch ?? branch }), false);
	return state;
}
