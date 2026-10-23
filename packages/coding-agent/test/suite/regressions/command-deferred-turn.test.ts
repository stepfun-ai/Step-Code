import { fauxAssistantMessage } from "@step-harness/providers";
import { expect, it, vi } from "vitest";
import { createHarness } from "../harness.ts";

/**
 * `pi.sendUserMessage` and `pi.sendMessage({ triggerTurn })` are fire-and-forget
 * bindings: an extension command handler that hands work to the agent returns
 * before that turn finishes. `prompt()` used to report the command as complete
 * at that point, so a host that disposes right after `prompt()` — print and JSON
 * mode both do — tore the session down mid-turn. Every in-flight extension then
 * failed with "stale after session replacement or reload", and the task never ran.
 *
 * The command is still *accepted* as soon as its handler returns: the acceptance
 * signal must not wait for the turn, or an RPC client gating on it stalls.
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

it("accepts the command before the turn it started has finished", async () => {
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerCommand("deferred-ack", {
					handler: async (_args, _ctx) => {
						pi.sendUserMessage("Do the deferred task.");
					},
				});
			},
		],
	});

	try {
		harness.setResponses([() => fauxAssistantMessage("done")]);

		let acceptedAtAssistantCount: number | undefined;
		await harness.session.prompt("/deferred-ack", {
			preflightResult: (accepted) => {
				if (!accepted) return;
				// RPC answers the client from this callback, so it must fire before the
				// deferred turn finishes rather than after it.
				acceptedAtAssistantCount = harness.session.messages.filter(
					(message) => message.role === "assistant",
				).length;
			},
		});

		expect(acceptedAtAssistantCount).toBe(0);
		// The turn did run, and only settled by the time the prompt resolved.
		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
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

		let accepted = false;
		const markAccepted = (succeeded: boolean): void => {
			if (succeeded) accepted = true;
		};
		await harness.session.prompt("/noop", { preflightResult: markAccepted });

		expect(accepted).toBe(true);
		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(1);
	} finally {
		harness.cleanup();
	}
});

it("keeps a failed deferred turn from failing the command itself", async () => {
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerCommand("deferred-failure", {
					handler: async (_args, _ctx) => {
						void pi.sendUserMessage("Do the deferred task.");
					},
				});
			},
		],
	});

	try {
		const errors: string[] = [];
		await harness.session.bindExtensions({ onError: (error) => errors.push(String(error.error)) });
		// A preflight refusal (no model, compaction in progress) rejects this call.
		vi.spyOn(harness.session, "sendUserMessage").mockRejectedValue(new Error("preflight refused"));

		// The command itself was handled, so waiting on a rejected turn must not
		// turn into a rejected prompt.
		await expect(harness.session.prompt("/deferred-failure")).resolves.toBeUndefined();
		// The failure is still reported through the ordinary extension error path.
		expect(errors.join("|")).toContain("preflight refused");
	} finally {
		harness.cleanup();
	}
});

it("still waits when two command handlers overlap and finish out of order", async () => {
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				// `/slow` parks before deferring; `/quick` defers immediately but
				// settles later, so the two trackers overlap and unwind out of order.
				pi.registerCommand("slow", {
					handler: async (_args, _ctx) => {
						await new Promise((resolve) => setTimeout(resolve, 20));
						pi.sendUserMessage("slow task");
					},
				});
				pi.registerCommand("quick", {
					handler: async (_args, _ctx) => {
						await new Promise((resolve) => setTimeout(resolve, 40));
						pi.sendUserMessage("quick task");
					},
				});
			},
		],
	});

	try {
		harness.setResponses([() => fauxAssistantMessage("slow done"), () => fauxAssistantMessage("quick done")]);

		const slow = harness.session.prompt("/slow");
		const quick = harness.session.prompt("/quick");
		await Promise.all([slow, quick]);

		// Both turns ran; neither escaped its command's wait.
		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
		expect(harness.getPendingResponseCount()).toBe(0);
	} finally {
		harness.cleanup();
	}
});

it("waits for a nested command's deferred turn", async () => {
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerCommand("inner", {
					handler: async (_args, _ctx) => {
						pi.sendUserMessage("inner task");
					},
				});
				pi.registerCommand("outer", {
					handler: async (_args, ctx) => {
						// A nested command gets its own tracker and settles before the
						// outer handler continues.
						await harness.session.prompt("/inner");
						void ctx;
					},
				});
			},
		],
	});

	try {
		harness.setResponses([() => fauxAssistantMessage("inner done")]);

		await harness.session.prompt("/outer");

		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	} finally {
		harness.cleanup();
	}
});
