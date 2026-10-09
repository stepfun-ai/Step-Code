import { readFileSync } from "node:fs";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterEach, describe, expect, it } from "vitest";
import { createStepTasksExtension } from "../../src/features/step-tasks.ts";
import { STEP_TASK_STATE_MESSAGE } from "../../src/features/step-tasks-context.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const all: Harness[] = [];
afterEach(() => {
	for (const h of all.splice(0)) h.cleanup();
});
function seedTasks(h: Harness) {
	h.sessionManager.appendCustomEntry("step-tasks", {
		tasks: ["Investigate", "Implement", "Test", "Review"].map((subject, index) => ({
			id: String(index + 1),
			subject,
			description: subject,
			status: index === 0 ? "in_progress" : "pending",
			blocks: [],
			blockedBy: [],
			createdAt: 1,
			updatedAt: 1,
		})),
		nextId: 5,
		activePlan: { id: "plan-1", title: "Existing work" },
		archivedPlans: [],
	});
}
function taskState(context: Context) {
	const text = context.messages.map(getMessageText).find((text) => text.startsWith("Current task state (read-only"));
	expect(text).toBeDefined();
	return JSON.parse(text!.split("\n").find((line) => line.startsWith("{"))!);
}
describe("task state in ordinary model requests", () => {
	it("refreshes state after task tools without persisting snapshots or automatically completing open tasks", async () => {
		const h = await createHarness({
			extensionFactories: [{ name: "step-tasks", factory: createStepTasksExtension() }],
		});
		all.push(h);
		seedTasks(h);
		await h.session.bindExtensions({});
		h.setResponses([
			(context) => {
				expect(taskState(context).openTasks.map((t: { id: string }) => t.id)).toEqual(["1", "2", "3", "4"]);
				return fauxAssistantMessage(fauxToolCall("task_update", { taskId: "1", status: "completed" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				expect(taskState(context).counts).toMatchObject({ total: 4, completed: 1, pending: 3 });
				return fauxAssistantMessage("Implementation still needs work.");
			},
		]);
		await h.session.prompt("Continue the existing request.");
		expect(h.getPendingResponseCount()).toBe(0);
		expect(h.session.isIdle).toBe(true);
		expect(h.session.messages.some((m) => m.role === "custom" && m.customType === STEP_TASK_STATE_MESSAGE)).toBe(
			false,
		);
		const state = h.sessionManager
			.getEntries()
			.filter((e) => e.type === "custom" && e.customType === "step-tasks")
			.at(-1);
		expect(state).toMatchObject({
			data: {
				tasks: [
					expect.objectContaining({ id: "1", status: "completed" }),
					expect.objectContaining({ id: "2", status: "pending" }),
					expect.objectContaining({ id: "3", status: "pending" }),
					expect.objectContaining({ id: "4", status: "pending" }),
				],
			},
		});
	});
	it.each(["clm-v1", "off"] as const)(
		"restores authoritative task state after %s compaction without adding it to maintenance or mirrors",
		async (mode) => {
			const h = await createHarness({
				models: [{ id: "task-state", contextWindow: 64000, maxTokens: 8192 }],
				settings: { compaction: { contextProjection: mode, reserveTokens: 8192, keepRecentTokens: 1000 } },
				extensionFactories: [{ name: "step-tasks", factory: createStepTasksExtension() }],
			});
			all.push(h);
			const history = [
				{ role: "user" as const, content: "Preserve exact requirements", timestamp: 1 },
				fauxAssistantMessage("old diagnostics ".repeat(14000), { timestamp: 2 }),
				fauxAssistantMessage("Implementation and review remain.", { timestamp: 3 }),
			];
			for (const m of history) h.sessionManager.appendMessage(m);
			h.session.agent.state.messages = history;
			seedTasks(h);
			await h.session.bindExtensions({});
			h.setResponses([
				(context) => {
					expect(
						context.messages.map(getMessageText).some((text) => text.startsWith("Current task state (read-only")),
					).toBe(false);
					if (mode === "off") return fauxAssistantMessage("Preserve exact requirements; implement and review.");
					const id = /- id=([^ ]+) role=assistant/.exec(getMessageText(context.messages.at(-1)))![1];
					return fauxAssistantMessage(
						fauxToolCall("apply_context_edit", {
							replacements: [
								{
									id,
									text: "Prior diagnostics complete. Preserve exact requirements; implementation and review remain.",
								},
							],
						}),
						{ stopReason: "toolUse" },
					);
				},
				(context) => {
					expect(taskState(context).openTasks.map((t: { id: string }) => t.id)).toEqual(["1", "2", "3", "4"]);
					if (mode === "clm-v1")
						expect(readFileSync(h.session.getLiveContextStatus()!.path, "utf8")).not.toContain(
							"Current task state (read-only",
						);
					return fauxAssistantMessage("State is visible; task tools must record actual completion.");
				},
			]);
			await h.session.prompt("Continue this work.");
			expect(h.getPendingResponseCount()).toBe(0);
			expect(
				h.sessionManager
					.getEntries()
					.some(
						(e) =>
							e.type === "message" &&
							e.message.role === "custom" &&
							e.message.customType === STEP_TASK_STATE_MESSAGE,
					),
			).toBe(false);
		},
	);
});
