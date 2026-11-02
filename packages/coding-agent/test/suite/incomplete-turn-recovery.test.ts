import type { AgentTool } from "@step-harness/agent-core";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@step-harness/providers";
import type { AssistantMessage } from "@step-harness/providers/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE } from "../../src/core/incomplete-turn-recovery.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

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
		expect(requests[0]).toContain("I don't see a visible answer or a tool call");
		expect(requests[0]).toContain("I should run the command.");

		const assistants = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants).toHaveLength(2);
		expect(assistants[0].content).toEqual([
			fauxThinking("I should run the command. <tool_call><function=run_command>echo hi</function></tool_call>"),
		]);
		expect(assistants[1].content).toEqual([fauxText("Recovered with a visible answer.")]);

		const recoveryEntries = harness.sessionManager
			.getBranch()
			.filter(
				(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
			);
		expect(recoveryEntries).toHaveLength(1);
		expect(recoveryEntries[0]).toMatchObject({ display: false });
		expect(getMessageText(recoveryEntries[0])).toContain("I don't see a visible answer or a tool call");
		expect(harness.eventsOfType("tool_execution_start")).toEqual([]);
	});

	it("marks a second incomplete turn as an error instead of a normal stop", async () => {
		const harness = await createHarness({ sessionPersistence: true });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("first attempt")),
			fauxAssistantMessage(fauxThinking("second attempt")),
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(2);
		const assistants = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants).toHaveLength(2);
		expect(assistants[1].stopReason).toBe("error");
		expect(assistants[1].errorMessage).toBe("The model returned no visible answer or executable tool call.");
		expect(assistants[1].diagnostics).toEqual([
			expect.objectContaining({
				type: "incomplete_turn",
				details: {
					recoveryAttempts: 1,
					reason: "no_visible_output",
					hadThinking: true,
					hadVisibleText: false,
				},
			}),
		]);
		const persisted = harness.sessionManager
			.getBranch()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
		expect(persisted).toHaveLength(2);
		expect(persisted[1]).toMatchObject({
			stopReason: "error",
			errorMessage: "The model returned no visible answer or executable tool call.",
		});

		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const reloaded = SessionManager.open(sessionFile!);
		const reloadedEntries = reloaded.getBranch();
		expect(
			reloadedEntries.filter(
				(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
			),
		).toHaveLength(1);
		const reloadedAssistants = reloadedEntries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
		);
		expect(reloadedAssistants).toHaveLength(2);
		expect(reloadedAssistants[1]).toMatchObject({
			stopReason: "error",
			errorMessage: "The model returned no visible answer or executable tool call.",
			diagnostics: [
				expect.objectContaining({
					type: "incomplete_turn",
					details: expect.objectContaining({
						recoveryAttempts: 1,
						reason: "no_visible_output",
					}),
				}),
			],
		});
	});

	it("does not enter the generic retry path after marking a turn incomplete", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("first attempt")),
			fauxAssistantMessage(fauxThinking("second attempt")),
			fauxAssistantMessage("generic retry must not run"),
		]);
		const session = harness.session as unknown as {
			_isRetryableError(message: AssistantMessage): boolean;
		};
		const willRetry: boolean[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "agent_end") willRetry.push(event.willRetry);
		});
		const original = session._isRetryableError;
		// Forcing the text-based retry classifier to accept the rewritten message
		// is the direct proof that the structured marker, not the wording of the
		// diagnostic, stops another continuation.
		session._isRetryableError = () => true;
		try {
			await harness.session.prompt("Inspect the workspace");
		} finally {
			session._isRetryableError = original;
		}

		expect(harness.faux.state.callCount).toBe(2);
		const assistants = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants).toHaveLength(2);
		expect(assistants[1].stopReason).toBe("error");
		expect(willRetry).toEqual([false, false]);
	});

	it("marks a second incomplete turn as an error even when queued input skipped the first recovery", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				await harness.session.prompt("Use the new direction.", { streamingBehavior: "steer" });
				return fauxAssistantMessage(fauxThinking("first attempt"));
			},
			fauxAssistantMessage(fauxThinking("second attempt after steering")),
			fauxAssistantMessage("must not be used"),
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(2);
		const assistants = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants).toHaveLength(2);
		expect(assistants[1].stopReason).toBe("error");
		expect(assistants[1].diagnostics).toEqual([
			expect.objectContaining({
				type: "incomplete_turn",
				details: expect.objectContaining({
					recoveryAttempts: 0,
					reason: "no_visible_output",
				}),
			}),
		]);
		expect(
			harness.sessionManager
				.getBranch()
				.some(
					(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
				),
		).toBe(false);
	});

	it("finalizes the terminal stop reason after extension content replacement", async () => {
		const observedByExtension: string[] = [];
		const observedAtTurnEnd: string[] = [];
		const observedBySession: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role === "assistant") observedByExtension.push(event.message.stopReason);
					});
					pi.on("turn_end", (event) => {
						if (event.message.role === "assistant") observedAtTurnEnd.push(event.message.stopReason);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				observedBySession.push(event.message.stopReason);
			}
		});
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("first attempt")),
			fauxAssistantMessage(fauxThinking("second attempt")),
		]);

		await harness.session.prompt("Inspect the workspace");

		const persisted = harness.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "assistant" ? [entry.message.stopReason] : [],
			);
		// message_end handlers run before the session's terminal classification.
		expect(observedByExtension).toEqual(["stop", "stop"]);
		expect(observedAtTurnEnd).toEqual(["stop", "error"]);
		expect(observedBySession).toEqual(["stop", "error"]);
		expect(persisted).toEqual(["stop", "error"]);
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
		expect(
			harness.sessionManager
				.getBranch()
				.some(
					(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
				),
		).toBe(false);
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
		expect(
			harness.sessionManager
				.getBranch()
				.filter(
					(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
				),
		).toHaveLength(1);
	});

	it("allows only one recovery across a tool continuation", async () => {
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
			fauxAssistantMessage("must not be used"),
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(3);
		const recoveryEntries = harness.sessionManager
			.getBranch()
			.filter(
				(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
			);
		expect(recoveryEntries).toHaveLength(1);
		const assistants = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants).toHaveLength(3);
		expect(assistants[2].stopReason).toBe("error");
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("lets queued user input resolve the turn without injecting a stale recovery prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				await harness.session.prompt("Use the new direction.", { streamingBehavior: "steer" });
				return fauxAssistantMessage(fauxThinking("first attempt"));
			},
			fauxAssistantMessage("Visible answer to the new direction."),
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(2);
		const assistants = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants[0].content).toEqual([fauxThinking("first attempt")]);
		expect(assistants[1].content).toEqual([fauxText("Visible answer to the new direction.")]);
		expect(
			harness.sessionManager
				.getBranch()
				.some(
					(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
				),
		).toBe(false);
	});

	it("lets an agent_end follow-up resolve the turn without injecting a stale recovery prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let queued = false;
		harness.session.subscribe((event) => {
			if (event.type !== "agent_end" || queued) return;
			queued = true;
			harness.session.agent.followUp({
				role: "user",
				content: [{ type: "text", text: "Use the new direction." }],
				timestamp: Date.now(),
			});
		});
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("first attempt")),
			fauxAssistantMessage("Visible answer to the follow-up."),
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(2);
		const assistants = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants[1].content).toEqual([fauxText("Visible answer to the follow-up.")]);
		expect(
			harness.sessionManager
				.getBranch()
				.some(
					(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
				),
		).toBe(false);
	});

	it("lets a steer queued at agent_end resolve the turn without injecting a recovery prompt", async () => {
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
			fauxAssistantMessage("Visible answer to the steer."),
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(2);
		const assistants = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants).toHaveLength(2);
		expect(assistants[1].content).toEqual([fauxText("Visible answer to the steer.")]);
		expect(
			harness.sessionManager
				.getBranch()
				.some(
					(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
				),
		).toBe(false);
	});

	it("lets queued input finish after a second incomplete turn is marked as an error", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let queued = 0;
		harness.session.subscribe((event) => {
			if (event.type !== "agent_end" || queued >= 2) return;
			queued += 1;
			harness.session.agent.steer({
				role: "user",
				content: [{ type: "text", text: `Use direction ${queued}.` }],
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
		const assistants = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants).toHaveLength(3);
		expect(assistants[1].stopReason).toBe("error");
		expect(assistants[2].content).toEqual([fauxText("Visible answer after the queued input.")]);
		expect(
			harness.sessionManager
				.getBranch()
				.some(
					(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
				),
		).toBe(false);
	});

	it("does not spend a second recovery when steering adds another incomplete turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("first attempt")),
			async () => {
				await harness.session.prompt("Use the new direction.", { streamingBehavior: "steer" });
				return fauxAssistantMessage(fauxThinking("second attempt after steering"));
			},
			fauxAssistantMessage(fauxThinking("third attempt")),
			fauxAssistantMessage("must not be used"),
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(3);
		const recoveryEntries = harness.sessionManager
			.getBranch()
			.filter(
				(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
			);
		expect(recoveryEntries).toHaveLength(1);
		const assistants = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants).toHaveLength(3);
		expect(assistants[2].stopReason).toBe("error");
		expect(harness.getPendingResponseCount()).toBe(1);
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
		await harness.session.sendCustomMessage(
			{ customType: "test-trigger", content: "Second run", display: false },
			{ triggerTurn: true },
		);

		expect(harness.faux.state.callCount).toBe(4);
		const recoveryEntries = harness.sessionManager
			.getBranch()
			.filter(
				(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
			);
		expect(recoveryEntries).toHaveLength(2);
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
		expect(
			harness.sessionManager
				.getBranch()
				.some(
					(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
				),
		).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);
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
		const recoveryEntries = harness.sessionManager
			.getBranch()
			.filter(
				(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
			);
		expect(recoveryEntries).toHaveLength(1);
	});

	it("recovers a tool-use stop that carries no structured tool call", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([], { stopReason: "toolUse" }),
			fauxAssistantMessage("Finished after recovery."),
		]);

		await harness.session.prompt("Run the task");

		expect(harness.faux.state.callCount).toBe(2);
		expect(
			harness.sessionManager
				.getBranch()
				.some(
					(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
				),
		).toBe(true);
	});

	it("uses missing-tool-call guidance when a tool-use turn has visible text but no call", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const requests: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxText("I will inspect the workspace."), { stopReason: "toolUse" }),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage(fauxThinking("still no call"), { stopReason: "toolUse" });
			},
		]);

		await harness.session.prompt("Run the task");

		expect(harness.faux.state.callCount).toBe(2);
		expect(requests[0]).toContain("I don't see an executable tool call");
		expect(requests[0]).not.toContain("I don't see a visible answer or a tool call");
		const assistants = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants[1].stopReason).toBe("error");
		expect(assistants[1].errorMessage).toBe("The model ended a tool-use turn without an executable tool call.");
		expect(assistants[1].diagnostics).toEqual([
			expect.objectContaining({
				type: "incomplete_turn",
				details: {
					recoveryAttempts: 1,
					reason: "missing_tool_call",
					hadThinking: true,
					hadVisibleText: false,
				},
			}),
		]);
	});

	it("fails immediately when a silent overflow cannot be compacted", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			settings: { compaction: { contextProjection: "off", enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("incomplete after silent overflow")),
			fauxAssistantMessage("must not be used"),
		]);
		const willRetry: boolean[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "agent_end") willRetry.push(event.willRetry);
		});

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(1);
		expect(willRetry).toEqual([false]);
		const assistants = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants).toHaveLength(1);
		expect(assistants[0].stopReason).toBe("error");
		expect(assistants[0].errorMessage).toContain("automatic compaction is disabled");
		expect(assistants[0].diagnostics).toEqual([
			expect.objectContaining({
				type: "incomplete_turn",
				details: {
					recoveryAttempts: 0,
					reason: "no_visible_output",
					hadThinking: true,
					hadVisibleText: false,
					overflowKind: "context",
					compaction: "disabled",
				},
			}),
		]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("fails the run without rewriting the published assistant when silent-overflow compaction is cancelled", async () => {
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
		const observedFailures: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "incomplete_turn_recovery_failed") throw new Error("listener exploded");
		});
		harness.session.subscribe(async (event) => {
			if (event.type === "incomplete_turn_recovery_failed") throw new Error("async listener exploded");
		});
		harness.session.subscribe((event) => {
			if (event.type === "incomplete_turn_recovery_failed") observedFailures.push(event.errorMessage);
		});

		await expect(harness.session.prompt("Inspect the workspace")).rejects.toThrow(
			"Cannot recover an incomplete assistant turn because automatic compaction did not complete.",
		);

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("incomplete_turn_recovery_failed")).toEqual([
			{
				type: "incomplete_turn_recovery_failed",
				reason: "no_visible_output",
				errorMessage: "Cannot recover an incomplete assistant turn because automatic compaction did not complete.",
				overflowKind: "context",
			},
		]);
		expect(observedFailures).toEqual([
			"Cannot recover an incomplete assistant turn because automatic compaction did not complete.",
		]);
		const assistants = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants[0].stopReason).toBe("stop");
		expect(assistants[0].diagnostics).toBeUndefined();
		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const reloaded = SessionManager.open(sessionFile!);
		const reloadedAssistants = reloaded
			.getBranch()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
		expect(reloadedAssistants[0].stopReason).toBe("stop");
		expect(reloadedAssistants[0].diagnostics).toBeUndefined();
		expect(
			harness.sessionManager
				.getBranch()
				.some(
					(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
				),
		).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not drain queued input when silent-overflow compaction fails", async () => {
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
		harness.session.subscribe((event) => {
			if (event.type !== "agent_end") return;
			harness.session.agent.followUp({
				role: "user",
				content: [{ type: "text", text: "Use the new direction." }],
				timestamp: Date.now(),
			});
		});
		harness.setResponses([fauxAssistantMessage(fauxThinking("incomplete after silent overflow"))]);

		await expect(harness.session.prompt("Inspect the workspace")).rejects.toThrow(
			"Cannot recover an incomplete assistant turn because automatic compaction did not complete.",
		);

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(
			harness.sessionManager
				.getBranch()
				.some(
					(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
				),
		).toBe(false);
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
		const assistants = harness.session.messages.filter(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(assistants[0].stopReason).toBe("stop");
		expect(assistants[0].diagnostics).toBeUndefined();
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("persists the recovery prompt before v2 threshold compaction rebuilds state", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 20_000, maxTokens: 2_048 }],
			tools: [],
			settings: {
				compaction: {
					contextProjection: "off",
					enabled: true,
					keepRecentTokens: 100,
					reserveTokens: 0,
					triggerRatio: 0.5,
				},
				retry: { enabled: false },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "threshold compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		const seeded = [
			{ role: "user" as const, content: "Investigate the parser", timestamp: 1 },
			fauxAssistantMessage("prior observation ".repeat(2_000), { timestamp: 2 }),
			{ role: "user" as const, content: "Continue from the observation", timestamp: 3 },
		];
		for (const message of seeded) harness.sessionManager.appendMessage(message);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const requests: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxThinking("incomplete with a large reasoning block ".repeat(100))),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("Recovered after threshold compaction.");
			},
		]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("I don't see a visible answer or a tool call");
		expect(requests[0]).toContain("incomplete with a large reasoning block");
		expect(harness.session.agent.state.messages).toEqual(harness.sessionManager.buildSessionContext().messages);
		const recoveryEntries = harness.sessionManager
			.getBranch()
			.filter(
				(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
			);
		expect(recoveryEntries).toHaveLength(1);
	});

	it("does not recover when compaction leaves a user decision pending", async () => {
		let harness: Harness;
		harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			settings: { compaction: { contextProjection: "off", enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						harness.session.registerAutomaticTurnGuard(() => true);
						return {
							compaction: {
								summary: "silent overflow compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
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
		expect(
			harness.sessionManager
				.getBranch()
				.some(
					(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
				),
		).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not recover a truncated turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxThinking("truncated reasoning"), { stopReason: "length" })]);

		await harness.session.prompt("Inspect the workspace");

		expect(harness.faux.state.callCount).toBe(1);
		expect(
			harness.sessionManager
				.getBranch()
				.some(
					(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
				),
		).toBe(false);
	});

	it("does not inspect or recover a visible text response that contains tool-call-like text", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("<tool_call>this is an example, not an executable call</tool_call>")]);

		await harness.session.prompt("Explain the markup");

		expect(harness.faux.state.callCount).toBe(1);
		expect(
			harness.sessionManager
				.getBranch()
				.some(
					(entry) => entry.type === "custom_message" && entry.customType === INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
				),
		).toBe(false);
	});
});
