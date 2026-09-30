import { fauxAssistantMessage } from "@step-harness/providers";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createStepWorkflowExtension } from "../../src/features/workflow/step-workflow.ts";
import {
	createUltraloopOptInExtension,
	type UltraloopTurnState,
} from "../../src/features/workflow/ultraloop-opt-in.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const workflowCapabilities: ExtensionFactory = (api) => {
	const turnState: UltraloopTurnState = {};
	createStepWorkflowExtension({ turnState })(api);
	createUltraloopOptInExtension({ turnState })(api);
};

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function latestDiscovery(harness: Harness): string {
	const message = harness.session.messages
		.filter((entry) => entry.role === "custom" && entry.customType === "ultraloop-discovery")
		.at(-1);
	return message?.role === "custom" && typeof message.content === "string" ? message.content : "";
}

describe("Ultracode entry through a real session", () => {
	it("shares command state without model calls and explicitly clears prior standing consent", async () => {
		const harness = await createHarness({ tools: [], extensionFactories: [workflowCapabilities] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		expect(harness.session.getActiveToolNames()).toContain("workflow");
		harness.setResponses([
			fauxAssistantMessage("available"),
			fauxAssistantMessage("enabled"),
			fauxAssistantMessage("off"),
		]);

		await harness.session.prompt("/ultracode help");
		expect(harness.getPendingResponseCount()).toBe(3);
		expect(harness.session.messages).toEqual([]);
		await harness.session.prompt("Explain the available modes");
		expect(latestDiscovery(harness)).toContain("/ultracode on");
		expect(latestDiscovery(harness)).toContain("Current session mode: off");

		await harness.session.prompt("/ultracode on");
		expect(harness.getPendingResponseCount()).toBe(2);
		await harness.session.prompt("Review the project");
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "ultraloop-opt-in",
			),
		).toBe(true);

		await harness.session.prompt("/ultraloop off");
		expect(harness.getPendingResponseCount()).toBe(1);
		const beforeOffTurn = harness.session.messages.length;
		await harness.session.prompt("Explain one small function");
		const freshNotices = harness.session.messages
			.slice(beforeOffTurn)
			.filter((message) => message.role === "custom" && message.customType === "ultraloop-discovery");
		expect(freshNotices).toEqual([
			expect.objectContaining({ content: expect.stringContaining("Current session mode: off") }),
		]);
		expect(harness.eventsOfType("tool_execution_start")).toEqual([]);
	});

	it("does not tell a restricted profile that tool search activates workflow", async () => {
		const harness = await createHarness({
			tools: [
				{
					name: "find_tools",
					label: "find_tools",
					description: "Inspect the tool catalog without changing active tools",
					parameters: Type.Object({ query: Type.String() }),
					execute: async () => ({ content: [{ type: "text", text: "No matching tools" }], details: undefined }),
				},
			],
			allowedToolNames: ["find_tools"],
			extensionFactories: [workflowCapabilities],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("Tool access is limited")]);
		await harness.session.prompt("Explain the available modes");

		expect(harness.session.getActiveToolNames()).toEqual(["find_tools"]);
		expect(harness.session.getAllTools().some((tool) => tool.name === "workflow")).toBe(false);
		expect(latestDiscovery(harness)).toContain("not active");
		expect(latestDiscovery(harness)).toContain("tool profile");
		expect(latestDiscovery(harness)).not.toContain("To load the workflow tool");
		expect(harness.eventsOfType("tool_execution_start")).toEqual([]);
	});

	it("keeps the normal system-prompt refresh when active tools change", async () => {
		const harness = await createHarness({ tools: [], extensionFactories: [workflowCapabilities] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		expect(harness.session.systemPrompt).toContain("- workflow:");
		harness.setResponses([fauxAssistantMessage("available")]);
		await harness.session.prompt("Explain the available modes");
		expect(latestDiscovery(harness)).toContain("Ultracode");
		harness.session.setActiveToolsByName([]);
		expect(harness.session.getActiveToolNames()).toEqual([]);
		expect(harness.session.systemPrompt).not.toContain("- workflow:");
	});
});
