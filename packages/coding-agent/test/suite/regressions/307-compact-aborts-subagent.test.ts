import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@step-harness/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { afterEach, describe, expect, it } from "vitest";
import {
	createStepSubagentExtension,
	type StepSubagentRunInput,
	type StepSubagentRunResult,
} from "../../../src/features/step-subagent.ts";
import { createHarness, type Harness } from "../harness.ts";

// Regression for https://github.com/stepfun-ai/Step-Code/issues/307

function subagentResult(text: string): StepSubagentRunResult {
	return {
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text }],
				api: "anthropic-messages",
				provider: "step",
				model: "step-3.7-flash",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		],
		stderr: "",
		exitCode: 0,
		usage: { input: 1, output: 1, cost: 0, contextTokens: 2, turns: 1 },
		startedAt: Date.now(),
		updatedAt: Date.now(),
	} as unknown as StepSubagentRunResult;
}

function laneEvents(messages: AgentMessage[]): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "custom" || message.customType !== "agent-notification") return [];
		const event = (message.details as { event?: string } | undefined)?.event;
		return event ? [event] : [];
	});
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("issue #307: manual compaction must not abort a running subagent", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		for (const dir of tempDirs.splice(0)) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a foreground subagent running when /compact rewrites the parent context", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "step-307-"));
		tempDirs.push(tempDir);
		let markSubagentStarted: () => void = () => {};
		const subagentStarted = new Promise<void>((resolve) => {
			markSubagentStarted = resolve;
		});
		let subagentAborted = false;
		let releaseSubagent: (result: StepSubagentRunResult) => void = () => {};
		const subagentSettled = new Promise<StepSubagentRunResult>((resolve) => {
			releaseSubagent = resolve;
		});

		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 1000 }],
			settings: {
				compaction: { contextProjection: "off", enabled: false, reserveTokens: 200, keepRecentTokens: 2 },
			},
			initialActiveToolNames: ["subagent"],
			extensionFactories: [
				(pi) => {
					createStepSubagentExtension({
						includeBuiltinAgents: true,
						agentDir: join(tempDir, "agent"),
						runner: (input: StepSubagentRunInput) => {
							input.signal?.addEventListener(
								"abort",
								() => {
									subagentAborted = true;
									releaseSubagent(subagentResult("Subagent was aborted"));
								},
								{ once: true },
							);
							markSubagentStarted();
							return subagentSettled;
						},
					})(pi);
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: `${event.reason} summary`,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", { agent: "general", task: "long review" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("after subagent"),
		]);

		const promptPromise = harness.session.prompt("Run a long review subagent.");
		await subagentStarted;

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (!subagentAborted) releaseSubagent(subagentResult("review done"));
		await Promise.all([promptPromise, compactPromise]);

		expect(subagentAborted).toBe(false);
	});

	it("hands a foreground subagent to a background lane instead of waiting for it", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "step-307-detach-"));
		tempDirs.push(tempDir);
		let markSubagentStarted: () => void = () => {};
		const subagentStarted = new Promise<void>((resolve) => {
			markSubagentStarted = resolve;
		});
		let subagentAborted = false;
		let subagentFinished = false;
		let releaseSubagent: (result: StepSubagentRunResult) => void = () => {};
		const subagentSettled = new Promise<StepSubagentRunResult>((resolve) => {
			releaseSubagent = (result) => {
				subagentFinished = true;
				resolve(result);
			};
		});

		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 1000 }],
			settings: {
				compaction: { contextProjection: "off", enabled: false, reserveTokens: 200, keepRecentTokens: 2 },
			},
			initialActiveToolNames: ["subagent"],
			extensionFactories: [
				(pi) => {
					createStepSubagentExtension({
						includeBuiltinAgents: true,
						agentDir: join(tempDir, "agent"),
						runner: (input: StepSubagentRunInput) => {
							input.signal?.addEventListener(
								"abort",
								() => {
									subagentAborted = true;
									releaseSubagent(subagentResult("Subagent was aborted"));
								},
								{ once: true },
							);
							markSubagentStarted();
							return subagentSettled;
						},
					})(pi);
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: `${event.reason} summary`,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		// The harness runs extensions in print mode by default; lanes are a TUI/RPC
		// capability, so bind the mode the detach path is meant for.
		await harness.session.bindExtensions({ mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", { agent: "general", task: "long review" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("after subagent"),
			fauxAssistantMessage("after notification"),
		]);

		const promptPromise = harness.session.prompt("Run a long review subagent.");
		await subagentStarted;

		const compactPromise = harness.session.compact();
		// Compaction must settle while the subagent is still running: the foreground
		// call was handed to a lane, so there is nothing left to wait for.
		await Promise.all([promptPromise, compactPromise]);
		expect(subagentAborted).toBe(false);
		expect(subagentFinished).toBe(false);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);

		releaseSubagent(subagentResult("review done"));
		await waitFor(() => laneEvents(harness.session.messages).includes("background_done"));
		expect(laneEvents(harness.session.messages)).toContain("background_done");
	});
});
