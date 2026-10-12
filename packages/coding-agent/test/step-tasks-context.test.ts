import type { AgentMessage } from "@step-harness/agent-core";
import { describe, expect, it } from "vitest";
import {
	STEP_TASK_STATE_MESSAGE,
	TASK_STATE_MAX_BYTES,
	withTaskStateContext,
} from "../src/features/step-tasks-context.ts";

function record(messages: AgentMessage[]) {
	const message = messages.at(-1);
	if (message?.role !== "custom" || typeof message.content !== "string") throw new Error("missing task context");
	return { message, data: JSON.parse(message.content.split("\n").find((line) => line.startsWith("{"))!) };
}

describe("bounded task context", () => {
	it("bounds large Unicode task lists while preserving usable IDs and recording omissions", () => {
		const tasks = Array.from({ length: 100 }, (_, i) => ({
			id: String(i + 1),
			subject: "检查😀".repeat(500),
			status: i === 99 ? "in_progress" : "pending",
			owner: "owner".repeat(100),
			blockedBy: Array.from({ length: 30 }, (_, n) => String(n + 101)),
		}));
		const before = structuredClone(tasks);
		const messages = withTaskStateContext(
			[],
			{ plan: { id: "current-plan", title: "计划😀".repeat(300) }, tasks },
			1,
		);
		const { message, data } = record(messages);
		expect(new TextEncoder().encode(message.content as string).byteLength).toBeLessThanOrEqual(TASK_STATE_MAX_BYTES);
		expect(data.counts).toMatchObject({ total: 100, pending: 99, inProgress: 1 });
		expect(data.openTasks[0]).toMatchObject({ id: "100", status: "in_progress" });
		expect(data.omittedOpenTasks).toBe(100 - data.openTasks.length);
		expect(data.omittedOpenTasks).toBeGreaterThan(0);
		for (const task of data.openTasks) {
			expect(tasks.some((original) => original.id === task.id)).toBe(true);
			expect(task.blockedBy).toHaveLength(8);
			expect(task.omittedBlockers).toBe(22);
		}
		expect(tasks).toEqual(before);
	});
	it("omits oversized IDs instead of presenting truncated references", () => {
		const id = "long-id-".repeat(200);
		const { data } = record(
			withTaskStateContext(
				[],
				{
					plan: { id, title: "Plan" },
					tasks: [{ id, subject: "Keep full IDs", status: "pending", blockedBy: [] }],
				},
				1,
			),
		);
		expect(data.plan).toEqual({ idOmitted: true, title: "Plan" });
		expect(data.openTasks).toEqual([]);
		expect(data.omittedOpenTasks).toBe(1);
	});
	it("keeps completed counts current without inventing a pending step", () => {
		const { data } = record(
			withTaskStateContext([], { tasks: [{ id: "1", subject: "Done", status: "completed", blockedBy: [] }] }, 1),
		);
		expect(data.counts).toMatchObject({ total: 1, completed: 1, pending: 0, inProgress: 0 });
		expect(data.openTasks).toEqual([]);
	});
	it("removes only its own stale metadata, leaving user text and other custom messages intact", () => {
		const user: AgentMessage = { role: "user", content: "step-tasks-state is part of my task", timestamp: 1 };
		const other: AgentMessage = {
			role: "custom",
			customType: "other",
			content: "preserve",
			timestamp: 2,
			display: false,
		};
		const old: AgentMessage = {
			role: "custom",
			customType: STEP_TASK_STATE_MESSAGE,
			content: "outdated",
			timestamp: 3,
			display: false,
		};
		expect(withTaskStateContext([user, other, old], undefined, 4)).toEqual([user, other]);
		expect(withTaskStateContext([user, other, old], { tasks: [] }, 4)).toEqual([user, other]);
	});
});
