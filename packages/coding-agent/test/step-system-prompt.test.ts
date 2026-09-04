import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildStepSystemPromptAppendix } from "../src/step/system-prompt.ts";

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

	it("adds calendar scheduling guidance only when cron tools are active", () => {
		const withCron = buildStepSystemPromptAppendix(["read_file", "cron_create", "cron_list", "cron_delete"]);
		expect(withCron).toContain("# Scheduled work");
		expect(withCron).toContain("five-field local-time");
		expect(withCron).toContain("schedule_wakeup");

		const withoutCron = buildStepSystemPromptAppendix(["read_file"]);
		expect(withoutCron).not.toContain("# Scheduled work");
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
				const repo = buildStepSystemPromptAppendix([], { cwd: root });
				expect(repo).toContain("Git branch: step-env-test");
				expect(repo).toContain("Uncommitted changes: 1");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it("never crashes on a nonexistent working directory", () => {
		const prompt = buildStepSystemPromptAppendix([], { cwd: "/nonexistent/step-prompt-env" });
		expect(prompt).toContain("<env>");
		expect(prompt).not.toContain("Git branch:");
	});
});
