import assert from "node:assert/strict";
import test from "node:test";
import { liveMessageTimeline, timelineFromEntries } from "../client/src/state/session.ts";
import { backgroundSubagentStatuses, cacheSubagentLanes, readSubagentLane, subagentTasks, withSubagentLaneState } from "../client/src/state/subagent-tasks.ts";
import { applyCompletedSubagentEntry, applySubagentLane, renderSnapshot } from "../client/src/state/session.ts";
import { activeAgentRecords } from "../client/src/features/inspector/model.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";
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

test("live background state arrives while the parent is idle and fills the child id", () => {
	setState(createInitialState());
	const history = entries({ agentId: "lane-1", status: "running", results: [{ agent: "explore", task: "Inspect", status: "queued" }] });
	renderSnapshot({ id: "parent", cwd: "/w", status: "idle", entries: history });
	const lane = { laneId: "lane-1", status: "running", details: { agentId: "lane-1", results: [{ agent: "explore", task: "short", status: "running", sessionId: "child-live", activeText: "live-only marker" }] } };
	applySubagentLane("other-parent", lane);
	assert.equal(getState().current?.subagentLanes, undefined);
	applySubagentLane("parent", lane);
	const row = getState().timelineItems.find((item) => item.kind === "tool");
	assert.equal(row?.kind === "tool" && row.subagentTasks?.[0]?.sessionId, "child-live");
	assert.equal(row?.kind === "tool" && row.subagentTasks?.[0]?.activeText, "live-only marker");
	assert.equal(row?.kind === "tool" && row.subagentTasks?.[0]?.status, "running");
	assert.equal(getState().current?.status, "idle");
	// Reconnect uses the same snapshot channel; no model turn is needed.
	renderSnapshot({ id: "parent", cwd: "/w", status: "idle", entries: history, subagentLanes: [lane] });
	assert.ok(JSON.stringify(getState().timelineItems).includes("live-only marker"));
	setState(createInitialState());
});

test("a stopped supplement cannot erase a durable completed answer or its child link", () => {
	const history = entries({ agentId: "lane-1", status: "running", results: [{ agent: "explore", task: "Inspect", status: "queued" }] });
	history.push({ id: "completed", type: "custom", customType: "step-subagent-response", data: { laneId: "lane-1", sessionId: "child-1", taskIndex: 0, output: "first complete report" } });
	const [row] = withSubagentLaneState(timelineFromEntries(history), [{ laneId: "lane-1", status: "aborted", details: { agentId: "lane-1", results: [{ agent: "explore", status: "aborted", errorMessage: "stopped" }] } }], history);
	assert.equal(row?.kind === "tool" && row.subagentTasks?.[0]?.status, "aborted");
	assert.equal(row?.kind === "tool" && row.subagentTasks?.[0]?.sessionId, "child-1");
	assert.deepEqual(row?.kind === "tool" && row.subagentTasks?.[0]?.completedOutputs, [{ id: "completed", output: "first complete report" }]);
});

test("invalid and unrelated lane snapshots cannot change known task state", () => {
	for (const value of [null, [], {}, { laneId: "lane-1", status: "running", details: { agentId: "other", results: [] } }]) assert.equal(readSubagentLane(value), undefined);
	const history = entries({ agentId: "lane-1", status: "running", results: [{ agent: "explore", status: "queued" }] });
	setState(createInitialState());
	renderSnapshot({ id: "parent", cwd: "/w", status: "completed", entries: history, subagentLanes: [{ laneId: "lane-1", status: "running", details: { agentId: "lane-1", results: [{ agent: "explore", status: "running" }] } }] });
	applySubagentLane("parent", { laneId: "other", status: "aborted", details: { agentId: "other", results: [] } });
	const row = getState().timelineItems[0];
	assert.equal(row?.kind === "tool" && row.subagentTasks?.[0]?.status, "running");
	setState(createInitialState());
});

test("journal chronology survives reconnect: an old control cannot resurrect a completed lane", () => {
	const history = entries({ agentId: "lane-1", status: "running", results: [{ agent: "explore", task: "Inspect", status: "running", sessionId: "child-1" }] });
	const reply = (id: string): SessionEntry[] => [
		{ id: `${id}-call`, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "agent_send", arguments: { lane_id: "lane-1", action: "reply", prompt: "supplement" } }] } },
		{ id: `${id}-result`, type: "message", message: { role: "toolResult", toolName: "agent_send", toolCallId: id, content: "queued", details: [{ agentId: "lane-1", status: "running", results: [{ agent: "explore", status: "running", sessionId: "child-1" }] }] } },
	];
	history.push(...reply("old-reply"), { id: "done", type: "custom_message", customType: "agent-notification", details: { agentId: "lane-1", event: "background_done", status: "completed" } });
	assert.equal(activeAgentRecords(timelineFromEntries(history)).length, 0);
	setState(createInitialState());
	renderSnapshot({ id: "parent", cwd: "/w", status: "completed", entries: history, subagentLanes: [] });
	assert.equal(activeAgentRecords(getState().timelineItems).length, 0);
	assert.equal(getState().timelineItems[0]?.kind === "tool" && getState().timelineItems[0].subagentTasks?.[0]?.status, "completed");
	// A real newer reply legitimately restarts the same identity.
	history.push(...reply("new-reply"));
	assert.equal(activeAgentRecords(timelineFromEntries(history)).length, 1);
	history.push({ id: "stopped", type: "custom_message", customType: "agent-notification", details: { agentId: "lane-1", event: "background_interrupted", status: "aborted" } });
	assert.equal(activeAgentRecords(timelineFromEntries(history)).length, 0);
	setState(createInitialState());
});

test("terminal parallel snapshots preserve skipped steps instead of aborting queued placeholders", () => {
	const history = entries({ agentId: "parallel", status: "running", results: [
		{ agent: "explore", status: "completed", sessionId: "child-0" },
		{ agent: "explore", status: "running", sessionId: "child-1" },
		{ agent: "explore", status: "queued", sessionId: "child-2" },
	] });
	const snapshot = { laneId: "parallel", status: "aborted", details: { agentId: "parallel", results: [
		{ agent: "explore", status: "completed", sessionId: "child-0" },
		{ agent: "explore", status: "aborted", sessionId: "child-1" },
		{ agent: "explore", status: "skipped", sessionId: "child-2" },
	] } };
	const [row] = withSubagentLaneState(timelineFromEntries(history), [snapshot]);
	assert.deepEqual(row?.kind === "tool" && row.subagentTasks?.map((task) => task.status), ["completed", "aborted", "skipped"]);
	snapshot.details.results[2].status = "queued";
	const [pending] = withSubagentLaneState(timelineFromEntries(history), [snapshot]);
	assert.equal(pending?.kind === "tool" && pending.subagentTasks?.[2]?.status, "unknown");
});

test("completed SSE facts are immediately visible without waiting for an HTTP snapshot", () => {
	setState(createInitialState());
	const history = entries({ agentId: "lane-1", status: "running", results: [{ agent: "explore", task: "Inspect", status: "running" }] });
	renderSnapshot({ id: "parent", cwd: "/w", status: "completed", entries: history, revision: 10 });
	const fact = { id: "answer", type: "custom", customType: "step-subagent-response", data: { laneId: "lane-1", sessionId: "child-1", taskIndex: 0, output: "first report" } };
	applyCompletedSubagentEntry("other", fact);
	applyCompletedSubagentEntry("parent", fact);
	applyCompletedSubagentEntry("parent", fact);
	renderSnapshot({ id: "parent", cwd: "/w", status: "completed", entries: history, revision: 9 });
	assert.equal(getState().current?.entries?.filter((entry) => entry.id === "answer").length, 1);
	assert.ok(JSON.stringify(getState().timelineItems).includes("first report"));
	setState(createInitialState());
});

test("a restarted host with no live lane does not revive unfinished historical controls", () => {
	const history = entries({ agentId: "lane-1", status: "running", results: [{ agent: "explore", task: "Inspect", status: "running", sessionId: "child-1" }] });
	setState(createInitialState());
	renderSnapshot({ id: "parent", cwd: "/w", status: "completed", entries: history, subagentLanes: [] });
	assert.equal(activeAgentRecords(getState().timelineItems).length, 0);
	assert.equal(getState().timelineItems[0]?.kind === "tool" && getState().timelineItems[0].subagentTasks?.[0]?.sessionId, "child-1");
	setState(createInitialState());
});

for (const count of [200, 1000]) test(`omitted terminal roster (${count} tasks) does not manufacture per-task outcomes`, () => {
	const history = entries({ agentId: "large-lane", status: "running", results: Array.from({ length: count }, (_, index) => ({ agent: "explore", task: `${index}`, sessionId: `child-${index}`, status: index === 0 ? "completed" : index % 2 ? "running" : "queued" })) });
	history.push({ id: "stop", type: "custom_message", customType: "agent-notification", details: { agentId: "large-lane", event: "background_interrupted", status: "aborted" } });
	const snapshot = { laneId: "large-lane", status: "aborted", details: { agentId: "large-lane", omittedResults: count - 1, results: [{ agent: "explore", task: "0", sessionId: "child-0", status: "completed" }] } };
	const [row] = withSubagentLaneState(timelineFromEntries(history), [snapshot], history);
	assert.equal(row?.kind === "tool" && row.subagentTasks?.[0]?.status, "completed");
	assert.ok(row?.kind === "tool" && row.subagentTasks?.slice(1).every((task) => task.status === "unknown"));
	assert.equal(row?.kind === "tool" && row.subagentOmitted, count - 1);
});

test("client cache retains running lanes and only 16 recent terminal lanes", () => {
	let frames: readonly unknown[] = [];
	const frame = (laneId: string, status: string, updatedAt: number) => ({ laneId, status, details: { agentId: laneId, updatedAt, results: [] } });
	frames = cacheSubagentLanes(frames, frame("long", "running", 1));
	for (let index = 0; index < 20; index++) frames = cacheSubagentLanes(frames, frame(`done-${index}`, "completed", 10 + index));
	assert.equal(frames.length, 17);
	frames = cacheSubagentLanes(frames, frame("long", "completed", 100));
	assert.equal(frames.length, 16);
	assert.ok(frames.some((item) => readSubagentLane(item)?.laneId === "long"));
});

test("new live records clear the previous turn's error and model when omitted", () => {
	const history = entries({ agentId: "lane-1", status: "failed", results: [{ agent: "explore", status: "failed", errorMessage: "old failure", model: "old-model" }] });
	const [row] = withSubagentLaneState(timelineFromEntries(history), [{ laneId: "lane-1", status: "running", details: { agentId: "lane-1", results: [{ agent: "explore", status: "running" }] } }]);
	assert.equal(row?.kind === "tool" && row.subagentTasks?.[0]?.error, undefined);
	assert.equal(row?.kind === "tool" && row.subagentTasks?.[0]?.model, undefined);
});
