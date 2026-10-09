import type { AgentTool } from "@step-harness/agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

describe("CLM task completion", () => {
	it("defers routine mirror maintenance in ordinary requests when automatic CLM is enabled", async () => {
		const h = await createHarness({ settings: { compaction: { contextProjection: "clm-v1" } } });
		harnesses.push(h);
		let request: Context | undefined;
		h.setResponses([
			(context) => {
				request = context;
				return fauxAssistantMessage("Checks passed; finished.");
			},
		]);
		await h.session.prompt("Finish the verified change.");
		expect(request!.systemPrompt).toContain("The host handles routine context reductions");
		expect(request!.systemPrompt).toContain("finish task tracking and return the final answer");
		expect(request!.systemPrompt).not.toContain("Summarize obsolete observations at completed subtasks");

		h.settingsManager.applyOverrides({ compaction: { autoClm: { enabled: false } } });
		h.setResponses([
			(context) => {
				request = context;
				return fauxAssistantMessage("Context editing is available.");
			},
		]);
		await h.session.prompt("Inspect the next task.");
		expect(request!.systemPrompt).not.toContain("The host handles routine context reductions");
		expect(request!.systemPrompt).toContain("Summarize obsolete observations at completed subtasks");

		h.settingsManager.applyOverrides({ compaction: { autoClm: { enabled: true }, enabled: false } });
		h.setResponses([
			(context) => {
				request = context;
				return fauxAssistantMessage("Automatic maintenance is disabled.");
			},
		]);
		await h.session.prompt("Finish with host compaction disabled.");
		expect(request!.systemPrompt).not.toContain("The host handles routine context reductions");
		expect(request!.systemPrompt).toContain("Summarize obsolete observations at completed subtasks");
	});

	it.each([true, false])("keeps explicit CLM compaction instructions with host compaction %s", async (enabled) => {
		const h = await createHarness({
			settings: { compaction: { contextProjection: "clm-v1", enabled } },
		});
		harnesses.push(h);
		let request: Context | undefined;
		h.setResponses([
			(context) => {
				request = context;
				return fauxAssistantMessage("No further edit needed.");
			},
		]);
		await h.session.prompt("/clm-compact preserve exact errors");
		expect(request!.systemPrompt).not.toContain("The host handles routine context reductions");
		expect(request!.systemPrompt).toContain("Summarize obsolete observations at completed subtasks");
		expect(JSON.stringify(request!.messages)).toContain("Organize your working context");
		h.setResponses([
			(context) => {
				request = context;
				return fauxAssistantMessage("Returned to the task.");
			},
		]);
		await h.session.prompt("Return to the ordinary task.");
		if (enabled) expect(request!.systemPrompt).toContain("The host handles routine context reductions");
		else expect(request!.systemPrompt).not.toContain("The host handles routine context reductions");
	});

	it.each([false, true])("isolates maintenance and native fallback instructions (%s)", async (fallback) => {
		const h = await createHarness({
			models: [{ id: "finish-boundary", contextWindow: 64000, maxTokens: 8192 }],
			settings: {
				compaction: {
					contextProjection: "clm-v1",
					reserveTokens: 8192,
					keepRecentTokens: 1000,
				},
			},
		});
		harnesses.push(h);
		const history = [
			{ role: "user" as const, content: "Fix the public API and retain exact failures.", timestamp: 1 },
			fauxAssistantMessage("old diagnostic detail ".repeat(10500), { timestamp: 2 }),
			fauxAssistantMessage("Implementation and review remain.", { timestamp: 3 }),
		];
		for (const message of history) h.sessionManager.appendMessage(message);
		h.session.agent.state.messages = history;
		const responses = [
			(context: Context) => {
				expect(context.tools?.map((tool) => tool.name)).toEqual(["apply_context_edit"]);
				expect(context.systemPrompt).not.toContain("finish task tracking and return the final answer");
				if (fallback) return fauxAssistantMessage("No safe edit needed.");
				const index = getMessageText(context.messages.at(-1));
				const id = /- id=([a-zA-Z0-9-]+) role=assistant/.exec(index)![1];
				return fauxAssistantMessage(
					fauxToolCall("apply_context_edit", {
						replacements: [{ id, text: "Retained exact failure; implement and review." }],
					}),
					{ stopReason: "toolUse" },
				);
			},
		];
		if (fallback) {
			responses.push((context: Context) => {
				expect(context.tools ?? []).toHaveLength(0);
				expect(context.systemPrompt).not.toContain("finish task tracking and return the final answer");
				return fauxAssistantMessage("Preserve requirements. Implementation and review remain.");
			});
		}
		responses.push((context: Context) => {
			expect(context.systemPrompt).toContain("finish task tracking and return the final answer");
			return fauxAssistantMessage("Implementation, checks and review completed.");
		});
		h.setResponses(responses);
		await h.session.prompt("Complete the requested change.");
		expect(h.eventsOfType("auto_clm_end").at(-1)?.result.accepted).toBe(!fallback);
		expect(h.eventsOfType("compaction_start")).toHaveLength(fallback ? 1 : 0);
		expect(h.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it.each([
		{ maxRetries: 1, finalStop: "error", requests: 3 },
		{ maxRetries: 3, finalStop: "stop", requests: 4 },
	] as const)(
		"preserves completed tools with $maxRetries retries after two final-answer 503 errors",
		async ({ maxRetries, finalStop, requests }) => {
			let finalReviewUpdates = 0;
			const review: AgentTool = {
				name: "complete_review",
				label: "Review",
				description: "Record the completed review.",
				parameters: Type.Object({}),
				execute: async () => {
					finalReviewUpdates++;
					return {
						content: [{ type: "text", text: "Review completed; all regression checks passed." }],
						details: {},
					};
				},
			};
			const h = await createHarness({
				settings: {
					compaction: { contextProjection: "clm-v1" },
					retry: { maxRetries, baseDelayMs: 1 },
				},
				tools: [review],
			});
			harnesses.push(h);
			const error = () =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 status code (no body)" });
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("complete_review", {}), { stopReason: "toolUse" }),
				error(),
				error(),
				(context) => {
					expect(context.messages.filter((m) => m.role === "toolResult")).toHaveLength(1);
					expect(JSON.stringify(context.messages)).toContain("Review completed; all regression checks passed.");
					return fauxAssistantMessage("Finished the change, checks and review.");
				},
			]);
			await h.session.prompt("Finish the verified repair and review.");
			expect(finalReviewUpdates).toBe(1);
			expect(h.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: finalStop });
			expect(h.session.isIdle).toBe(true);
			expect(h.session.retryAttempt).toBe(0);
			expect(h.getPendingResponseCount()).toBe(4 - requests);
			const errors = h.sessionManager
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "error",
				);
			expect(errors).toHaveLength(2);
			expect(h.session.messages.filter((m) => m.role === "toolResult").map(getMessageText)).toEqual([
				"Review completed; all regression checks passed.",
			]);
		},
	);
});
