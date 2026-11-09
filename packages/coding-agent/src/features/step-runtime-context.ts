/**
 * Runtime context that changes during a session, kept out of the system prompt.
 *
 * The provider caches the request prefix: tools, then the system prompt, then
 * history. The git branch used to live in the system prompt's <env> block, so
 * any prompt rebuild after a checkout rewrote the system prompt and re-billed
 * the whole conversation as cache writes. Between rebuilds the model saw a
 * stale branch.
 *
 * Instead, the branch rides a runtime-context snapshot appended to history: a
 * hidden custom message added beside the user's prompt only when the branch
 * differs from the last snapshot in the active context. Each snapshot states it
 * supersedes earlier ones, so history stays append-only and the cached prefix
 * survives. Working-tree changes are not announced: they are mostly the agent's
 * own edits, and the system prompt already tells it to inspect git state.
 */

import { execFile } from "node:child_process";
import type { AgentMessage } from "@step-harness/agent-core";
import type { ExtensionAPI, ExtensionFactory } from "../core/extensions/types.ts";
import { encodeEnvironmentValue } from "../step/system-prompt.ts";

export const STEP_RUNTIME_CONTEXT_TYPE = "step-runtime-context";

/**
 * The checked-out branch, `DETACHED_HEAD` for a detached HEAD, or null outside
 * a git repository. Git refuses a branch named "HEAD", so the sentinel cannot
 * collide with a real branch.
 */
export type GitBranch = string | null;
export const DETACHED_HEAD = "HEAD";

interface RuntimeContextDetails {
	version: 1;
	branch: GitBranch;
}

export interface StepRuntimeContextExtensionOptions {
	/** Reads the branch for a working directory; undefined when git cannot tell. Injectable for tests. */
	readBranch?: (cwd: string) => Promise<GitBranch | undefined>;
}

const GIT_TIMEOUT_MS = 1500;

/**
 * One `git symbolic-ref` call distinguishes all three states: exit 0 prints the
 * branch (also before the first commit), exit 1 means a detached HEAD, and exit
 * 128 means no repository. Any other failure (no git binary, timeout) is
 * undefined so the caller announces nothing rather than a wrong fact.
 */
export function readGitBranch(cwd: string): Promise<GitBranch | undefined> {
	return new Promise((resolve) => {
		try {
			execFile(
				"git",
				["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
				{ cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true },
				(error, stdout) => {
					if (!error) return resolve(stdout.trim() || undefined);
					if (error.code === 1) return resolve(DETACHED_HEAD);
					if (error.code === 128) return resolve(null);
					resolve(undefined);
				},
			);
		} catch {
			resolve(undefined);
		}
	});
}

function describeBranch(branch: GitBranch): string {
	if (branch === null) return "Git: the working directory is not inside a git repository.";
	if (branch === DETACHED_HEAD) return "Git branch: none (detached HEAD)";
	return `Git branch: ${encodeEnvironmentValue(branch)}`;
}

export function buildRuntimeContextText(branch: GitBranch): string {
	return [
		"<system-reminder>",
		"Current runtime context. This snapshot supersedes earlier runtime-context snapshots.",
		describeBranch(branch),
		"</system-reminder>",
	].join("\n");
}

interface SnapshotRecord {
	customType?: string;
	details?: unknown;
}

/** The branch of the newest snapshot in the given context, or undefined when none is visible. */
function lastSnapshot(records: readonly SnapshotRecord[]): GitBranch | undefined {
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index]!;
		if (record.customType !== STEP_RUNTIME_CONTEXT_TYPE) continue;
		const details = record.details as Partial<RuntimeContextDetails> | undefined;
		if (details?.version === 1 && details.branch !== undefined) return details.branch;
	}
	return undefined;
}

function snapshotMessage(branch: GitBranch) {
	return {
		customType: STEP_RUNTIME_CONTEXT_TYPE,
		content: buildRuntimeContextText(branch),
		display: false,
		details: { version: 1, branch } satisfies RuntimeContextDetails,
	};
}

export function createStepRuntimeContextExtension(options: StepRuntimeContextExtensionOptions = {}): ExtensionFactory {
	const readBranch = options.readBranch ?? readGitBranch;
	return (pi: ExtensionAPI): void => {
		// The branch the model should currently see; undefined while there is nothing to state.
		let current: GitBranch | undefined;

		pi.on("session_start", () => {
			current = undefined;
		});

		// Read once per user prompt and persist a snapshot beside it only when the
		// branch changed since the last one the model can see.
		pi.on("before_agent_start", async (_event, ctx) => {
			const branch = await readBranch(ctx.cwd);
			if (branch === undefined) return;
			const previous = lastSnapshot(
				ctx.sessionManager.buildContextEntries().filter((entry) => entry.type === "custom_message"),
			);
			// Outside a repository with nothing announced yet, there is nothing to correct.
			current = previous === undefined && branch === null ? undefined : branch;
			if (current === undefined || previous === current) return;
			return { message: snapshotMessage(current) };
		});

		// Compaction can summarize the persisted snapshot away mid-run. Restore it
		// for this request only, at the tail, so the cached prefix is untouched;
		// the next prompt persists a fresh one.
		pi.on("context", (event) => {
			if (current === undefined) return;
			const visible = lastSnapshot(
				event.messages.filter((message): message is AgentMessage & SnapshotRecord => message.role === "custom"),
			);
			if (visible === current) return;
			return {
				messages: [
					...event.messages,
					{ role: "custom" as const, ...snapshotMessage(current), timestamp: Date.now() },
				],
			};
		});
	};
}
