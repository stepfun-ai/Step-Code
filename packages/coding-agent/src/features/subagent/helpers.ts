/**
 * Pure utilities shared by the Step subagent modules: usage accounting
 * (emptyUsage/cloneUsage), label sanitization and child-tool alias
 * normalization, the git worktree allocator used for workspace isolation,
 * resolution of the current Step invocation for child spawns, and the
 * plain-record guard. Tool registration, event projection (parseJsonEvent),
 * and the child runner stay in step-subagent.ts.
 */

import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { StepSubagentUsage, StepWorktreeLease } from "../step-subagent.ts";

const execFile = promisify(execFileCallback);

/** Tool names in agent files may use either Pi's native names or Step's
 * model-facing aliases. Child Step processes expose the latter. */
const TOOL_ALIASES: Readonly<Record<string, string>> = {
	read: "read_file",
	bash: "run_command",
	edit: "edit_file",
	write: "write_file",
	find: "find_files",
	grep: "search_files",
	ls: "list_directory",
};

export function emptyUsage(): StepSubagentUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

export function cloneUsage(usage: StepSubagentUsage): StepSubagentUsage {
	return { ...usage };
}

export function sanitizeLabel(value: string, fallback = "agent"): string {
	const cleaned = value
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
	return cleaned || fallback;
}

export function normalizeChildTools(tools: readonly string[] | undefined): string[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return [...new Set(tools.map((tool) => TOOL_ALIASES[tool] ?? tool).filter((tool) => tool.length > 0))];
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	const result = await execFile("git", ["-C", cwd, ...args], {
		maxBuffer: 2 * 1024 * 1024,
	});
	return result.stdout.trim();
}

/** Create a detached branch/worktree outside the repository. Keeping the
 * worktree outside the project avoids exposing it to the parent agent's file
 * tools while still making the path available in the result for review or
 * cherry-picking. */
export async function allocateStepWorktree(baseCwd: string, label: string): Promise<StepWorktreeLease> {
	const repositoryRoot = await runGit(baseCwd, ["rev-parse", "--show-toplevel"]);
	if (!repositoryRoot) throw new Error("The child working directory is not a Git repository");

	const parent = await mkdtemp(path.join(os.tmpdir(), "stepcode-worktree-"));
	const worktreePath = path.join(parent, "workspace");
	const branch = `step-agent/${sanitizeLabel(label)}-${randomUUID().slice(0, 8)}`;
	try {
		await runGit(repositoryRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
	} catch (error) {
		await rm(parent, { recursive: true, force: true });
		throw error;
	}

	let cleaned = false;
	return {
		path: worktreePath,
		branch,
		cleanup: async () => {
			if (cleaned) return;
			cleaned = true;
			try {
				await runGit(repositoryRoot, ["worktree", "remove", "--force", worktreePath]);
			} finally {
				await rm(parent, { recursive: true, force: true });
			}
		},
	};
}

export function currentStepInvocation(args: string[]): {
	command: string;
	args: string[];
} {
	const script = process.argv[1];
	const virtualScript = script?.startsWith("/$bunfs/") || script?.includes("$bunfs");
	if (script && !virtualScript && existsSync(script) && /\.(?:[cm]?js|[cm]?ts)$/iu.test(script)) {
		// Source launches need tsx's preflight and ESM loader as well as argv[1].
		// Forward only preload/loader options: debugger ports and parent-only
		// execution modes must not be copied to every subagent.
		const loaderArgs: string[] = [];
		for (let index = 0; index < process.execArgv.length; index += 1) {
			const arg = process.execArgv[index];
			if (/^(?:--require|--import|--loader|--experimental-loader|-r)$/u.test(arg)) {
				const value = process.execArgv[index + 1];
				if (value !== undefined) {
					loaderArgs.push(arg, value);
					index += 1;
				}
			} else if (/^(?:--require|--import|--loader|--experimental-loader)=/u.test(arg) || /^-r.+/u.test(arg)) {
				loaderArgs.push(arg);
			}
		}
		return { command: process.execPath, args: [...loaderArgs, script, ...args] };
	}

	const executable = path.basename(process.execPath).toLowerCase();
	if (!/^(?:node|bun)(?:\.exe)?$/u.test(executable)) {
		return { command: process.execPath, args };
	}
	return { command: "step", args };
}

export function isRecordValue(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Session-id prefixes for the child processes Step spawns: `subagent` lanes and
 * `workflow` agents (both run through `runStepSubagentProcess`).
 *
 * A child runs in the parent's cwd, so its transcript lands in the same per-cwd
 * session directory as the parent's, and a single fan-out can add a dozen of
 * them. The prefix is the only marker separating the two, so the resume picker
 * filters on it to keep the list to sessions a user actually started.
 */
export const SUBAGENT_SESSION_ID_PREFIX = "subagent-";
export const WORKFLOW_SESSION_ID_PREFIX = "workflow-";

/** True for a session written by a spawned child agent, not by a user. */
export function isChildAgentSessionId(sessionId: string): boolean {
	return sessionId.startsWith(SUBAGENT_SESSION_ID_PREFIX) || sessionId.startsWith(WORKFLOW_SESSION_ID_PREFIX);
}
