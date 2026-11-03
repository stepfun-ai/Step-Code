import type { AgentTool } from "@step-harness/agent-core";
import {
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	INCOMPLETE_TURN_MESSAGES,
} from "@step-harness/providers";
import type { AssistantMessage } from "@step-harness/providers/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunFailure } from "../../src/core/agent-session.ts";
import { INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE } from "../../src/core/incomplete-turn-recovery.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function assistants(harness: Harness): AssistantMessage[] {
	return harness.session.messages.filter((message): message is AssistantMessage => message.role === "assistant");
}

function recoveryEntries(harness: Harness) {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE);
}

function settledFailures(harness: Harness): AgentRunFailure[] {
	return harness.eventsOfType("agent_settled").flatMap((event) => (event.failure ? [event.failure] : []));
}

describe("incomplete assistant turn recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("preserves a thinking-only turn and retries with a recovery message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const requests: string[] = [];
		harness.setResponses([
			fauxAssistantMessage([
				fauxThinking("I should run the command. <tool_call><function=run_command>echo hi</function></tool_call>"),
			]),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("Recovered with a visible answer.");
			},
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(2);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("The last turn produced no visible answer");
		expect(requests[0]).toContain("I should run the command.");

		const messages = assistants(harness);
		expect(messages).toHaveLength(2);
		expect(messages[0].content).toEqual([
			fauxThinking("I should run the command. <tool_call><function=run_command>echo hi</function></tool_call>"),
		]);
		// The empty turn keeps the provider's stop reason; the fact lives on `incomplete`.
		expect(messages[0].stopReason).toBe("stop");
		expect(messages[0].incomplete).toBe("no_visible_output");
		expect(messages[1].incomplete).toBeUndefined();

		const entries = recoveryEntries(harness);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ display: false });
		expect(getMessageText(entries[0])).toContain("The last turn produced no visible answer");
		expect(harness.eventsOfType("tool_execution_start")).toEqual([]);
		expect(settledFailures(harness)).toEqual([]);
	});

	it("fails the run when the model repeats itself, without rewriting the stop reason", async () => {
		const harness = await createHarness({ sessionPersistence: true });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("first attempt")),
			fauxAssistantMessage(fauxThinking("second attempt")),
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(2);
		const messages = assistants(harness);
		expect(messages).toHaveLength(2);
		for (const message of messages) {
			expect(message.stopReason).toBe("stop");
			expect(message.errorMessage).toBeUndefined();
			expect(message.incomplete).toBe("no_visible_output");
		}
		expect(messages[1].diagnostics).toEqual([
			expect.objectContaining({
				type: "incomplete_turn",
				details: {
					reason: "no_visible_output",
					consecutiveTurns: 2,
					hadThinking: true,
					hadVisibleText: false,
				},
			}),
		]);
		expect(settledFailures(harness)).toEqual([
			{ kind: "incomplete_turn", reason: "no_visible_output", message: INCOMPLETE_TURN_MESSAGES.no_visible_output },
		]);

		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const reloaded = SessionManager.open(sessionFile!).getBranch();
		expect(
			reloaded.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
			),
		).toMatchObject([
			{ stopReason: "stop", incomplete: "no_visible_output" },
			{
				stopReason: "stop",
				incomplete: "no_visible_output",
				diagnostics: [expect.objectContaining({ type: "incomplete_turn" })],
			},
		]);
		expect(
			reloaded.filter(
				(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
			),
		).toHaveLength(1);
	});

	it("does not enter the generic retry path for an incomplete turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("first attempt")),
			fauxAssistantMessage(fauxThinking("second attempt")),
			fauxAssistantMessage("generic retry must not run"),
		]);
		const willRetry: boolean[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "agent_end") willRetry.push(event.willRetry);
		});

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(2);
		expect(willRetry).toEqual([false, false]);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});

	it("lets queued user input run instead of injecting a stale recovery prompt, and treats it as a new attempt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				await harness.session.prompt("Use the new direction.", { streamingBehavior: "steer" });
				return fauxAssistantMessage(fauxThinking("first attempt"));
			},
			fauxAssistantMessage(fauxThinking("still nothing after the steer")),
			fauxAssistantMessage("Visible answer to the recovery."),
		]);

		await harness.session.prompt("Inspect the workspace");

		// 1 initial, 1 steered turn, 1 recovery — the same run keeps its recovery
		// budget because user input is an attempt, not progress.
		expect(harness.faux.state.callCount).toBe(3);
		expect(recoveryEntries(harness)).toHaveLength(1);
		const messages = assistants(harness);
		expect(messages).toHaveLength(3);
		expect(messages[2].content).toEqual([fauxText("Visible answer to the recovery.")]);
		expect(settledFailures(harness)).toEqual([]);
	});

	it("gives the recovery budget back after an actionable tool turn", async () => {
		const noop: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Noop",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "noop done" }], details: {} }),
		};
		const harness = await createHarness({ tools: [noop] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("first attempt")),
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxThinking("incomplete after the tool result")),
			fauxAssistantMessage("Recovered after the tool result."),
		]);

		await harness.session.prompt("Inspect the workspace");

		// A completed tool turn is progress, not another consecutive empty turn, so
		// the model gets one more recovery instead of ending the run.
		expect(harness.faux.state.callCount).toBe(4);
		expect(recoveryEntries(harness)).toHaveLength(2);
		expect(settledFailures(harness)).toEqual([]);
		expect(assistants(harness).at(-1)?.content).toEqual([fauxText("Recovered after the tool result.")]);
	});

	it("recovers again after a long run of completed turns", async () => {
		const noop: AgentTool = {
			name: "noop",
			label: "Noop",
			description: "Noop",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "noop done" }], details: {} }),
		};
		const harness = await createHarness({ tools: [noop] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("empty early in the run")),
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxThinking("empty much later in the same run")),
			fauxAssistantMessage("Recovered late in the run."),
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(6);
		expect(recoveryEntries(harness)).toHaveLength(2);
		expect(settledFailures(harness)).toEqual([]);
		expect(harness.session.getLastAssistantText()).toBe("Recovered late in the run.");
	});

	it("finalizes the classification after extension content replacement", async () => {
		const observedByExtension: string[] = [];
		const observedBySession: Array<[string, string | undefined]> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role === "assistant") observedByExtension.push(event.message.stopReason);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				observedBySession.push([event.message.stopReason, (event.message as AssistantMessage).incomplete]);
			}
		});
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("first attempt")),
			fauxAssistantMessage(fauxThinking("second attempt")),
		]);

		await harness.session.prompt("Inspect the workspace");

		// Extensions see the provider's own stop reason for both turns; the session
		// reports the same stop reason plus the structural classification.
		expect(observedByExtension).toEqual(["stop", "stop"]);
		expect(observedBySession).toEqual([
			["stop", "no_visible_output"],
			["stop", "no_visible_output"],
		]);
	});

	it("does not recover when an extension adds visible text at message_end", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "assistant") return undefined;
						return { message: { ...event.message, content: [fauxText("Visible text added by an extension.")] } };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxThinking("the model produced no visible text"))]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(1);
		expect(recoveryEntries(harness)).toHaveLength(0);
		expect(assistants(harness).some((message) => message.incomplete !== undefined)).toBe(false);
	});

	it("recovers when an extension removes all visible text at message_end", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "assistant") return undefined;
						return { message: { ...event.message, content: [] } };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("visible before the extension replaced it"),
			fauxAssistantMessage("Recovered after the extension replacement."),
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(2);
		expect(recoveryEntries(harness)).toHaveLength(1);
	});

	it("compacts a silent overflow before spending the recovery continuation", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			settings: { compaction: { contextProjection: "off", enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "silent overflow compacted",
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
			fauxAssistantMessage(fauxThinking("incomplete after silent overflow")),
			fauxAssistantMessage("Recovered after compaction."),
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(2);
		const compactionIndex = harness.events.findIndex(
			(event) => event.type === "compaction_start" && event.reason === "overflow",
		);
		const recoveryIndex = harness.events.findIndex(
			(event) =>
				event.type === "message_start" &&
				event.message.role === "custom" &&
				event.message.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
		);
		expect(compactionIndex).toBeGreaterThanOrEqual(0);
		expect(recoveryIndex).toBeGreaterThan(compactionIndex);
		expect(harness.session.getLastAssistantText()).toBe("Recovered after compaction.");
		expect(settledFailures(harness)).toEqual([]);
	});

	it("reports an unrecoverable silent overflow on the settled run, not by rewriting the message", async () => {
		const harness = await createHarness({
			sessionPersistence: true,
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			settings: { compaction: { contextProjection: "off", enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("incomplete after silent overflow")),
			fauxAssistantMessage("must not be used"),
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(1);
		const [message] = assistants(harness);
		expect(message.stopReason).toBe("stop");
		expect(message.errorMessage).toBeUndefined();
		// Recorded before the message was persisted, so a reload still has it.
		expect(message.diagnostics).toEqual([
			expect.objectContaining({
				type: "incomplete_turn",
				details: expect.objectContaining({ overflowKind: "context", consecutiveTurns: 1 }),
			}),
		]);
		const failures = settledFailures(harness);
		expect(failures).toHaveLength(1);
		expect(failures[0].message).toContain(
			"Cannot recover an incomplete assistant turn because automatic compaction did not complete",
		);
		// Nothing was spent: no recovery prompt and no second request.
		expect(recoveryEntries(harness)).toHaveLength(0);

		const sessionFile = harness.sessionManager.getSessionFile();
		const reloaded = SessionManager.open(sessionFile!).getBranch();
		expect(
			reloaded
				.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []))
				.map((entry) => entry.stopReason),
		).toEqual(["stop"]);
	});

	it("fails immediately when a silent overflow cannot be compacted because compaction is disabled", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			settings: { compaction: { contextProjection: "off", enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("incomplete after silent overflow")),
			fauxAssistantMessage("must not be used"),
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(1);
		const [message] = assistants(harness);
		expect(message.stopReason).toBe("stop");
		expect(message.diagnostics).toEqual([
			expect.objectContaining({
				type: "incomplete_turn",
				details: expect.objectContaining({ overflowKind: "context", consecutiveTurns: 1 }),
			}),
		]);
		expect(settledFailures(harness)).toEqual([
			{
				kind: "incomplete_turn",
				reason: "no_visible_output",
				message: expect.stringContaining("automatic compaction is disabled"),
			},
		]);
		expect(recoveryEntries(harness)).toHaveLength(0);
	});

	it("explains why an uncommittable silent overflow could not compact", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			settings: { compaction: { contextProjection: "off", enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxThinking("incomplete after silent overflow"))]);

		await harness.session.prompt("Inspect the workspace");

		expect(settledFailures(harness)[0].message).toContain("compaction did not complete");
		expect(settledFailures(harness)[0].message).not.toMatch(/compaction did not complete\.$/);
	});

	it("applies the silent-overflow guard to a tool-use turn that carries no tool call", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			settings: { compaction: { contextProjection: "off", enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([], { stopReason: "toolUse" }),
			fauxAssistantMessage("must not be used"),
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(1);
		expect(assistants(harness)[0].incomplete).toBe("missing_tool_call");
		expect(recoveryEntries(harness)).toHaveLength(0);
		expect(settledFailures(harness)).toEqual([
			{
				kind: "incomplete_turn",
				reason: "missing_tool_call",
				message: expect.stringContaining("automatic compaction is disabled"),
			},
		]);
	});

	it("compacts a silent overflow on an empty tool-use turn without replaying it", async () => {
		// The assistant message is restored by the compaction, so a retry would see an
		// assistant at the tail and `agent.continue()` would reject the run.
		const harness = await createHarness({
			sessionPersistence: true,
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			settings: { compaction: { contextProjection: "off", enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "silent overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		// Overflow recovery needs history old enough to summarize.
		for (const message of [
			{ role: "user" as const, content: "Investigate the parser", timestamp: 1 },
			fauxAssistantMessage("prior observation ".repeat(200), { timestamp: 2 }),
			{ role: "user" as const, content: "Continue", timestamp: 3 },
		]) {
			harness.sessionManager.appendMessage(message);
		}
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage([], { stopReason: "toolUse" }),
			fauxAssistantMessage("Recovered after compaction."),
		]);

		await expect(harness.session.prompt("Inspect the workspace")).resolves.toBeUndefined();

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.getLastAssistantText()).toBe("Recovered after compaction.");
		expect(settledFailures(harness)).toEqual([]);
		// The recovered message is persisted, not mutated after the fact.
		const sessionFile = harness.sessionManager.getSessionFile();
		const reloaded = SessionManager.open(sessionFile!).getBranch();
		expect(
			reloaded
				.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []))
				.map((message) => message.incomplete),
		).toEqual([undefined, "missing_tool_call", undefined]);
	});

	it("does not refill the budget when an error or an abort alternates with an empty turn", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 0 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("empty")),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 upstream" }),
			fauxAssistantMessage(fauxThinking("empty again")),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 upstream" }),
			fauxAssistantMessage(fauxThinking("never reached")),
			fauxAssistantMessage("never reached"),
		]);

		await harness.session.prompt("Inspect the workspace");

		// Two consecutive empty turns ended the run: the errors between them are not
		// progress, so they must not refill the recovery budget.
		const messages = assistants(harness);
		expect(messages.filter((message) => message.incomplete !== undefined)).toHaveLength(2);
		expect(settledFailures(harness)).toEqual([
			{ kind: "incomplete_turn", reason: "no_visible_output", message: INCOMPLETE_TURN_MESSAGES.no_visible_output },
		]);
	});

	it("keeps the incomplete diagnostic after a reload", async () => {
		const harness = await createHarness({ sessionPersistence: true });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("first attempt")),
			fauxAssistantMessage(fauxThinking("second attempt")),
		]);

		await harness.session.prompt("Inspect the workspace");

		const sessionFile = harness.sessionManager.getSessionFile();
		const reloaded = SessionManager.open(sessionFile!)
			.getBranch()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
		expect(reloaded.map((message) => message.incomplete)).toEqual(["no_visible_output", "no_visible_output"]);
		expect(reloaded[1].diagnostics).toEqual([
			expect.objectContaining({
				type: "incomplete_turn",
				details: expect.objectContaining({ reason: "no_visible_output", consecutiveTurns: 2 }),
			}),
		]);
	});

	it("keeps an executed tool batch paired with its call when the turn overflowed", async () => {
		// A tool-use turn that did deliver its calls is not an incomplete turn, and
		// overflow recovery must not remove it: the results already follow it.
		const blocker: AgentTool = {
			name: "blocker",
			label: "Blocker",
			description: "Ends the turn",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "stopped here" }],
				details: {},
				terminate: true,
			}),
		};
		const harness = await createHarness({
			tools: [blocker],
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			settings: { compaction: { contextProjection: "off", enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("blocker", {}), { stopReason: "toolUse" })]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(1);
		expect(recoveryEntries(harness)).toHaveLength(0);
		expect(settledFailures(harness)).toEqual([]);
		const messages = harness.session.messages;
		const callIndex = messages.findIndex(
			(message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
		);
		expect(callIndex).toBeGreaterThanOrEqual(0);
		expect(messages[callIndex + 1]).toMatchObject({ role: "toolResult", toolName: "blocker" });
	});

	it("settles quietly when the user aborts during silent-overflow compaction", async () => {
		let harness: Harness;
		harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			settings: { compaction: { contextProjection: "off", enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => {
						void harness.session.abort();
						return { cancel: true };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("incomplete after silent overflow")),
			fauxAssistantMessage("must not be used"),
		]);

		await expect(harness.session.prompt("Inspect the workspace")).resolves.toBeUndefined();

		expect(harness.faux.state.callCount).toBe(1);
		expect(settledFailures(harness)).toEqual([]);
		expect(recoveryEntries(harness)).toHaveLength(0);
	});

	it("does not persist a recovery prompt when the run is aborted before continuation", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				const message = fauxAssistantMessage(fauxThinking("incomplete before abort"));
				void harness.session.abort();
				return message;
			},
			fauxAssistantMessage("must not be used"),
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(1);
		expect(recoveryEntries(harness)).toHaveLength(0);
		expect(settledFailures(harness)).toEqual([]);
	});

	it("persists the recovery prompt once its continuation has started", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("incomplete before recovery")),
			fauxAssistantMessage("the recovery request ran"),
		]);
		harness.session.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "custom" &&
				event.message.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE
			) {
				void harness.session.abort();
			}
		});

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(2);
		expect(recoveryEntries(harness)).toHaveLength(1);
	});

	it("gives a new top-level run its own recovery budget", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("first run, first attempt")),
			fauxAssistantMessage("first run recovered"),
			fauxAssistantMessage(fauxThinking("second run, first attempt")),
			fauxAssistantMessage("second run recovered"),
		]);

		await harness.session.prompt("First run");
		await harness.session.prompt("Second run");

		expect(harness.faux.state.callCount).toBe(4);
		expect(recoveryEntries(harness)).toHaveLength(2);
		expect(settledFailures(harness)).toEqual([]);
	});

	it("leaves the decision to a host that owns completion", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setIncompleteTurnRecoveryEnabled(false);
		harness.setResponses([fauxAssistantMessage(fauxThinking("the host owns completion"))]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(1);
		expect(recoveryEntries(harness)).toHaveLength(0);
		expect(settledFailures(harness)).toEqual([]);
		// The structural fact still describes the turn that was persisted.
		expect(assistants(harness)[0].incomplete).toBe("no_visible_output");
	});

	it("does not recover a truncated turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxThinking("truncated reasoning"), { stopReason: "length" })]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(1);
		expect(recoveryEntries(harness)).toHaveLength(0);
		expect(assistants(harness).some((message) => message.incomplete !== undefined)).toBe(false);
	});

	it("does not treat tool-call-like text as an incomplete turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("<tool_call>this is an example, not an executable call</tool_call>")]);

		await harness.session.prompt("Explain the markup");

		expect(harness.faux.state.callCount).toBe(1);
		expect(recoveryEntries(harness)).toHaveLength(0);
		expect(assistants(harness).some((message) => message.incomplete !== undefined)).toBe(false);
	});

	it("delivers a follow-up queued after a terminal incomplete turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let queued = false;
		harness.session.subscribe((event) => {
			if (event.type !== "agent_end" || queued || harness.eventsOfType("agent_end").length !== 2) return;
			queued = true;
			harness.session.agent.followUp({
				role: "user",
				content: [{ type: "text", text: "Try a different approach." }],
				timestamp: Date.now(),
			});
		});
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("first attempt")),
			fauxAssistantMessage(fauxThinking("second attempt")),
			fauxAssistantMessage("Answered the follow-up."),
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.getLastAssistantText()).toBe("Answered the follow-up.");
		// The queued turn resolved the run, so the earlier empty turns are not its outcome.
		expect(settledFailures(harness)).toEqual([]);
	});

	it("lets the user's own stop outrank a terminal empty turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let ends = 0;
		harness.session.subscribe((event) => {
			if (event.type !== "agent_end") return;
			ends += 1;
			// The second attempt is the terminal one; the user stops the run before it
			// settles.
			if (ends === 2) void harness.session.abort();
		});
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("first attempt")),
			fauxAssistantMessage(fauxThinking("second attempt")),
		]);

		await harness.session.prompt("Inspect the workspace");

		// The second empty turn is terminal by classification, but the user ended the
		// run: a pause must not be reported as a failure.
		expect(assistants(harness)[1].incomplete).toBe("no_visible_output");
		expect(settledFailures(harness)).toEqual([]);
	});

	it("treats user input after a terminal empty turn as the run's outcome", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let ends = 0;
		harness.session.subscribe((event) => {
			if (event.type !== "agent_end") return;
			ends += 1;
			// The second attempt is the terminal one; the user answers it themselves.
			if (ends !== 2) return;
			harness.session.agent.steer({
				role: "user",
				content: [{ type: "text", text: "Use the new direction." }],
				timestamp: Date.now(),
			});
		});
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("first attempt")),
			fauxAssistantMessage(fauxThinking("second attempt")),
			fauxAssistantMessage("Answered the direction."),
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.session.getLastAssistantText()).toBe("Answered the direction.");
		// The user's own input decides the run, so the empty turn before it is not the
		// outcome even though it was classified as terminal.
		expect(settledFailures(harness)).toEqual([]);
	});

	it("classifies a hand-built string content without failing the run", async () => {
		// An extension replacement is only normalized for a missing container, so a
		// plain string reaches the classifier exactly as a legacy session file would.
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "assistant") return undefined;
						return { message: { ...event.message, content: "an older transcript" } as never };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxThinking("provider text"))]);

		await expect(harness.session.prompt("Inspect the workspace")).resolves.toBeUndefined();

		// No blocks can be read, so the turn is empty by structure; the diagnostic is
		// written without throwing.
		const [message] = assistants(harness);
		expect(message.incomplete).toBe("no_visible_output");
		expect(message.diagnostics).toEqual([
			expect.objectContaining({
				type: "incomplete_turn",
				details: expect.objectContaining({ reason: "no_visible_output", hadVisibleText: false }),
			}),
		]);
	});

	it.each([
		["no visible output", () => fauxAssistantMessage(fauxThinking("reasoning")), "no_visible_output"],
		["a tool-use turn with no call", () => fauxAssistantMessage([], { stopReason: "toolUse" }), "missing_tool_call"],
	] as const)("derives the turn and the run from one classification: %s", async (_label, respond, reason) => {
		// The message-level `incomplete` and the run-level failure are two projections of
		// the same decision. If they ever diverge, a consumer reading one of them is
		// wrong while every single-shaped test still passes.
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([respond(), respond()]);

		await harness.session.prompt("Inspect the workspace");

		const messages = assistants(harness).filter((message) => message.incomplete !== undefined);
		expect(messages.map((message) => message.incomplete)).toEqual([reason, reason]);
		expect(settledFailures(harness)).toEqual([
			{ kind: "incomplete_turn", reason, message: INCOMPLETE_TURN_MESSAGES[reason] },
		]);
	});

	it("does not recover a provider error", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(1);
		const [message] = assistants(harness);
		expect(message.stopReason).toBe("error");
		expect(message.incomplete).toBeUndefined();
		expect(recoveryEntries(harness)).toHaveLength(0);
		expect(settledFailures(harness)).toEqual([]);
	});

	it("delivers queued input after a terminal incomplete turn instead of dropping it", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let queued = false;
		harness.session.subscribe((event) => {
			if (event.type !== "agent_end" || queued) return;
			queued = true;
			harness.session.agent.steer({
				role: "user",
				content: [{ type: "text", text: "Use the new direction." }],
				timestamp: Date.now(),
			});
		});
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("first attempt")),
			fauxAssistantMessage(fauxThinking("second attempt")),
			fauxAssistantMessage("Visible answer after the queued input."),
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(3);
		expect(assistants(harness).at(-1)?.content).toEqual([fauxText("Visible answer after the queued input.")]);
		// The queued turn resolved the run, so the earlier failure is not the outcome.
		expect(settledFailures(harness)).toEqual([]);
	});
});
