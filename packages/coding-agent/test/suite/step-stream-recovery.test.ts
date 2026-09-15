import type { AgentTool } from "@step-harness/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createStepExtension } from "../../src/features/step.ts";
import { registerStepStreamRecovery } from "../../src/features/step-stream-recovery.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

const streamError = "Anthropic stream ended before message_stop";
const recoveryMarker = "[Step runtime recovery]";

describe("Step incomplete stream recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("preserves completed work, guides the retry, and never executes the failed response's tool call", async () => {
		const writes: string[] = [];
		const parameters = Type.Object({ content: Type.String() });
		const writeTool: AgentTool<typeof parameters> = {
			name: "write_file",
			label: "Write",
			description: "Record the requested file content",
			parameters,
			execute: async (_id, params) => {
				writes.push(params.content);
				return { content: [{ type: "text", text: `Saved: ${params.content}` }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [writeTool],
			extensionFactories: [createStepExtension({ permission: { initialPreset: "bypass" } })],
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		const contexts: string[][] = [];
		let retryPayload = "";
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write_file", { content: "completed header" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("write_file", { content: `incomplete payload:${"x".repeat(20_000)}` })], {
				stopReason: "error",
				errorMessage: streamError,
			}),
			(context) => {
				contexts.push(context.messages.map(getMessageText));
				retryPayload = JSON.stringify(context.messages);
				return fauxAssistantMessage([fauxToolCall("write_file", { content: "small next section" })], {
					stopReason: "toolUse",
				});
			},
			(context) => {
				contexts.push(context.messages.map(getMessageText));
				return fauxAssistantMessage("finished");
			},
		]);

		await harness.session.prompt("Write the report");

		expect(writes).toEqual(["completed header", "small next section"]);
		expect(retryPayload).not.toContain("incomplete payload:");
		expect(contexts[0]).toContain("Saved: completed header");
		const notes = contexts[0].filter((text) => text.includes(recoveryMarker));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("one focused tool call");
		expect(notes[0]).toContain("were not executed");
		expect(contexts[1].some((text) => text.includes(recoveryMarker))).toBe(false);
		expect(getUserTexts(harness)).toEqual(["Write the report"]);
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "custom_message")).toBe(false);
		const failedEntries = harness.sessionManager
			.getBranch()
			.filter(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error",
			);
		expect(failedEntries).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([true]);
	});

	it("handles entirely buffered tool input without accumulating notes or extending the retry budget", async () => {
		const harness = await createHarness({
			extensionFactories: [registerStepStreamRecovery],
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		const noteCounts: number[] = [];
		harness.setResponses(
			Array.from({ length: 3 }, () => (context) => {
				noteCounts.push(
					context.messages.filter((message) => getMessageText(message).includes(recoveryMarker)).length,
				);
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: streamError });
			}),
		);

		await harness.session.prompt("Write a large file");

		expect(noteCounts).toEqual([0, 1, 1]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([false]);
		expect(harness.eventsOfType("tool_execution_start")).toEqual([]);

		harness.setResponses([
			(context) => {
				noteCounts.push(
					context.messages.filter((message) => getMessageText(message).includes(recoveryMarker)).length,
				);
				return fauxAssistantMessage("new task");
			},
		]);
		await harness.session.prompt("Different task");
		expect(noteCounts).toEqual([0, 1, 1, 0]);
	});

	it.each([
		{ enabled: false, maxRetries: 3 },
		{ enabled: true, maxRetries: 0 },
	])("respects retry settings %j", async (retry) => {
		const harness = await createHarness({
			extensionFactories: [registerStepStreamRecovery],
			settings: { retry: { ...retry, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: streamError })]);

		await harness.session.prompt("Write a file");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["Write a file"]);
	});

	it.each(["overloaded_error", "fetch failed", "stream ended before message_stop: insufficient_quota"])(
		"does not add file-splitting guidance for %s",
		async (errorMessage) => {
			const contexts: string[][] = [];
			const harness = await createHarness({
				extensionFactories: [
					registerStepStreamRecovery,
					(pi) => {
						pi.on("context", (event) => {
							contexts.push(event.messages.map(getMessageText));
						});
					},
				],
				settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage }),
				fauxAssistantMessage("recovered"),
			]);

			await harness.session.prompt("test");

			expect(contexts.flat().some((text) => text.includes(recoveryMarker))).toBe(false);
		},
	);

	it("cancels the native retry without scheduling a separate recovery request", async () => {
		const harness = await createHarness({
			extensionFactories: [registerStepStreamRecovery],
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: streamError })]);
		const retryStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const prompt = harness.session.prompt("Write a file");
		await retryStarted;
		harness.session.abortRetry();
		await prompt;

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.finalError)).toEqual(["Retry cancelled"]);
		expect(harness.session.isRetrying).toBe(false);
	});
});
