import type { AgentMessage, AgentTool } from "@step-harness/agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../../src/core/compaction/utils.ts";
import { createHarness, type Harness } from "./harness.ts";

const SUMMARY = "## Goal\nTask in progress. Preserve the bulk evidence result.";

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const h of harnesses.splice(0)) h.cleanup();
});

async function setup(
	options: {
		tools?: AgentTool[];
		triggerRatio?: number;
		contextWindow?: number;
		keepRecentTokens?: number;
		contextProjection?: "off" | "clm-v1";
	} = {},
): Promise<Harness> {
	const h = await createHarness({
		models: [{ id: "trigger-model", contextWindow: options.contextWindow ?? 16_000, maxTokens: 2_048 }],
		settings: {
			compaction: {
				contextProjection: options.contextProjection ?? "off",
				keepRecentTokens: options.keepRecentTokens ?? 1,
				...(options.triggerRatio === undefined ? {} : { triggerRatio: options.triggerRatio }),
			},
			retry: { enabled: false },
		},
		tools: options.tools ?? [],
	});
	harnesses.push(h);
	return h;
}

function seed(h: Harness, text: string): void {
	const messages: AgentMessage[] = [
		{ role: "user", content: "Investigate the parser", timestamp: 1 },
		fauxAssistantMessage(text, { timestamp: 2 }),
		{ role: "user", content: "Investigation complete", timestamp: 3 },
		fauxAssistantMessage("Ready for the next step", { timestamp: 4 }),
	];
	for (const message of messages)
		h.sessionManager.appendMessage(message as Parameters<typeof h.sessionManager.appendMessage>[0]);
	h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
}

describe("compaction trigger policy v2", () => {
	it("compacts before the follow-up request once tool results cross the threshold", async () => {
		const bulk: AgentTool = {
			name: "bulk",
			label: "Bulk",
			description: "Collect evidence",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `${"bulk evidence ".repeat(7)}\n`.repeat(100) }],
				details: {},
			}),
		};
		// Threshold 10K: the ~8K seed plus prompt stays below it until the ~2.5K tool result arrives.
		const h = await setup({ tools: [bulk], contextWindow: 20_000, triggerRatio: 0.5, keepRecentTokens: 3_000 });
		seed(h, "prior observation ".repeat(1_800));
		let finalContext: Context | undefined;
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("bulk", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(SUMMARY),
			(context) => {
				finalContext = context;
				return fauxAssistantMessage("final answer");
			},
		]);

		await h.session.prompt("run the bulk check");

		expect(h.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(h.getPendingResponseCount()).toBe(0);
		expect(JSON.stringify(finalContext?.messages)).toContain("Preserve the bulk evidence result");
		expect(h.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("does not compact after a final answer, even above the threshold", async () => {
		const h = await setup();
		seed(h, "short prior answer");
		h.setResponses([fauxAssistantMessage("large final answer ".repeat(4_000))]);

		await h.session.prompt("write a long answer");

		expect(h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(h.getPendingResponseCount()).toBe(0);
	});

	it("honors a configured trigger ratio", async () => {
		const h = await setup({ triggerRatio: 0.5 });
		// About 9.5K estimated tokens: below the 90% default (14.4K) but above 50% (8K).
		seed(h, "prior observation ".repeat(2_100));
		h.setResponses([fauxAssistantMessage(SUMMARY), fauxAssistantMessage("answer")]);

		await h.session.prompt("continue");

		expect(h.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(h.getPendingResponseCount()).toBe(0);
	});

	it("pauses automatic compaction after three consecutive failures", async () => {
		const h = await setup();
		// About 14.9K estimated tokens: above the 14.4K threshold, below the 16K window.
		seed(h, "prior observation ".repeat(3_300));
		const failing = vi
			.spyOn(h.session as unknown as { _runDefaultCompaction: () => Promise<never> }, "_runDefaultCompaction")
			.mockRejectedValue(new Error("summary model unavailable"));

		for (let attempt = 0; attempt < 4; attempt++) {
			h.setResponses([fauxAssistantMessage(`answer ${attempt}`)]);
			await h.session.prompt(`prompt ${attempt}`);
		}

		const ends = h.eventsOfType("compaction_end");
		expect(failing).toHaveBeenCalledTimes(3);
		expect(ends).toHaveLength(3);
		expect(ends.map((event) => event.errorMessage?.includes("paused"))).toEqual([false, false, true]);
	});

	it("resumes automatic compaction after a successful manual compaction", async () => {
		const h = await setup();
		seed(h, "prior observation ".repeat(3_300));
		const internals = h.session as unknown as { _runDefaultCompaction: (...args: unknown[]) => Promise<unknown> };
		const original = internals._runDefaultCompaction.bind(h.session);
		const failing = vi
			.spyOn(internals, "_runDefaultCompaction")
			.mockRejectedValue(new Error("summary model unavailable"));
		for (let attempt = 0; attempt < 3; attempt++) {
			h.setResponses([fauxAssistantMessage(`answer ${attempt}`)]);
			await h.session.prompt(`prompt ${attempt}`);
		}
		expect(h.eventsOfType("compaction_end").at(-1)?.errorMessage).toContain("paused");

		failing.mockImplementation(original);
		// History summary plus split-turn prefix summary.
		h.setResponses([fauxAssistantMessage(SUMMARY), fauxAssistantMessage(SUMMARY)]);
		await h.session.compact();
		seed(h, "prior observation ".repeat(3_300));
		h.setResponses([fauxAssistantMessage(SUMMARY), fauxAssistantMessage("answer after resume")]);
		await h.session.prompt("prompt after manual compaction");

		expect(h.eventsOfType("compaction_start").map((event) => event.reason)).toEqual([
			"threshold",
			"threshold",
			"threshold",
			"manual",
			"threshold",
		]);
		expect(h.getPendingResponseCount()).toBe(0);
	});

	it("does not count a failure raised after the compaction was saved", async () => {
		const h = await setup();
		const appendCompaction = h.sessionManager.appendCompaction.bind(h.sessionManager);
		let failNextRebuild = false;
		vi.spyOn(h.sessionManager, "appendCompaction").mockImplementation((...args) => {
			const id = appendCompaction(...args);
			failNextRebuild = true;
			return id;
		});
		const buildSessionContext = h.sessionManager.buildSessionContext.bind(h.sessionManager);
		vi.spyOn(h.sessionManager, "buildSessionContext").mockImplementation(() => {
			if (failNextRebuild) {
				failNextRebuild = false;
				// Simulate a failure after the compaction entry is persisted.
				throw new Error("post-commit failure");
			}
			return buildSessionContext();
		});
		for (let attempt = 0; attempt < 4; attempt++) {
			seed(h, "prior observation ".repeat(3_300));
			// Two summaries (history + split-turn prefix) per compaction, then the answer.
			h.setResponses([
				fauxAssistantMessage(SUMMARY),
				fauxAssistantMessage(SUMMARY),
				fauxAssistantMessage(`answer ${attempt}`),
			]);
			await h.session.prompt(`prompt ${attempt}`);
		}
		const ends = h.eventsOfType("compaction_end");
		expect(ends.map((event) => event.errorMessage === undefined)).toEqual([false, false, false, false]);
		expect(ends.some((event) => event.errorMessage?.includes("paused"))).toBe(false);
		// Each attempt persisted a compaction, so none of them may count as a failure.
		expect((h.session as unknown as { _thresholdCompactionFailures: number })._thresholdCompactionFailures).toBe(0);
	});

	it("keeps the compacted context when a chained request hook returns only a thinking update", async () => {
		const bulk: AgentTool = {
			name: "bulk",
			label: "Bulk",
			description: "Collect evidence",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `${"bulk evidence ".repeat(7)}\n`.repeat(100) }],
				details: {},
			}),
		};
		const h = await setup({ tools: [bulk], contextWindow: 20_000, triggerRatio: 0.5, keepRecentTokens: 3_000 });
		// A hook installed before the session's wrapper that never returns a context.
		h.session.agent.beforeModelRequest = async () => ({ thinkingLevel: "off" });
		(h.session as unknown as { _installBeforeModelRequestCompaction(): void })._installBeforeModelRequestCompaction();
		seed(h, "prior observation ".repeat(1_800));
		let finalContext: Context | undefined;
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("bulk", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(SUMMARY),
			(context) => {
				finalContext = context;
				return fauxAssistantMessage("final answer");
			},
		]);
		await h.session.prompt("run the bulk check");
		expect(h.eventsOfType("compaction_start")).toHaveLength(1);
		// The pre-compaction loop context has no summary; seeing it proves the compacted context was sent.
		expect(JSON.stringify(finalContext?.messages)).toContain("Preserve the bulk evidence result");
	});

	it("checks the first request again when steering arrives during the pre-run compaction", async () => {
		const h = await setup({ contextWindow: 20_000, triggerRatio: 0.5, keepRecentTokens: 3_000 });
		seed(h, "prior observation ".repeat(2_400));
		const requestChecks: string[] = [];
		const previous = h.session.agent.beforeModelRequest;
		h.session.agent.beforeModelRequest = async (request, signal) => {
			requestChecks.push(request.phase);
			return previous?.(request, signal);
		};
		let steered = false;
		h.setResponses([
			async () => {
				// Summary request for the pre-run compaction: queue large steering while it runs.
				if (!steered) {
					steered = true;
					await h.session.prompt(`STEER ${"large pasted input ".repeat(2_400)}`, { streamingBehavior: "steer" });
				}
				return fauxAssistantMessage(SUMMARY);
			},
			fauxAssistantMessage(SUMMARY),
			fauxAssistantMessage("answer"),
		]);
		await h.session.prompt("start");
		expect(requestChecks[0]).toBe("initial");
		// Pre-run compaction, then a second compaction for the request that now carries the steering.
		expect(h.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold", "threshold"]);
		expect(h.getPendingResponseCount()).toBe(0);
	});

	it("checks the first request again when an agent_start listener queues steering", async () => {
		const h = await setup({ contextWindow: 20_000, triggerRatio: 0.5, keepRecentTokens: 3_000 });
		// ~6K tokens: below the 10K threshold during the pre-run check.
		seed(h, "prior observation ".repeat(1_300));
		let steered = false;
		h.session.subscribe((event) => {
			if (event.type === "agent_start" && !steered) {
				steered = true;
				void h.session.prompt(`STEER ${"large pasted input ".repeat(1_700)}`, { streamingBehavior: "steer" });
			}
		});
		let firstTaskContext: Context | undefined;
		const respond = (context: Context) => {
			if (context.systemPrompt === SUMMARIZATION_SYSTEM_PROMPT) return fauxAssistantMessage(SUMMARY);
			firstTaskContext ??= context;
			return fauxAssistantMessage("answer");
		};
		h.setResponses([respond, respond, respond]);
		await h.session.prompt("start");
		expect(steered).toBe(true);
		expect(h.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold"]);
		expect(JSON.stringify(firstTaskContext?.messages)).toContain("STEER");
		expect(h.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("re-measures the first request when an agent_start listener refreshes the model to a smaller window", async () => {
		const h = await setup({ contextWindow: 40_000, triggerRatio: 0.5, keepRecentTokens: 3_000 });
		// ~15K tokens: below 20K (50% of 40K) during the pre-run check, above 10K (50% of 20K) afterwards.
		seed(h, "prior observation ".repeat(3_300));
		h.session.subscribe((event) => {
			if (event.type === "agent_start") {
				// Same provider/id, new object with a smaller window, as a registry refresh produces.
				h.session.agent.state.model = { ...h.session.agent.state.model, contextWindow: 20_000 };
			}
		});
		let taskContext: Context | undefined;
		const respond = (context: Context) => {
			if (context.systemPrompt === SUMMARIZATION_SYSTEM_PROMPT) return fauxAssistantMessage(SUMMARY);
			taskContext ??= context;
			return fauxAssistantMessage("answer");
		};
		h.setResponses([respond, respond, respond]);
		await h.session.prompt("start");
		expect(h.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold"]);
		expect(JSON.stringify(taskContext?.messages)).toContain("Preserve the bulk evidence result");
		expect(h.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it.each([
		["native", "off"],
		["default CLM", "clm-v1"],
	] as const)(
		"fails open on %s measurement faults and stops measuring after three",
		async (_label, contextProjection) => {
			const h = await setup({ contextProjection });
			seed(h, "prior observation ".repeat(1_000));
			const measure = vi
				.spyOn(h.session as unknown as { _workingContextTokens: () => number }, "_workingContextTokens")
				.mockImplementation(() => {
					throw new Error("estimator fault");
				});
			for (let attempt = 0; attempt < 5; attempt++) {
				h.setResponses([fauxAssistantMessage(`answer ${attempt}`)]);
				await h.session.prompt(`prompt ${attempt}`);
				expect(h.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
			}
			expect(measure).toHaveBeenCalledTimes(3);
			expect(h.eventsOfType("compaction_start")).toHaveLength(0);
			const failures = h.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "step-compaction-failure");
			expect(failures).toHaveLength(3);
		},
	);
});
