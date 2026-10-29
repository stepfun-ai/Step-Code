import assert from "node:assert/strict";
import test from "node:test";
import { summaryHeaderState } from "../client/src/features/inspector/model.ts";
import type { SubagentStatus } from "../client/src/state/types.ts";

function header(status: SubagentStatus) {
	return summaryHeaderState([{
		kind: "tool", itemId: "dispatch", toolName: "subagent", state: "completed", inputSummary: "", outputSummary: "",
		subagentTasks: [{ agent: "explore", task: "inspect", status }],
	}], "completed", [], true);
}

test("header counts a running child even when its parent is completed", () => {
	assert.deepEqual(header("running"), { count: 1, state: "running" });
});

test("header preserves unknown history but excludes it and settled agents from the count", () => {
	assert.deepEqual(header("unknown"), { count: 0, state: "unknown" });
	assert.deepEqual(header("completed"), { count: 0, state: "idle" });
});
