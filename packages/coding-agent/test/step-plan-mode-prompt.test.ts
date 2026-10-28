import { expect, test } from "vitest";
import { buildDefaultModePrompt, buildPlanModePrompt } from "../src/features/plan-mode-prompt.ts";

test("the plan block names the plan file and Step's real plan tools", () => {
	const prompt = buildPlanModePrompt("/work/.stepcode/plans/session-1.md");
	expect(prompt.startsWith("<collaboration_mode>")).toBe(true);
	expect(prompt.endsWith("</collaboration_mode>")).toBe(true);
	expect(prompt).toContain("/work/.stepcode/plans/session-1.md");
	for (const phrase of ["exit_plan_mode", "write_file", "edit_file", "clarify_user", "task_*", "run_command"]) {
		expect(prompt).toContain(phrase);
	}
	expect(prompt).toContain("decision complete");
	expect(prompt).toContain("does not change the mode");
	// Codex mechanics that do not exist in Step must not leak into the block.
	for (const missing of ["<proposed_plan>", "update_plan", "request_user_input", "enter_plan_mode"]) {
		expect(prompt).not.toContain(missing);
	}
});

test("the Default block supersedes plan mode and keeps entry with the user", () => {
	const prompt = buildDefaultModePrompt();
	expect(prompt).toContain("Collaboration Mode: Default");
	expect(prompt).toContain("no longer active");
	expect(prompt).toContain("/plan");
	expect(prompt).toContain("--plan");
	expect(prompt).not.toContain("enter_plan_mode");
	expect(prompt.length).toBeLessThan(600);
});
