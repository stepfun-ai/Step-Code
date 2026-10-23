import { readFileSync } from "node:fs";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStepTasksExtension } from "../../src/features/step-tasks.ts";
import { STEP_TASK_STATE_MESSAGE } from "../../src/features/step-tasks-context.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const all: Harness[] = [];
afterEach(() => {
	for (const h of all.splice(0)) h.cleanup();
	vi.restoreAllMocks();
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
	const text = context.messages
		.map(getMessageText)
		.reverse()
		.find((text) => text.startsWith("Current task state (read-only"));
	expect(text).toBeDefined();
	return JSON.parse(text!.split("\n").find((line) => line.startsWith("{"))!);
}
describe("task state in ordinary model requests", () => {
	it.each(["clm-v1", "off"] as const)(
		"preserves the complete request prefix across task reads and updates with %s",
		async (mode) => {
			const h = await createHarness({
				settings: { compaction: { contextProjection: mode } },
				extensionFactories: [{ name: "step-tasks", factory: createStepTasksExtension() }],
			});
			all.push(h);
			seedTasks(h);
			await h.session.bindExtensions({});
			const requests: Context[] = [];
			const capture = (context: Context) =>
				requests.push({
					systemPrompt: context.systemPrompt,
					messages: structuredClone(context.messages),
					tools: context.tools?.map(({ name, description, parameters }) => ({
						name,
						description,
						parameters: structuredClone(parameters),
					})),
				});
			h.setResponses([
				(context) => {
					capture(context);
					return fauxAssistantMessage(fauxToolCall("task_list", {}), { stopReason: "toolUse" });
				},
				(context) => {
					capture(context);
					return fauxAssistantMessage(fauxToolCall("task_update", { taskId: "1", status: "completed" }), {
						stopReason: "toolUse",
					});
				},
				(context) => {
					capture(context);
					return fauxAssistantMessage(fauxToolCall("task_get", { taskId: "2" }), { stopReason: "toolUse" });
				},
				(context) => {
					capture(context);
					return fauxAssistantMessage("The remaining work is not complete.");
				},
			]);
			await h.session.prompt("Continue the existing work and check its task state.");
			expect(requests).toHaveLength(4);
			for (let index = 1; index < requests.length; index++) {
				const previous = requests[index - 1];
				const current = requests[index];
				expect(current.systemPrompt).toBe(previous.systemPrompt);
				expect(current.tools).toEqual(previous.tools);
				expect(current.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
			}
			const snapshots = (context: Context) =>
				context.messages.map(getMessageText).filter((text) => text.startsWith("Current task state (read-only"));
			expect(requests.map((context) => snapshots(context).length)).toEqual([1, 1, 2, 2]);
			expect(taskState(requests[3]).counts).toMatchObject({ total: 4, completed: 1, pending: 3 });
			expect(h.session.messages.some((m) => m.role === "custom" && m.customType === STEP_TASK_STATE_MESSAGE)).toBe(
				false,
			);
		},
	);

	it("keeps task snapshots byte-identical in serialized Responses requests", async () => {
		const h = await createHarness({
			settings: { compaction: { contextProjection: "clm-v1" } },
			extensionFactories: [{ name: "step-tasks", factory: createStepTasksExtension() }],
		});
		all.push(h);
		seedTasks(h);
		await h.session.bindExtensions({});
		const inputs: unknown[][] = [];
		const keys: unknown[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			if (typeof init?.body !== "string") throw new Error("Expected a serialized Responses payload");
			const payload = JSON.parse(init.body);
			inputs.push(payload.input);
			keys.push(payload.prompt_cache_key);
			const index = inputs.length;
			const tool =
				index === 1
					? { name: "task_list", args: {} }
					: { name: "task_update", args: { taskId: "1", status: "completed" } };
			const output =
				index <= 2
					? [
							{
								type: "function_call",
								id: `fc_${index}`,
								call_id: `call_${index}`,
								name: tool.name,
								arguments: JSON.stringify(tool.args),
								status: "completed",
							},
						]
					: [
							{
								type: "message",
								id: `msg_${index}`,
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "Remaining work stays pending.", annotations: [] }],
							},
						];
			const events = [
				...output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
				{
					type: "response.completed",
					response: {
						id: `resp_${index}`,
						status: "completed",
						output,
						usage: {
							input_tokens: 10000,
							input_tokens_details: { cached_tokens: index === 1 ? 0 : 9000 },
							output_tokens: 50,
							total_tokens: 10050,
						},
					},
				},
			];
			return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		h.session.agent.state.model = {
			...h.getModel(),
			api: "openai-responses",
			baseUrl: "https://responses.test/v1",
		};
		await h.session.prompt("Read task state, complete the investigation, and report remaining work.");
		expect(inputs).toHaveLength(3);
		for (let index = 1; index < inputs.length; index++) {
			expect(JSON.stringify(inputs[index].slice(0, inputs[index - 1].length))).toBe(
				JSON.stringify(inputs[index - 1]),
			);
		}
		expect(new Set(keys).size).toBe(1);
		expect(keys[0]).toBe(h.session.agent.sessionId);
		expect(
			h.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === STEP_TASK_STATE_MESSAGE),
		).toBe(false);
	});

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
