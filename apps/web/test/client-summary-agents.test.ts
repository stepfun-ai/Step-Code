import assert from "node:assert/strict";
import { test } from "node:test";
import { activeAgentRecords, latestAgentRecord, summaryAgentRecords } from "../client/src/features/inspector/model.ts";
import { subagentControl, withSubagentLaneState } from "../client/src/state/subagent-tasks.ts";
import type { SubagentStatus, ToolTimelineItem } from "../client/src/state/types.ts";

const tool: ToolTimelineItem = {
	kind: "tool", itemId: "dispatch", toolName: "subagent", state: "completed", inputSummary: "Inspect", outputSummary: "Returned",
};

test("summary preserves per-dispatch task identities, statuses and detail selections", () => {
	const statuses: SubagentStatus[] = ["queued", "running", "completed", "failed", "aborted", "skipped", "unknown"];
	const item: ToolTimelineItem = {
		...tool,
		subagentTasks: statuses.map((status) => ({ agent: "explore", task: `Inspect ${status}`, status })),
	};
	const rows = summaryAgentRecords([item]);
	assert.equal(rows.length, statuses.length);
	assert.equal(new Set(rows.map((row) => row.key)).size, statuses.length);
	assert.deepEqual(rows.map((row) => row.status), statuses);
	assert.deepEqual(rows[3].target, { kind: "task", toolItemId: "dispatch", taskIndex: 3 });
	assert.equal(rows[3].task, "Inspect failed");
	assert.equal(item.subagentTasks?.[3].status, "failed");
});

test("structured records take precedence over child links so one dispatch is not counted twice", () => {
	const rows = summaryAgentRecords([{
		...tool,
		subagentTasks: [{ agent: "review", task: "Review", status: "completed", sessionId: "child" }],
		children: [{ sessionId: "child", label: "review" }],
		workflowRun: "run",
	}]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].target.kind, "task");
});

test("legacy child and workflow records retain navigation without inventing lifecycle status", () => {
	const rows = summaryAgentRecords([
		{ ...tool, children: [{ sessionId: "child", label: "review" }] },
		{ ...tool, itemId: "workflow", toolName: "workflow", workflowRun: "run" },
		{ ...tool, itemId: "legacy-send", toolName: "agent_send", state: "failed" },
	]);
	assert.deepEqual(rows.map((row) => row.status), ["unknown", "unknown"]);
	assert.deepEqual(rows[0].target, { kind: "child", sessionId: "child" });
	assert.deepEqual(rows[1].target, { kind: "workflow", runId: "run" });
	assert.equal(rows.length, 2, "control calls are not standalone agents");
});

test("ordinary tools and model prose do not create agent records", () => {
	assert.deepEqual(summaryAgentRecords([
		{ ...tool, toolName: "read", inputSummary: "subagent finished" },
		{ kind: "message", itemId: "assistant", role: "assistant", content: "Agent completed" },
	]), []);
	assert.deepEqual(summaryAgentRecords([]), []);
});

test("new structured notifications already projected in the timeline update the same record", () => {
	const before = summaryAgentRecords([{ ...tool, subagentTasks: [{ agent: "review", task: "Review", status: "running" }] }]);
	const after = summaryAgentRecords([{ ...tool, subagentTasks: [{ agent: "review", task: "Review", status: "failed" }] }]);
	assert.equal(before[0].key, after[0].key);
	assert.equal(before[0].status, "running");
	assert.equal(after[0].status, "failed");
});

test("reply and stop update the original agent and stay in its operation history", () => {
	const dispatch: ToolTimelineItem = { ...tool, subagentTasks: [{ agent: "explore", task: "Inspect", backgroundAgentId: "lane-1", status: "queued" }] };
	const controls: ToolTimelineItem[] = ["reply", "stop"].map((action, index) => ({ ...tool, itemId: `control-${action}`, toolName: "agent_send",
		subagentControl: subagentControl({ lane_id: "lane-1", action, prompt: action === "reply" ? "supplement" : undefined }, [{ agentId: "lane-1", status: index ? "aborted" : "running", results: [{ agent: "explore", task: "supplement", sessionId: "child-1", status: index ? "aborted" : "running" }] }]),
	}));
	const items = withSubagentLaneState([dispatch, ...controls]);
	const rows = summaryAgentRecords(items);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].agent, "explore");
	assert.equal(rows[0].task, "Inspect");
	assert.equal(rows[0].status, "aborted");
	assert.deepEqual(latestAgentRecord(items)?.target, { kind: "task", toolItemId: "dispatch", taskIndex: 0 });
	const [merged] = withSubagentLaneState(items);
	assert.equal(merged?.kind === "tool" && merged.subagentTasks?.[0]?.sessionId, "child-1");
	assert.deepEqual(merged?.kind === "tool" && merged.subagentTasks?.[0]?.controls?.map((control) => control.action), ["reply", "stop"]);
});

test("identities deduplicate repeated child references but never collapse a parallel lane", () => {
	const dispatch: ToolTimelineItem = { ...tool, subagentTasks: [0, 1].map((index) => ({ agent: "explore", task: `task ${index}`, backgroundAgentId: "parallel", sessionId: `child-${index}`, status: "running" })) };
	const linked: ToolTimelineItem = { ...tool, itemId: "legacy-link", children: [{ sessionId: "child-0", label: "explore" }] };
	const rows = summaryAgentRecords([dispatch, linked]);
	assert.equal(rows.length, 2);
	assert.notEqual(rows[0].key, rows[1].key);
	assert.deepEqual(rows[0].target, { kind: "task", toolItemId: "dispatch", taskIndex: 0 });
	assert.deepEqual(rows[1].target, { kind: "task", toolItemId: "dispatch", taskIndex: 1 });
});

test("a control with structured child results still cannot create a new agent", () => {
	assert.deepEqual(summaryAgentRecords([{ ...tool, toolName: "agent_send", subagentTasks: [{ agent: "explore", task: "supplement", status: "aborted", sessionId: "child" }] }]), []);
});

test("summary lists and counts only running agents without removing historical navigation", () => {
	const statuses: SubagentStatus[] = ["queued", "running", "completed", "failed", "aborted", "skipped", "unknown"];
	const items: ToolTimelineItem[] = [{ ...tool, subagentTasks: statuses.map((status, index) => ({ agent: "explore", task: status, status, sessionId: `child-${index}` })) }];
	assert.equal(activeAgentRecords(items).length, 1);
	assert.equal(activeAgentRecords(items)[0].status, "running");
	assert.equal(summaryAgentRecords(items).length, 7);
	assert.deepEqual(summaryAgentRecords(items)[2].target, { kind: "task", toolItemId: "dispatch", taskIndex: 2 });
	assert.equal(activeAgentRecords([{ ...tool, subagentTasks: [{ agent: "explore", task: "done", status: "completed" }] }]).length, 0);
});
