import assert from "node:assert/strict";
import { test } from "node:test";
import { summaryActivityTurn } from "../client/src/state/right-panel.ts";
import { createInitialState, type AppState } from "../client/src/state/store.ts";
import type { TimelineItem } from "../client/src/state/types.ts";

function snapshot(timelineItems: readonly TimelineItem[]): AppState {
	return { ...createInitialState(), current: { id: "session", cwd: "/fixture", status: "idle" }, timelineItems };
}

test("summary reveals a task only once its result names one", () => {
	for (const toolName of ["task_create", "task_update"]) {
		for (const state of ["pending", "completed", "failed"] as const) {
			// A call with no result yet has nothing to list.
			assert.equal(summaryActivityTurn(snapshot([
				{ kind: "message", itemId: "u1", role: "user", content: "Work" },
				{ kind: "tool", itemId: "t1", toolName, state, inputSummary: "", outputSummary: "" },
			])), null);
			assert.equal(summaryActivityTurn(snapshot([
				{ kind: "message", itemId: "u1", role: "user", content: "Work" },
				{ kind: "tool", itemId: "t1", toolName, state, inputSummary: "", outputSummary: "Created task 1: align" },
			])), "u1");
		}
	}
});

test("only running agents reveal the summary; controls and settled dispatches do not", () => {
	for (const toolName of ["subagent", "agent_send"]) {
		for (const state of ["pending", "completed", "failed"] as const) {
			assert.equal(summaryActivityTurn(snapshot([
				{ kind: "message", itemId: "u1", role: "user", content: "Work" },
				{ kind: "tool", itemId: "t1", toolName, state, inputSummary: "", outputSummary: "" },
			])), null);
		}
	}
	assert.equal(summaryActivityTurn(snapshot([
		{ kind: "message", itemId: "u1", role: "user", content: "Work" },
		{ kind: "tool", itemId: "t1", toolName: "subagent", state: "completed", inputSummary: "", outputSummary: "",
			subagentTasks: [{ agent: "explore", task: "Inspect", status: "running" }] },
	])), "u1");
});

test("a failed or empty task call does not open the board on its own", () => {
	// The user's report: the panel opened over the answer with an empty checklist.
	assert.equal(summaryActivityTurn(snapshot([
		{ kind: "message", itemId: "u1", role: "user", content: "Explain this" },
		{ kind: "tool", itemId: "t1", toolName: "task_create", state: "failed", inputSummary: "", outputSummary: "" },
		{ kind: "message", itemId: "a1", role: "assistant", content: "Here is the answer." },
	])), null);
});

test("old activity does not trigger on a new user turn, ordinary tools or thinking", () => {
	assert.equal(summaryActivityTurn(snapshot([
		{ kind: "tool", itemId: "old", toolName: "task_create", state: "completed", inputSummary: "", outputSummary: "" },
		{ kind: "message", itemId: "u2", role: "user", content: "Read a file" },
		{ kind: "thinking", itemId: "thought", content: "task_create", running: true },
		{ kind: "tool", itemId: "t2", toolName: "read", state: "completed", inputSummary: "agent_send", outputSummary: "" },
	])), null);
	assert.equal(summaryActivityTurn(createInitialState()), null);
});

test("structured subagent tasks and history without a user entry remain eligible", () => {
	assert.equal(summaryActivityTurn(snapshot([
		{ kind: "tool", itemId: "t1", toolName: "workflow", state: "pending", inputSummary: "", outputSummary: "",
			subagentTasks: [{ agent: "explore", task: "Inspect", status: "running" }] },
	])), "history");
	// An unknown lane status has no record to show yet.
	assert.equal(summaryActivityTurn(snapshot([
		{ kind: "tool", itemId: "t1", toolName: "workflow", state: "pending", inputSummary: "", outputSummary: "",
			subagentTasks: [{ agent: "explore", task: "Inspect", status: "unknown" }] },
	])), null);
});

test("same-turn activity updates retain one stable reveal key", () => {
	const data = snapshot([
		{ kind: "message", itemId: "u1", role: "user", content: "Work" },
		{ kind: "tool", itemId: "t1", toolName: "task_create", state: "completed", inputSummary: "", outputSummary: "Task 1" },
	]);
	assert.equal(summaryActivityTurn(data), summaryActivityTurn({
		...data,
		timelineItems: [...data.timelineItems,
			{ kind: "tool", itemId: "t2", toolName: "agent_send", state: "completed", inputSummary: "", outputSummary: "" },
		],
	}));
});
