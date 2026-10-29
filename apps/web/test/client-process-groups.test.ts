import assert from "node:assert/strict";
import test from "node:test";
import {
	groupProcessRows,
	type ProcessGroup,
	processGroupSummary,
	reuseUnchangedRows,
} from "../client/src/features/conversation/process-groups.ts";
import { collectTurnFooters } from "../client/src/features/conversation/turn-footers.ts";
import { translate, type TranslateFn } from "../client/src/i18n/index.ts";
import type { ThinkingTimelineItem, TimelineItem, ToolTimelineItem } from "../client/src/state/types.ts";

const zh: TranslateFn = (key, values) => translate("zh-CN", key, values);
const en: TranslateFn = (key, values) => translate("en-US", key, values);
const user: TimelineItem = { kind: "message", itemId: "u", role: "user", content: "Check." };
const prose: TimelineItem = { kind: "message", itemId: "a", role: "assistant", content: "Done." };

function thought(itemId: string, running = false): ThinkingTimelineItem {
	return { kind: "thinking", itemId, entryId: itemId, content: "First paragraph.\n\n**Latest** thought.\nMore.", running };
}

function tool(itemId: string, toolName = "read", state: ToolTimelineItem["state"] = "completed"): ToolTimelineItem {
	return { kind: "tool", itemId, toolName, state, inputSummary: "src/a.ts", outputSummary: "Recorded output." };
}

function onlyGroup(items: readonly TimelineItem[], active = false): ProcessGroup {
	const rows = groupProcessRows(items, active);
	assert.equal(rows.length, 1);
	assert.ok("kind" in rows[0]);
	return rows[0];
}

test("Simple groups consecutive thoughts and tools without modifying source records or order", () => {
	const items = [user, thought("t"), tool("r"), thought("t2"), tool("b", "bash"), prose];
	const before = structuredClone(items);
	const rows = groupProcessRows(items, false);
	assert.equal(rows.length, 3);
	const group = rows[1];
	assert.ok("kind" in group);
	assert.deepEqual(group.rows.map((row) => row.item), items.slice(1, 5));
	assert.deepEqual(group.rows.map((row) => row.index), [1, 2, 3, 4]);
	assert.equal(group.index, 1);
	assert.equal(group.lastIndex, 4);
	assert.equal(group.running, false);
	assert.deepEqual(items, before);
});

test("the live pending tool owns the label and preview, never the whole turn or earlier thought", () => {
	const group = onlyGroup([thought("t"), tool("r"), { ...tool("b", "bash", "pending"), args: { command: "pnpm check" } }], true);
	assert.equal(group.running, true);
	assert.deepEqual(processGroupSummary(group, zh), {
		label: "正在运行命令", detail: "pnpm check", icon: "wrench",
	});
	assert.equal(processGroupSummary(group, en).label, "Running command");
});

test("live thinking uses the latest paragraph while completed timing remains attached to the original record", () => {
	const item = { ...thought("t", true), timing: { startedAt: 1000 } };
	const group = onlyGroup([item], true);
	assert.deepEqual(processGroupSummary(group, zh), { label: "正在思考", detail: "Latest thought.", icon: "brain" });
	assert.equal(group.rows[0].item, item);
	const settled = { ...item, running: false, timing: { startedAt: 1000, endedAt: 4500 } };
	assert.equal(processGroupSummary(onlyGroup([settled]), en).label, "Thinking record");
	assert.deepEqual(onlyGroup([settled]).rows[0].item, settled);
});

test("completed summaries count tool kinds, not thoughts or canonical Tasks", () => {
	const group = onlyGroup([thought("t"), tool("r"), tool("r2"), tool("b", "bash")]);
	assert.equal(processGroupSummary(group, zh).label, "已完成：读取文件 2 项、命令执行 1 项");
	assert.equal(processGroupSummary(group, en).label, "Completed: 2 file reads, 1 commands");
	const varied = onlyGroup([tool("r"), tool("w", "write"), tool("e", "edit"), tool("b", "bash")]);
	assert.equal(processGroupSummary(varied, zh).label, "已完成 4 项工具操作");
});

test("failed ordinary calls fold with their siblings and count toward the completed summary", () => {
	const failed = { ...tool("f", "run_command", "failed"), outputSummary: "exit 128" };
	for (const active of [false, true]) {
		const group = onlyGroup([thought("t"), tool("r", "run_command"), failed, tool("r2", "run_command")], active);
		assert.equal(group.running, false);
		assert.equal(group.rows[2].item, failed);
		assert.equal(processGroupSummary(group, zh).label, "已完成：工具调用 3 项");
	}
});

test("dedicated lifecycle calls stay outside compact groups, failed or not", () => {
	for (const item of [
		...["subagent", "workflow", "enter_plan_mode", "exit_plan_mode", "desktop_send_message", "clarify_user"].flatMap(
			(name) => [tool(name, name), tool(`${name}-failed`, name, "failed")],
		),
		{ ...tool("child", "extension"), children: [{ sessionId: "child", label: "Child" }] },
		{ ...tool("workflow", "extension"), workflowRun: "run" },
	]) {
		const rows = groupProcessRows([tool("r"), item, tool("r2")], true);
		assert.equal(rows.length, 3);
		assert.ok(!("kind" in rows[1]));
		assert.equal(rows[1].item, item);
	}
});

test("prose, image-only messages, user turns, approvals and retries split ranges", () => {
	const approval: TimelineItem = {
		kind: "approval", itemId: "approval",
		approval: { id: "approval", sessionId: "s", toolName: "bash", message: "Approve?", createdAt: 1 },
	};
	for (const boundary of [
		prose, user, approval,
		{ kind: "message" as const, itemId: "image", role: "assistant", content: "", images: ["data:image/png;base64,AA=="] },
		{ kind: "retry" as const, itemId: "retry", errors: ["Timeout"] },
	]) {
		const rows = groupProcessRows([tool("r"), boundary, tool("r2")], false);
		assert.equal(rows.length, 3);
		assert.ok(!("kind" in rows[1]));
		assert.equal(rows[1].item, boundary);
	}
	const rows = groupProcessRows([tool("r"), tool("b", "bash", "pending"), approval], true);
	assert.ok(!("kind" in rows[1]), "a tool waiting for approval must not be hidden under a running process");
});

test("historical unresolved calls and stale thinking cannot inherit a later turn's activity", () => {
	const rows = groupProcessRows([thought("old", true), tool("old-tool", "bash", "pending"), user, thought("new", true)], true);
	assert.ok("kind" in rows[0]);
	assert.equal(rows[0].running, false);
	assert.ok(!("kind" in rows[1]));
	assert.ok("kind" in rows[3]);
	assert.equal(rows[3].running, true);
	const historical = groupProcessRows([tool("unresolved", "read", "pending")], false);
	assert.ok(!("kind" in historical[0]));
});

test("explicit turn attachment boundaries remain outside folds at their original index", () => {
	const items = [user, tool("r"), prose, thought("t"), tool("e", "edit")];
	const footer = collectTurnFooters(items, "completed", false)[0];
	assert.equal(footer.lastIndex, 4);
	const rows = groupProcessRows(items, false, new Set([3, footer.lastIndex]));
	assert.deepEqual(rows.map((row) => row.lastIndex), [0, 1, 2, 3, 4]);
	assert.equal(rows.at(-1)?.lastIndex, footer.lastIndex);
});

test("streaming updates preserve group keys and duplicate tool ids remain distinct", () => {
	const first = onlyGroup([thought("t", true)], true);
	const next = onlyGroup([thought("t"), tool("r", "read", "pending")], true);
	assert.equal(first.key, next.key);
	const repeated = onlyGroup([tool("same"), tool("same")]);
	assert.deepEqual(repeated.rows.map((row) => row.key), ["same", "same#1"]);
});

test("unknown tool names are counted without using text to infer success or category", () => {
	const group = onlyGroup([{ ...tool("custom", "__proto__"), outputSummary: "FAILED" }]);
	assert.equal(processGroupSummary(group, en).label, "Completed: 1 tool calls");
	assert.equal(group.running, false);
});

test("regrouping a streaming turn keeps the objects of unchanged history rows and groups", () => {
	const history: TimelineItem[] = [user, thought("t1"), tool("r1"), prose, { ...user, itemId: "u2" }];
	const before = groupProcessRows([...history, thought("t2", true)], true);
	const after = reuseUnchangedRows(before, groupProcessRows([...history, { ...thought("t2", true), content: "More." }], true));
	// History keeps its identity, so memoized rows skip rendering; the live row is new.
	for (let index = 0; index < after.length - 1; index++) assert.equal(after[index], before[index]);
	assert.notEqual(after.at(-1), before.at(-1));
	// A group whose member changed is replaced.
	const finished = reuseUnchangedRows(before, groupProcessRows([user, thought("t1"), tool("r1", "read", "failed"), prose], true));
	assert.notEqual(finished[1], before[1]);
});
