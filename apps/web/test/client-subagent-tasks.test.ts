import assert from "node:assert/strict";
import test from "node:test";
import { liveMessageTimeline, timelineFromEntries } from "../client/src/state/session.ts";
import { backgroundSubagentStatuses, subagentTasks } from "../client/src/state/subagent-tasks.ts";
import type { SessionEntry, SubagentStatus, ToolTimelineItem } from "../client/src/state/types.ts";

const planned = { chain: [{ agent: "explore", task: "Inspect parser" }, { agent: "review", task: "Review output" }] };
const call = { type: "toolCall", id: "s1", name: "subagent", arguments: planned };

function entries(details: unknown, isError = false): SessionEntry[] {
	return [
		{ id: "a", type: "message", message: { role: "assistant", content: [call] } },
		{ id: "r", type: "message", message: { role: "toolResult", toolName: "subagent", toolCallId: "s1", content: "original output", details, isError } },
	];
}

test("single, parallel and chain plans show queued tasks, never invent a running result", () => {
	for (const input of [{ agent: "explore", task: "Inspect" }, { tasks: planned.chain }, planned]) {
		const tasks = subagentTasks(input, undefined, "pending");
		assert.ok(tasks.length);
		assert.ok(tasks.every(task => task.status === "queued"));
		assert.ok(subagentTasks(input, undefined, "completed").every(task => task.status === "unknown"));
	}
});

test("all six structured states and inspector metadata are retained", () => {
	const statuses: SubagentStatus[] = ["queued", "running", "completed", "failed", "aborted", "skipped"];
	const tasks = subagentTasks({}, {
		results: statuses.map(status => ({ agent: "explore", task: status, status, model: "fixture-model", usage: { turns: 0 }, sessionId: `child-${status}`, errorMessage: status === "failed" ? "read denied" : undefined })),
	}, "pending");
	assert.deepEqual(tasks.map(task => task.status), statuses);
	assert.equal(tasks[0]?.turns, 0);
	assert.equal(tasks[0]?.model, "fixture-model");
	assert.equal(tasks[0]?.sessionId, "child-queued");
	assert.equal(tasks[3]?.error, "read denied");
});

test("missing or invalid statuses are unknown, regardless of output or exit code", () => {
	for (const status of [undefined, "done", 1, null]) {
		const [task] = subagentTasks({}, { results: [{ agent: "explore", status, exitCode: 0, usage: { turns: -1 } }] }, "completed");
		assert.equal(task?.status, "unknown");
		assert.equal(task?.turns, undefined);
	}
	for (const details of [null, [], { results: [null, [], 1, {}, { status: "running" }] }]) {
		assert.deepEqual(subagentTasks({}, details, "pending"), []);
	}
});

test("a rejected dispatch keeps its planned rows as failed attempts carrying the tool's error", () => {
	const previous = subagentTasks(planned, undefined, "pending");
	const rejected = subagentTasks(planned, {}, "failed", previous, "Invalid parameters. Provide exactly one mode.");
	assert.deepEqual(rejected.map(task => task.status), ["failed", "failed"]);
	assert.deepEqual(rejected.map(task => task.error), [
		"Invalid parameters. Provide exactly one mode.",
		"Invalid parameters. Provide exactly one mode.",
	]);
	// The same projection without earlier rows still names the attempt from its arguments.
	const [single] = subagentTasks({ agent: "general", task: "Audit" }, {}, "failed", [], "Invalid parameters.");
	assert.equal(single?.status, "failed");
	assert.equal(single?.error, "Invalid parameters.");
	const [row] = timelineFromEntries(entries({}, true));
	assert.equal(row?.kind === "tool" && row.state, "failed");
	assert.equal(row?.kind === "tool" && row.outputDetail, "original output");
	assert.deepEqual(
		row?.kind === "tool" && row.subagentTasks?.map(task => [task.status, task.error]),
		[
			["failed", "original output"],
			["failed", "original output"],
		],
	);
});

test("a dispatch that fails mid-chain fails only the steps that never settled", () => {
	const previous = subagentTasks(planned, undefined, "pending");
	const settled = previous.map((task, index) => (index === 0 ? { ...task, status: "completed" as const } : task));
	assert.deepEqual(
		subagentTasks(planned, undefined, "failed", settled, "dispatch aborted").map(task => [task.status, task.error]),
		[
			["completed", undefined],
			["failed", "dispatch aborted"],
		],
	);
});

test("history keeps per-task failures distinct from the aggregate dispatch status", () => {
	const [row] = timelineFromEntries(entries({ results: [{ agent: "review", task: "Inspect", status: "failed", errorMessage: "denied" }] }, true));
	assert.equal(row?.kind === "tool" && row.subagentTasks?.[0]?.status, "failed");
	assert.equal(row?.kind === "tool" && row.subagentTasks?.[0]?.error, "denied");
});

test("later assistant chunks preserve live task progress and child links", () => {
	const [task] = subagentTasks({}, { results: [{ agent: "explore", task: "Inspect", status: "running", sessionId: "child-1" }] }, "pending");
	const row: ToolTimelineItem = {
		kind: "tool", itemId: "tool-s1", toolName: "subagent", state: "pending", inputSummary: "", outputSummary: "progress",
		subagentTasks: [task!], children: [{ sessionId: "child-1", label: "explore" }],
	};
	const [updated] = liveMessageTimeline([row], [call]);
	assert.equal(updated?.kind === "tool" && updated.subagentTasks, row.subagentTasks);
	assert.equal(updated?.kind === "tool" && updated.children, row.children);
});

test("background notification before dispatch result is recovered without parsing prose", () => {
	const history = entries({ agentId: "lane-1", status: "running", results: [{ agent: "explore", task: "Inspect", status: "running" }] });
	history.unshift({ id: "n", type: "custom_message", customType: "agent-notification", details: { agentId: "lane-1", event: "background_done", status: "completed" } });
	const [row] = timelineFromEntries(history);
	assert.equal(row?.kind === "tool" && row.subagentTasks?.[0]?.status, "completed");
});

test("background failures do not overwrite already-completed chain steps", () => {
	const history = entries({
		agentId: "lane-1", status: "running",
		results: [
			{ agent: "explore", status: "completed" },
			{ agent: "review", status: "running" },
			{ agent: "review", status: "queued" },
		],
	});
	history.push({ id: "n", type: "custom_message", customType: "agent-notification", details: { agentId: "lane-1", event: "background_interrupted", status: "aborted" } });
	const [row] = timelineFromEntries(history);
	assert.deepEqual(row?.kind === "tool" && row.subagentTasks?.map(task => task.status), ["completed", "aborted", "unknown"]);
});

test("unregistered lane ids and inconsistent notification pairs cannot change status", () => {
	const history = entries({ agentId: "lane-1", status: "running", results: [] });
	history.push(
		{ id: "n1", type: "custom_message", customType: "agent-notification", details: { agentId: "lane-1", event: "background_done", status: "failed" } },
		{ id: "n2", type: "custom_message", customType: "agent-notification", details: { agentId: "other", event: "background_done", status: "completed" } },
	);
	assert.deepEqual([...backgroundSubagentStatuses(history)], [["lane-1", "running"]]);
});

test("agent_send results update every addressed lane from their structured details", () => {
	const history = entries({ agentId: "lane-1", status: "running", results: [] });
	history.push({
		id: "send",
		type: "message",
		message: {
			role: "toolResult",
			toolName: "agent_send",
			toolCallId: "send-call",
			content: [{ type: "text", text: "Agent lane-1 stopped" }],
			details: [
				{ agentId: "lane-1", status: "aborted", results: [] },
				{ agentId: "unregistered", status: "completed", results: [] },
			],
		},
	});
	assert.deepEqual([...backgroundSubagentStatuses(history)], [["lane-1", "aborted"]]);
});
