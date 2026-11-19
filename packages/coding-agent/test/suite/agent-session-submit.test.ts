import type { AgentTool } from "@step-harness/agent-core";
import type { ExtensionAPI } from "@step-harness/coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.ts";

/**
 * `submit()` is the one entry a host should call: a command runs immediately
 * whether or not a run is going, and everything else runs as a turn or joins
 * the running one. These tests pin that ordering, because a host that instead
 * guesses (`steer()` while a run is going, a queue of its own) has to know
 * something about the kernel it should not have to know.
 */
describe("AgentSession.submit", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createRunningHarness(commandRuns: string[] = []): Promise<{
		harness: Harness;
		releaseToolExecution: () => void;
		promptPromise: Promise<void>;
	}> {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);
		const waitForToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start" && event.toolName === "wait") {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = harness.session.prompt("start");
		await waitForToolStart;
		return { harness, releaseToolExecution: () => releaseToolExecution?.(), promptPromise };
	}

	it("recognizes the lines the kernel runs instead of sending", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", { description: "Test command", handler: async () => {} });
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([]);

		expect(harness.session.isCommandInput("/testcmd")).toBe(true);
		expect(harness.session.isCommandInput("/testcmd with args")).toBe(true);
		// Handled by the session itself, before any registered command.
		expect(harness.session.isCommandInput("/clm status")).toBe(true);
		expect(harness.session.isCommandInput("/clm-compact")).toBe(true);
		// Expanded into a message, so they queue like text.
		expect(harness.session.isCommandInput("/skill:anything")).toBe(false);
		// Not a command: an unknown name, a path, prose, and bare slashes.
		expect(harness.session.isCommandInput("/usr/local/bin is missing")).toBe(false);
		expect(harness.session.isCommandInput("/")).toBe(false);
		expect(harness.session.isCommandInput("plain words")).toBe(false);
	});

	it("runs a command sent during a run instead of queueing it", async () => {
		const commandRuns: string[] = [];
		const { harness, releaseToolExecution, promptPromise } = await createRunningHarness(commandRuns);

		await harness.session.submit("/testcmd now");

		// Already ran, and nowhere in either queue: a command is not a message.
		expect(commandRuns).toEqual(["now"]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);

		releaseToolExecution();
		await promptPromise;
	});

	it("queues text into the running turn, steering by default", async () => {
		const { harness, releaseToolExecution, promptPromise } = await createRunningHarness();

		await harness.session.submit("go left");

		expect(harness.session.getSteeringMessages()).toEqual(["go left"]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);

		releaseToolExecution();
		await promptPromise;
	});

	it("queues text as a follow-up when asked", async () => {
		const { harness, releaseToolExecution, promptPromise } = await createRunningHarness();

		await harness.session.submit("after this", { duringRun: "followUp" });

		expect(harness.session.getFollowUpMessages()).toEqual(["after this"]);
		expect(harness.session.getSteeringMessages()).toEqual([]);

		releaseToolExecution();
		await promptPromise;
	});

	it("starts a turn when nothing runs, without the caller checking first", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("answered")]);

		await harness.session.submit("hello there", { duringRun: "followUp" });

		expect(getUserTexts(harness)).toEqual(["hello there"]);
		expect(getAssistantTexts(harness)).toEqual(["answered"]);
	});

	it("refuses to steer a session-handled command too", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// `/clm` is dispatched by the session itself, not by an extension, and it
		// used to slip past the guard and reach the model as literal text.
		await expect(harness.session.steer("/clm status")).rejects.toThrow(
			'Command "/clm" cannot be queued as a message.',
		);
		expect(harness.session.getSteeringMessages()).toEqual([]);
	});

	it("keeps a skill command a message rather than a command", async () => {
		const { harness, releaseToolExecution, promptPromise } = await createRunningHarness();

		// An unknown skill passes through as text, so it joins the run as a steer.
		await harness.session.submit("/skill:missing do this");
		expect(harness.session.getSteeringMessages()).toEqual(["/skill:missing do this"]);

		releaseToolExecution();
		await promptPromise;
	});
});
