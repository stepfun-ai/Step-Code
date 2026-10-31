import { expect, test } from "vitest";
import { decideStepToolCall, stepPermissionStateForPreset } from "../src/step/permissions.ts";

test("clarify_user asks directly while explicit tool policies still apply", () => {
	const state = stepPermissionStateForPreset("ask");
	expect(decideStepToolCall("clarify_user", { question: "Which app?" }, state).action).toBe("allow");
	expect(decideStepToolCall("clarify_user", {}, state, { clarify_user: "deny" }).action).toBe("deny");
	expect(decideStepToolCall("clarify_user", {}, state, { clarify_user: "confirm" }).action).toBe("confirm");
	expect(decideStepToolCall("exit_plan_mode", {}, state).action).toBe("allow");
	expect(decideStepToolCall("exit_plan_mode", {}, state, { exit_plan_mode: "deny" }).action).toBe("deny");
	expect(decideStepToolCall("exit_plan_mode", {}, state, { exit_plan_mode: "confirm" }).action).toBe("confirm");
	expect(decideStepToolCall("write_file", { path: "result.txt", content: "x" }, state).action).toBe("confirm");
});
