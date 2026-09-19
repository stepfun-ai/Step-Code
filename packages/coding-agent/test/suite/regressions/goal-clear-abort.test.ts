import { fauxAssistantMessage } from "@step-harness/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionMode } from "../../../src/core/extensions/index.ts";
import { createStepGoalExtension } from "../../../src/features/step-schedule.ts";
import { createHarness, type Harness, type HarnessOptions } from "../harness.ts";

describe("goal clear cancels the host run", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function setup(mode: ExtensionMode, options: HarnessOptions = {}) {
		const harness = await createHarness({
			...options,
			extensionFactories: [createStepGoalExtension({ enabled: true }), ...(options.extensionFactories ?? [])],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			mode,
			// Match the TUI hook: restore queued input and abort the low-level agent.
			abortHandler:
				mode === "tui"
					? () => {
							harness.session.clearQueue();
							harness.session.agent.abort();
						}
					: undefined,
		});
		const tool = harness.session.extensionRunner
			.getAllRegisteredTools()
			.find(({ definition }) => definition.name === "create_goal");
		if (!tool) throw new Error("create_goal is not registered");
		await tool.definition.execute(
			"create-goal",
			{ objective: "Finish the current task" },
			undefined,
			undefined,
			harness.session.extensionRunner.createContext(),
		);
		return harness;
	}

	function expectClearedAndSettled(harness: Harness) {
		expect(harness.session.isIdle).toBe(true);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "step-goal")
				.at(-1),
		).toMatchObject({ data: { cleared: true } });
	}

	it.each(["tui", "rpc"] as const)("%s: clear cancels retry backoff without another request", async (mode) => {
		const harness = await setup(mode, {
			settings: {
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 200 },
				compaction: { enabled: false },
			},
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("must not retry"),
		]);
		const run = harness.session.prompt("work");
		await vi.waitFor(() => expect(harness.session.isRetrying).toBe(true));
		await harness.session.prompt("/goal clear");
		await run;
		expect(harness.eventsOfType("auto_retry_end")).toContainEqual(
			expect.objectContaining({ success: false, finalError: "Retry cancelled" }),
		);
		expectClearedAndSettled(harness);
	});

	it.each(["tui", "rpc"] as const)("%s: clear at agent_end prevents retry from starting", async (mode) => {
		const harness = await setup(mode, {
			settings: {
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
				compaction: { enabled: false },
			},
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("must not retry"),
		]);
		harness.session.subscribe((event) => {
			if (event.type === "agent_end") void harness.session.prompt("/goal clear");
		});
		await harness.session.prompt("work");
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expectClearedAndSettled(harness);
	});

	it.each([
		["tui", false],
		["rpc", false],
		["tui", true],
		["rpc", true],
	] as const)("%s: clear aborts overflow compaction without recovery (reject=%s)", async (mode, rejectOnAbort) => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let compactionSignal: AbortSignal | undefined;
		const harness = await setup(mode, {
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						compactionSignal = event.signal;
						await gate;
						if (rejectOnAbort && event.signal.aborted)
							throw new DOMException("Compaction cancelled", "AbortError");
						return {
							compaction: {
								summary: "discard this summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			fauxAssistantMessage("must not recover"),
		]);
		const run = harness.session.prompt("x".repeat(5000));
		try {
			await vi.waitFor(() => expect(compactionSignal).toBeDefined());
			await harness.session.prompt("/goal clear");
			expect(compactionSignal?.aborted).toBe(true);
		} finally {
			release();
			await run;
		}
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ aborted: true, willRetry: false });
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expectClearedAndSettled(harness);
	});

	it.each(["tui", "rpc"] as const)("%s: clear at compaction_end prevents overflow continuation", async (mode) => {
		const harness = await setup(mode, {
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			fauxAssistantMessage("must not recover"),
		]);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end") void harness.session.prompt("/goal clear");
		});
		await harness.session.prompt("x".repeat(5000));
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expectClearedAndSettled(harness);
	});
});
