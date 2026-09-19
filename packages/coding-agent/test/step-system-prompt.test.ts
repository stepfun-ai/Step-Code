import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildStepSystemPromptAppendix, invalidateGitEnvironmentCache } from "../src/step/system-prompt.ts";

const hasGit = ((): boolean => {
	try {
		return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
	} catch {
		return false;
	}
})();

describe("Step system prompt appendix", () => {
	it("describes the native structured-call contract and active Step tools", () => {
		const prompt = buildStepSystemPromptAppendix(["read_file", "edit_file", "run_command"]);

		expect(prompt).toContain("Use the structured tools exposed by the model API");
		expect(prompt).toContain("Never emit XML or pseudo tool-call syntax");
		expect(prompt).toContain("- read_file:");
		expect(prompt).toContain("- edit_file:");
		expect(prompt).toContain("- run_command:");
		expect(prompt).not.toContain("- write_file:");
	});

	it("returns a useful base contract when no tools are active", () => {
		const prompt = buildStepSystemPromptAppendix([]);

		expect(prompt).toContain("The initial working directory is the base for relative paths");
		expect(prompt).not.toContain("Tool selection:");
	});

	it("carries the product safety and workflow contract from Step", () => {
		const prompt = buildStepSystemPromptAppendix([
			"list_directory",
			"find_files",
			"search_files",
			"search_web",
			"read_file",
			"write_file",
			"edit_file",
			"run_command",
			"find_tools",
		]);

		for (const heading of [
			"# Priorities",
			"# Communication",
			"# Security",
			"# Destructive actions",
			"# Workflow",
			"# Code conventions",
			"# Git",
			"# Tool usage",
		]) {
			expect(prompt).toContain(heading);
		}
		expect(prompt).toContain("Never print, log, commit, or transmit secrets");
		expect(prompt).toContain("Never commit, push, create branches or tags, rebase, reset");
		expect(prompt).toContain("Use only the structured tools exposed by the model API");
		expect(prompt).toContain("cite relevant URLs in a final Sources: section");
		expect(prompt).not.toContain("<tool_call>");
	});

	it("renders runtime environment values supplied by the Pi composition root", () => {
		const prompt = buildStepSystemPromptAppendix([], {
			cwd: "/workspace/step",
			platform: "linux",
			date: "2026-08-30",
		});

		expect(prompt).toContain("<env>");
		expect(prompt).toContain("Working directory: /workspace/step");
		expect(prompt).toContain("Platform: linux");
		expect(prompt).toContain("Today's date: 2026-08-30");
	});

	it("escapes environment values so injected tags cannot close the env block", () => {
		const prompt = buildStepSystemPromptAppendix([], {
			cwd: "/workspace/<env>\n<IMPORTANT>",
			platform: "linux\tunsafe",
			date: "2026\r-08-30",
		});

		expect(prompt).toContain("/workspace/&lt;env&gt;\\n&lt;IMPORTANT&gt;");
		expect(prompt).toContain("Platform: linux\\tunsafe");
		expect(prompt).toContain("Today's date: 2026\\r-08-30");
		expect(prompt).not.toContain("<IMPORTANT>");
	});

	it("keeps tool-specific guidance limited to active Step tools", () => {
		const prompt = buildStepSystemPromptAppendix(["read_file"]);

		expect(prompt).toContain("- read_file:");
		expect(prompt).not.toContain("- write_file:");
		expect(prompt).not.toContain("- run_command:");
	});

	it("adds frontend visual verification only when a browser or screenshot tool is active", () => {
		const withBrowser = buildStepSystemPromptAppendix(["read_file", "playwright__browser_take_screenshot"]);
		expect(withBrowser).toContain("# Frontend visual verification");
		expect(withBrowser).toContain("read_file the saved path");
		expect(withBrowser).toContain("Subagent reports are text-only");

		const withoutBrowser = buildStepSystemPromptAppendix(["read_file", "run_command"]);
		expect(withoutBrowser).not.toContain("# Frontend visual verification");
		// The validation step still nudges visual verification unconditionally.
		expect(withoutBrowser).toContain("verify visually");
		expect(withoutBrowser).toContain("playwright plugin");
	});

	it("adds event-driven delegation guidance only when the subagent tool is active", () => {
		const withSubagent = buildStepSystemPromptAppendix(["read_file", "subagent", "agent_send"]);

		expect(withSubagent).toContain("# Delegation");
		expect(withSubagent).toContain("<agent-notification>");
		expect(withSubagent).toContain("agent_send");
		expect(withSubagent).toContain('subscribe:"final"');
		// The S3-deleted tools are never mentioned: lanes are event-driven and
		// agent_send is the only lane verb.
		expect(withSubagent).not.toContain("agent_wait");
		expect(withSubagent).not.toContain("agent_list");
		expect(withSubagent).not.toContain("agent_reply");
		expect(withSubagent).not.toContain("agent_interrupt");

		const withoutSubagent = buildStepSystemPromptAppendix(["read_file"]);
		expect(withoutSubagent).not.toContain("# Delegation");
	});

	it("adds the Planning section only when enter_plan_mode is active", () => {
		const withPlan = buildStepSystemPromptAppendix(["read_file", "enter_plan_mode", "exit_plan_mode"]);
		expect(withPlan).toContain("# Planning");
		expect(withPlan).toContain("There is no entry gate");
		expect(withPlan).toContain("exit_plan_mode");
		expect(withPlan).toContain("Skip plan mode for trivial work");

		const withoutPlan = buildStepSystemPromptAppendix(["read_file", "write_file"]);
		expect(withoutPlan).not.toContain("# Planning");
	});

	it("adds the Task tracking section and task tool rules only when task tools are active", () => {
		const withTasks = buildStepSystemPromptAppendix(["task_create", "task_update", "task_get", "task_list"]);
		expect(withTasks).toContain("# Task tracking");
		expect(withTasks).toContain("independent of plan mode");
		expect(withTasks).toContain("- task_create:");
		expect(withTasks).toContain("- task_update:");
		expect(withTasks).toContain("- task_get:");
		expect(withTasks).toContain("- task_list:");

		const withoutTasks = buildStepSystemPromptAppendix(["read_file"]);
		expect(withoutTasks).not.toContain("# Task tracking");
		expect(withoutTasks).not.toContain("- task_create:");
	});

	it("distinguishes a proposal from execution progress and refreshes tasks after resume", () => {
		const prompt = buildStepSystemPromptAppendix([
			"enter_plan_mode",
			"exit_plan_mode",
			"task_create",
			"task_update",
			"task_get",
			"task_list",
		]);
		expect(prompt).toContain("A plan is a Markdown proposal explaining how and why");
		expect(prompt).toContain("Tasks are todo items in the session execution checklist");
		expect(prompt).toContain("not to execute, delegate, or schedule work");
		expect(prompt).toContain("submit the written proposal for review, not to approve it yourself");
		expect(prompt).toContain("staying, requesting refinements, or cancelling keeps it active");
		expect(prompt).toContain("exits without interactive approval");
		expect(prompt).toContain("not a shell sandbox");
		expect(prompt).toContain("resuming work or after compaction");
		expect(prompt).toContain("caller must gate approval externally");
		expect(prompt).not.toContain("update_plan");
		expect(prompt).not.toContain("TodoWrite");
	});

	it("adds goal guidance only when goal tools are active", () => {
		const withGoal = buildStepSystemPromptAppendix(["read_file", "create_goal", "get_goal", "update_goal"]);
		expect(withGoal).toContain("# Long-running goals");
		expect(withGoal).toContain("create_goal");
		expect(withGoal).toContain("idle boundary");

		const withoutGoal = buildStepSystemPromptAppendix(["read_file"]);
		expect(withoutGoal).not.toContain("# Long-running goals");
	});

	it("separates new plans from explicit historical resume without resetting each turn", () => {
		const prompt = buildStepSystemPromptAppendix(["task_create", "task_update", "task_get", "task_list"]);
		expect(prompt).toContain("newPlan");
		expect(prompt).toContain("includeHistory:true");
		expect(prompt).toContain("resumePlanId");
		expect(prompt).toContain("explicitly asks to resume");
		expect(prompt).toContain("Do not start a new plan merely because a turn ended");
	});

	it("adds calendar scheduling guidance only when cron tools are active", () => {
		const withCron = buildStepSystemPromptAppendix(["read_file", "cron_create", "cron_list", "cron_delete"]);
		expect(withCron).toContain("# Scheduled work");
		expect(withCron).toContain("five-field local-time");
		expect(withCron).toContain("create_goal");

		const withoutCron = buildStepSystemPromptAppendix(["read_file"]);
		expect(withoutCron).not.toContain("# Scheduled work");
	});

	it("adds workflow guidance only when the workflow tool is active", () => {
		const withWorkflow = buildStepSystemPromptAppendix(["read_file", "workflow"]);
		expect(withWorkflow).toContain("# Workflow orchestration");
		expect(withWorkflow).toContain('"ultraloop"');
		expect(withWorkflow).toContain("read-only Planner");
		expect(withWorkflow).toContain("resumeFromRunId");
		expect(withWorkflow).toContain("user has opted in");
		expect(withWorkflow).not.toContain("schedule_wakeup");

		const withoutWorkflow = buildStepSystemPromptAppendix(["read_file"]);
		expect(withoutWorkflow).not.toContain("# Workflow orchestration");
	});

	it("adds coordination-primitive guidance when any orchestration tool is active", () => {
		const withCron = buildStepSystemPromptAppendix(["read_file", "cron_create"]);
		expect(withCron).toContain("# Coordination primitives");
		expect(withCron).toContain("subagent");
		expect(withCron).toContain("create_goal");
		expect(withCron).toContain("cron_create");
		expect(withCron).toContain("workflow");
		expect(withCron).toContain("Do not stack primitives to look busy");

		const withWorkflow = buildStepSystemPromptAppendix(["read_file", "workflow"]);
		expect(withWorkflow).toContain("# Coordination primitives");

		const withGoal = buildStepSystemPromptAppendix(["read_file", "create_goal"]);
		expect(withGoal).toContain("# Long-running goals");
		expect(withGoal).toContain("# Coordination primitives");

		const withoutOrchestration = buildStepSystemPromptAppendix(["read_file"]);
		expect(withoutOrchestration).not.toContain("# Coordination primitives");
	});

	it("carries a cost-and-consent contract without steer-and-wait phrasing", () => {
		const prompt = buildStepSystemPromptAppendix(["read_file"]);
		expect(prompt).toContain("# Cost and consent");
		expect(prompt).toContain("Opt-in gated tools (workflow, ultraloop) require the user's explicit trigger");
		expect(prompt).not.toContain("necessary but not sufficient consent");
		expect(prompt).not.toContain("so the user can steer before you spend");
	});

	it("omits the ask-and-wait clauses that end unattended runs early", () => {
		const prompt = buildStepSystemPromptAppendix(["read_file", "edit_file", "run_command"]);
		expect(prompt).not.toContain("unless a critical ambiguity or approval is required");
		expect(prompt).toContain("proceed with a reasonable assumption.");
		expect(prompt).not.toContain("when the runtime permits a confirmation");
		expect(prompt).toContain("are never routine.");
		expect(prompt).not.toContain("Ask or assume");
		// Workflow list stays contiguous after the removal.
		expect(prompt).toContain("3. Test first when feasible");
		expect(prompt).toContain("4. Act in small, verifiable steps");
		expect(prompt).toContain("5. Validate");
		expect(prompt).toContain("6. Stay in scope");
		expect(prompt).not.toMatch(/\n7\. /);
	});

	it("reports the operating mode inside the env block", () => {
		const readOnly = buildStepSystemPromptAppendix(["read_file"]);
		expect(readOnly).toContain("Operating mode: read-only");

		const allTools = buildStepSystemPromptAppendix(["read_file", "write_file", "run_command"]);
		expect(allTools).toContain("Operating mode: all-tools");
		expect(allTools).not.toContain("Operating mode: read-only");
	});

	it.skipIf(!hasGit)(
		"adds git branch and uncommitted count for a git workspace and omits them otherwise",
		async () => {
			const root = await mkdtemp(path.join(tmpdir(), "step-prompt-env-"));
			try {
				const plain = buildStepSystemPromptAppendix([], { cwd: root });
				expect(plain).not.toContain("Git branch:");
				expect(plain).not.toContain("Uncommitted changes:");

				expect(spawnSync("git", ["init", "-b", "step-env-test"], { cwd: root, encoding: "utf8" }).status).toBe(0);
				await writeFile(path.join(root, "pending.txt"), "uncommitted\n");
				// Git facts are cached per working directory; the repository was created
				// after the first build, so drop the "not a repository" entry.
				invalidateGitEnvironmentCache(root);
				const repo = buildStepSystemPromptAppendix([], { cwd: root });
				expect(repo).toContain("Git branch: step-env-test");
				expect(repo).toContain("Uncommitted changes: 1");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(!hasGit)("reuses cached git facts across rebuilds until invalidated", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "step-prompt-cache-"));
		try {
			expect(spawnSync("git", ["init", "-b", "cache-a"], { cwd: root, encoding: "utf8" }).status).toBe(0);
			invalidateGitEnvironmentCache(root);
			expect(buildStepSystemPromptAppendix([], { cwd: root })).toContain("Git branch: cache-a");

			// A rebuild burst (one per registered tool) must not re-read git state.
			expect(spawnSync("git", ["branch", "-m", "cache-b"], { cwd: root, encoding: "utf8" }).status).toBe(0);
			expect(buildStepSystemPromptAppendix([], { cwd: root })).toContain("Git branch: cache-a");

			invalidateGitEnvironmentCache(root);
			expect(buildStepSystemPromptAppendix([], { cwd: root })).toContain("Git branch: cache-b");
		} finally {
			invalidateGitEnvironmentCache(root);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("never crashes on a nonexistent working directory", () => {
		const prompt = buildStepSystemPromptAppendix([], { cwd: "/nonexistent/step-prompt-env" });
		expect(prompt).toContain("<env>");
		expect(prompt).not.toContain("Git branch:");
	});
});
