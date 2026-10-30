import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { buildPlanModePrompt } from "../src/features/plan-mode-prompt.ts";
import {
	buildStepSystemPromptAppendix,
	invalidateGitEnvironmentCache,
	STEP_APP_SYSTEM_PROMPT_PRODUCT,
} from "../src/step/system-prompt.ts";
import { createStepToolProfile } from "../src/step/tool-profile.ts";

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
		expect(prompt).toContain("then_run on edit_file or write_file");
		expect(buildStepSystemPromptAppendix(["read_file", "edit_file"])).not.toContain("then_run");
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

	it("leaves delegation method to the subagent tool and keeps only the authorization gate", () => {
		const withSubagent = buildStepSystemPromptAppendix(["read_file", "subagent", "agent_send"]);

		// Method and lane mechanics moved into the subagent tool description.
		expect(withSubagent).not.toContain("# Delegation");
		expect(withSubagent).not.toContain("<agent-notification>");
		expect(withSubagent).toContain("# Coordination primitives");
		expect(withSubagent).toContain("Every other primitive needs explicit authorization");
		expect(withSubagent).toContain("subagent when the user, applicable AGENTS.md, or a skill asks");
		// The old automatic escalation is gone everywhere in the prompt.
		expect(withSubagent).not.toContain("long or exploratory task → subagent");
		expect(withSubagent).not.toContain("Escalate only when");
		expect(withSubagent).not.toContain("the parent context is precious");

		const withoutSubagent = buildStepSystemPromptAppendix(["read_file"]);
		expect(withoutSubagent).not.toContain("# Delegation");
	});

	it("never describes plan mode as something the model enters", () => {
		const withPlan = buildStepSystemPromptAppendix(["read_file", "exit_plan_mode"]);
		expect(withPlan).not.toContain("# Planning");
		expect(withPlan).not.toContain("enter_plan_mode");
		expect(withPlan).not.toContain("There is no entry gate");
		expect(withPlan).toContain("# Plan mode");
		expect(withPlan).toContain("only the user starts it, with /plan or --plan");
		expect(withPlan).toContain("<collaboration_mode>");

		const withoutPlan = buildStepSystemPromptAppendix(["read_file", "write_file"]);
		expect(withoutPlan).not.toContain("# Plan mode");
		expect(withoutPlan).not.toContain("<collaboration_mode>");
		// The workflow step tracks progress; it no longer asks for a standing plan.
		expect(withoutPlan).not.toContain("Plan when useful");
		expect(withoutPlan).toContain("A todo list is not a plan proposal");
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
			"exit_plan_mode",
			"task_create",
			"task_update",
			"task_get",
			"task_list",
		]);
		expect(prompt).toContain("Tasks are todo items in the session execution checklist");
		expect(prompt).toContain("not to execute, delegate, or schedule work");
		expect(prompt).toContain("independent of plan mode");
		expect(prompt).toContain("resuming work or after compaction");
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
		expect(withCron).toContain("Each primitive's own tool description or section explains how to use it");

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
		expect(prompt).toContain("subagent requires an explicit delegation request");
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

describe("Step App system prompt product", () => {
	it("identifies the app without terminal wording", () => {
		expect(STEP_APP_SYSTEM_PROMPT_PRODUCT.name).toBe("StepCode");
		expect(STEP_APP_SYSTEM_PROMPT_PRODUCT.role).toBe("a coding agent developed by StepFun");
		expect(STEP_APP_SYSTEM_PROMPT_PRODUCT.introduction).toContain("You are StepCode");
		expect(STEP_APP_SYSTEM_PROMPT_PRODUCT.introduction).toContain("running in the StepCode app");
		expect(STEP_APP_SYSTEM_PROMPT_PRODUCT.introduction).toContain("workspace the user selected");
		// The CLI identity is the one phrase set that must never reach the app.
		expect(STEP_APP_SYSTEM_PROMPT_PRODUCT.introduction).not.toMatch(/terminal/iu);
		expect(STEP_APP_SYSTEM_PROMPT_PRODUCT.introduction).not.toMatch(/StepCode Web/u);
		expect(STEP_APP_SYSTEM_PROMPT_PRODUCT.includeDocumentation).toBe(false);
	});

	it("exposes the shared product read-only to every session", () => {
		// Freezing is only safe while the builder reads the product and never writes
		// into it. Build twice from the same constant: no throw, identical output.
		const build = (): string =>
			buildSystemPrompt({
				product: STEP_APP_SYSTEM_PROMPT_PRODUCT,
				cwd: "/workspace/app",
				selectedTools: ["read_file"],
			});
		expect(build()).toBe(build());
		expect(STEP_APP_SYSTEM_PROMPT_PRODUCT.promptAppendix).toBe(buildStepSystemPromptAppendix);
	});

	it("is frozen so one session cannot rewrite the identity for the others", () => {
		expect(Object.isFrozen(STEP_APP_SYSTEM_PROMPT_PRODUCT)).toBe(true);
		expect(() => {
			(STEP_APP_SYSTEM_PROMPT_PRODUCT as { introduction: string }).introduction = "hijacked";
		}).toThrow();
		expect(STEP_APP_SYSTEM_PROMPT_PRODUCT.introduction).toContain("You are StepCode");
	});

	it("renders the sections for the tools a Web session actually has", () => {
		expect(STEP_APP_SYSTEM_PROMPT_PRODUCT.promptAppendix).toBe(buildStepSystemPromptAppendix);

		// Built-in tool names come from the same profile the host composes; feature
		// tools (plan, tasks, subagent, goal, cron) are registered by the capability
		// extensions the host loads, so they are listed separately.
		const profileTools = createStepToolProfile(process.cwd()).map((tool) => tool.name);
		expect(profileTools).toEqual(
			expect.arrayContaining(["read_file", "write_file", "edit_file", "run_command", "search_web"]),
		);
		const featureTools = ["exit_plan_mode", "task_create", "subagent", "create_goal", "cron_create"];
		const prompt = buildSystemPrompt({
			product: STEP_APP_SYSTEM_PROMPT_PRODUCT,
			cwd: "/workspace/app",
			selectedTools: [...profileTools, ...featureTools],
		});

		expect(prompt.startsWith("You are StepCode, a coding agent developed by StepFun")).toBe(true);
		expect(prompt).toContain("# StepCode operating contract");
		expect(prompt).toContain("<env>");
		expect(prompt).toContain("Operating mode: all-tools");
		expect(prompt).toContain("# Plan mode");
		expect(prompt).toContain("# Task tracking");
		expect(prompt).toContain("# Coordination primitives");
		expect(prompt).toContain("# Long-running goals");
		expect(prompt).toContain("# Scheduled work");
		expect(prompt).toContain("subagent when the user, applicable AGENTS.md, or a skill asks");
		expect(prompt).not.toContain("# Delegation");
		expect(prompt).toContain("- edit_file:");
		expect(prompt).toContain("Tool selection:");
		// Nothing terminal-only from the CLI identity reaches the app prompt.
		expect(prompt).not.toMatch(/StepCode Web/u);
		expect(prompt).not.toMatch(/terminal coding agent|\bTUI\b/u);
		// The product appendix precedes the working-directory trailer.
		expect(prompt.indexOf("# StepCode operating contract")).toBeLessThan(
			prompt.indexOf("Current working directory: /workspace/app"),
		);
	});
});

describe("one-shot interaction contract", () => {
	const featureTools = [
		"read_file",
		"write_file",
		"edit_file",
		"run_command",
		"exit_plan_mode",
		"create_goal",
		"workflow",
	];

	const render = (interaction?: "session" | "one-shot"): string =>
		buildStepSystemPromptAppendix(featureTools, { cwd: "/workspace/app", ...(interaction ? { interaction } : {}) });

	it("drops session-standing ultraloop consent", () => {
		const app = render("one-shot");
		expect(app).not.toContain("ultraloop is on for the session");
		expect(app).not.toContain("session-standing");
		expect(app).not.toContain("every substantive task by default");
		expect(app).not.toContain("token cost as unconstrained");
		// Per-turn consent survives, with the composer's prefix spelled out.
		expect(app).toContain('starts with "ultraloop:"');
		expect(app).toContain("never treat an earlier authorized turn as authorization");
		expect(app).toContain("require the user's explicit trigger on the message being answered");
	});

	it("keeps the CLI's standing wording as the default", () => {
		for (const prompt of [render("session"), render()]) {
			expect(prompt).toContain("ultraloop is on for the session");
			expect(prompt).toContain("every substantive task by default");
			expect(prompt).not.toContain('starts with "ultraloop:"');
		}
	});

	it("keeps planning as investigation: exit reports the proposal, it does not authorize work", () => {
		const app = render("one-shot");
		expect(app).toContain("Plan mode is user-controlled");
		expect(app).toContain("<collaboration_mode> message");
		expect(app).not.toContain("Call enter_plan_mode");
		// Mode instructions come from the append-only announcement, not the
		// app's system prefix. External exit is a handoff, not approval.
		const announcement = buildPlanModePrompt("/workspace/app/plan.md", true);
		expect(announcement).toContain("You must not perform mutating actions");
		expect(announcement).toContain("does not approve implementation");
		expect(announcement).toContain("exit_plan_mode hands a new proposal to an external reviewer");
		expect(announcement).toContain("leave planning without a proposal");
		expect(render("session")).toContain("Plan mode is user-controlled");
	});

	it("keeps goal continuation but forbids the model from replacing a goal", () => {
		const app = render("one-shot");
		// Option (b): a goal still runs across turns until complete.
		expect(app).toContain("continue automatically at the host's idle boundary");
		expect(app).toContain("Never start a goal on your own initiative");
		expect(app).toContain("never call create_goal to replace a goal that already exists");

		const cli = render("session");
		expect(cli).toContain("continue automatically at the host's idle boundary");
		expect(cli).not.toContain("never call create_goal to replace a goal that already exists");
	});
});
