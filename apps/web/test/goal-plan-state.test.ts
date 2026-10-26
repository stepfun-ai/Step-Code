import assert from "node:assert/strict";
import test from "node:test";
import { projectGoal, projectPlanMode } from "../src/runtime.ts";

const goal = {
	id: "g1",
	sessionId: "s1",
	objective: "map the repository",
	status: "active" as const,
	tokensUsed: 120,
	timeUsedSeconds: 30,
	createdAt: "2026-10-22T00:00:00.000Z",
	updatedAt: "2026-10-22T00:01:00.000Z",
	iteration: 3,
};

test("a goal is projected for the summary section without internal fields", () => {
	assert.deepEqual(projectGoal(goal), {
		id: "g1",
		objective: "map the repository",
		status: "active",
		tokensUsed: 120,
		timeUsedSeconds: 30,
		rounds: 3,
	});
});

test("an unbounded goal carries no budget, a bounded one does", () => {
	assert.equal("tokenBudget" in (projectGoal(goal) ?? {}), false);
	assert.equal(projectGoal({ ...goal, tokenBudget: 5000 })?.tokenBudget, 5000);
});

test("a session without a goal projects nothing, so the strip stays hidden", () => {
	assert.equal(projectGoal(undefined), undefined);
});

test("plan mode reports off when the branch records nothing", () => {
	assert.deepEqual(projectPlanMode(undefined), { enabled: false });
});

test("an active plan carries its file and source", () => {
	assert.deepEqual(projectPlanMode({ enabled: true, planFilePath: "/w/.stepcode/plans/s.md", planSource: "user" }), {
		enabled: true,
		planFilePath: "/w/.stepcode/plans/s.md",
		planSource: "user",
	});
});

test("an exited plan keeps the file path for reference but no source", () => {
	assert.deepEqual(projectPlanMode({ enabled: false, planFilePath: "/w/plans/s.md", planSource: "user" }), {
		enabled: false,
		planFilePath: "/w/plans/s.md",
	});
});
