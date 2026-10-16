import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createHarness } from "../harness.ts";

it("removes unavailable schemas and prompt guidance before the next model request", async () => {
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "disable_remote",
					label: "Disable remote lookup",
					description: "Mark the remote lookup unavailable",
					promptSnippet: "Disable the remote lookup",
					parameters: Type.Object({}),
					execute: async () => {
						pi.setUnavailableTools(["remote_lookup"]);
						return { content: [{ type: "text", text: "disabled" }], details: {} };
					},
				});
				pi.registerTool({
					name: "remote_lookup",
					label: "Remote lookup",
					description: "Look up remote data",
					promptSnippet: "Look up remote data",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "data" }], details: {} }),
				});
			},
		],
	});

	try {
		harness.session.setActiveToolsByName(["disable_remote", "remote_lookup"]);
		const schemas: string[][] = [];
		const prompts: string[] = [];
		harness.setResponses([
			(context) => {
				schemas.push((context.tools ?? []).map((tool) => tool.name).sort());
				prompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage(fauxToolCall("disable_remote", {}), { stopReason: "toolUse" });
			},
			(context) => {
				schemas.push((context.tools ?? []).map((tool) => tool.name).sort());
				prompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("Disable remote access and finish.");
		expect(schemas).toEqual([["disable_remote", "remote_lookup"], ["disable_remote"]]);
		expect(prompts[0]).toContain("remote_lookup:");
		expect(prompts[1]).not.toContain("remote_lookup:");
		expect(harness.getPendingResponseCount()).toBe(0);
	} finally {
		harness.cleanup();
	}
});
