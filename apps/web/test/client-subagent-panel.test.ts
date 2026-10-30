import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { latestAgentRecord, summaryAgentRecords } from "../client/src/features/inspector/model.ts";
import { openAgentRecord } from "../client/src/features/inspector/open-agent.ts";
import { activeRightPanel } from "../client/src/state/right-panel.ts";
import { createInitialState, getState, setState } from "../client/src/state/store.ts";
import type { SubagentStatus, TimelineItem, ToolTimelineItem } from "../client/src/state/types.ts";

afterEach(() => setState(createInitialState()));

function tool(itemId: string, extra: Partial<ToolTimelineItem>): ToolTimelineItem {
	return {
		itemId,
		kind: "tool",
		state: "completed",
		toolName: "subagent",
		inputSummary: "",
		outputSummary: "",
		...extra,
	} as ToolTimelineItem;
}

function task(itemId: string, status: SubagentStatus, count = 1): ToolTimelineItem {
	return tool(itemId, {
		subagentTasks: Array.from({ length: count }, (_, index) => ({
			agent: "explore",
			task: `${itemId}-${index}`,
			status,
			model: "fixture",
			sessionId: `${itemId}-child-${index}`,
		})),
	});
}

test("the panel's default is the newest agent that is still working", () => {
	// A running agent is what someone opening the panel cold is watching, even
	// when a later agent already finished.
	const items: TimelineItem[] = [task("a", "completed"), task("b", "running"), task("c", "completed")];
	assert.equal(latestAgentRecord(items)?.key, "child:b-child-0");
});

test("with nothing running the default is the newest record", () => {
	const items: TimelineItem[] = [task("a", "completed"), task("b", "failed")];
	assert.equal(latestAgentRecord(items)?.key, "child:b-child-0");
});

test("a conversation with no agent has no default", () => {
	assert.equal(latestAgentRecord([]), undefined);
	assert.equal(
		latestAgentRecord([tool("plain", { toolName: "read_file" })]),
		undefined,
		"an ordinary tool is not an agent",
	);
});

test("every record target opens the subagent panel on its own view", () => {
	const items: TimelineItem[] = [
		tool("dispatch", { children: [{ sessionId: "child-1", label: "explore" }] }),
		tool("wf", { toolName: "workflow", workflowRun: "wf_1" }),
		task("tasked", "completed", 3),
	];
	setState({ ...createInitialState(), current: { id: "parent", cwd: "/w", status: "idle" } });

	// A child link carries the label it shows, so the header is never blank.
	const child = summaryAgentRecords(items).find((record) => record.target.kind === "child");
	assert.ok(child);
	openAgentRecord(child);
	assert.equal(activeRightPanel(getState()), "subagent");
	assert.equal(getState().ui.childView?.childId, "child-1");
	assert.equal(getState().ui.childView?.label, "explore");

	const workflow = summaryAgentRecords(items).find((record) => record.target.kind === "workflow");
	assert.ok(workflow);
	openAgentRecord(workflow);
	assert.equal(getState().ui.childView?.workflowRun, "wf_1");

	// The third row of one call, to prove the index travels, not just the item.
	const tasked = summaryAgentRecords(items).find(
		(record) => record.target.kind === "task" && record.target.taskIndex === 2,
	);
	assert.ok(tasked);
	openAgentRecord(tasked);
	assert.equal(getState().ui.childView?.toolItemId, "tasked");
	assert.equal(getState().ui.childView?.taskIndex, 2);
	assert.equal(getState().ui.childView?.parentId, "parent");
});

test("a dispatch with no result still opens, so the panel can explain it", () => {
	// The record exists from the call alone; the panel then shows why there is no
	// transcript instead of pretending the conversation has no agent.
	const items: TimelineItem[] = [tool("pending", { outputSummary: "" })];
	const record = latestAgentRecord(items);
	assert.ok(record);
	setState({ ...createInitialState(), current: { id: "parent", cwd: "/w", status: "running" } });
	openAgentRecord(record);
	assert.equal(activeRightPanel(getState()), "subagent");
	assert.equal(getState().ui.childView?.toolItemId, "pending");
});
