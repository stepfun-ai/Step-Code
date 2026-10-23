import { fauxAssistantMessage } from "@step-harness/providers";
import { expect, it } from "vitest";
import { createHarness } from "../harness.ts";

/**
 * `pi.sendUserMessage` and `pi.sendMessage({ triggerTurn })` are fire-and-forget
 * bindings: an extension command handler that hands work to the agent returns
 * before that turn finishes. `prompt()` used to report the command as complete
 * at that point, so a host that disposes right after `prompt()` — print and JSON
 * mode both do — tore the session down mid-turn. Every in-flight extension then
 * failed with "stale after session replacement or reload", and the task never ran.
 */

it("waits for a turn an extension command started before reporting completion", async () => {
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerCommand("deferred-task", {
					// `async` without awaiting: the handler returns while the turn runs,
					// which is exactly how `/plan <task>` hands the task to the session.
					handler: async (_args, _ctx) => {
						pi.sendUserMessage("Do the deferred task.");
					},
				});
			},
		],
	});

	try {
		harness.setResponses([() => fauxAssistantMessage("deferred task done")]);

		await harness.session.prompt("/deferred-task");

		// The command's own prompt must not resolve until its turn has settled.
		const assistant = harness.session.messages.filter((message) => message.role === "assistant");
		expect(assistant).toHaveLength(1);
		expect(JSON.stringify(assistant[0]?.content)).toContain("deferred task done");
		expect(harness.getPendingResponseCount()).toBe(0);
	} finally {
		harness.cleanup();
	}
});

it("waits for a custom message that triggers a turn", async () => {
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerCommand("deferred-custom", {
					handler: async (_args, _ctx) => {
						pi.sendMessage(
							{ customType: "deferred", content: "Do the deferred task.", display: false },
							{ triggerTurn: true },
						);
					},
				});
			},
		],
	});

	try {
		harness.setResponses([() => fauxAssistantMessage("custom task done")]);

		await harness.session.prompt("/deferred-custom");

		const assistant = harness.session.messages.filter((message) => message.role === "assistant");
		expect(assistant).toHaveLength(1);
		expect(JSON.stringify(assistant[0]?.content)).toContain("custom task done");
		expect(harness.getPendingResponseCount()).toBe(0);
	} finally {
		harness.cleanup();
	}
});

it("does not delay a command that starts no turn", async () => {
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerCommand("noop", { handler: async (_args, _ctx) => {} });
			},
		],
	});

	try {
		harness.setResponses([() => fauxAssistantMessage("must not be requested")]);

		await harness.session.prompt("/noop");

		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(1);
	} finally {
		harness.cleanup();
	}
});
