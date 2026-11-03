import { fauxAssistantMessage } from "@step-harness/providers";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createStepWorkflowExtension } from "../../src/features/workflow/step-workflow.ts";
import {
	createUltraloopOptInExtension,
	type UltraloopTurnState,
} from "../../src/features/workflow/ultraloop-opt-in.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const workflowCapabilities: ExtensionFactory = (api) => {
	const turnState: UltraloopTurnState = {};
	createStepWorkflowExtension({ turnState })(api);
	createUltraloopOptInExtension({ turnState })(api);
};

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function latestModeNotice(harness: Harness): string {
	const message = harness.session.messages
		.filter((entry) => entry.role === "custom" && entry.customType === "ultraloop-opt-in")
		.at(-1);
	return message?.role === "custom" && typeof message.content === "string" ? message.content : "";
}

describe("Ultracode entry through a real session", () => {
	it("only adds mode transitions, after real user input, at the provider boundary", async () => {
		const harness = await createHarness({ tools: [], extensionFactories: [workflowCapabilities] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		expect(harness.session.getActiveToolNames()).toContain("workflow");
		const requests: Array<Array<{ role: string; text: string }>> = [];
		harness.setResponses(
			Array.from({ length: 7 }, () => (context) => {
				requests.push(context.messages.map((message) => ({ role: message.role, text: getMessageText(message) })));
				return fauxAssistantMessage("OK");
			}),
		);

		await harness.session.prompt("/ultracode help");
		expect(harness.getPendingResponseCount()).toBe(7);
		expect(harness.session.messages).toEqual([]);
		await harness.session.prompt("Explain the available modes");
		await harness.session.prompt("Explain another function");
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(false);

		await harness.session.prompt("/ultracode on");
		expect(harness.getPendingResponseCount()).toBe(5);
		await harness.session.prompt("Review the project");
		expect(latestModeNotice(harness)).toContain("Ultraloop is on for the session");
		await harness.session.prompt("Review the tests");

		await harness.session.prompt("/ultraloop off");
		expect(harness.getPendingResponseCount()).toBe(3);
		await harness.session.prompt("Explain one small function");
		expect(latestModeNotice(harness)).toContain("session mode is off");
		await harness.session.prompt("Explain another small function");
		await harness.session.prompt("/ultracode on");
		await harness.session.prompt("Review once more");
		const isNotice = (text: string) => text.startsWith("<system-reminder>");
		expect(requests.map((messages) => messages.filter((message) => isNotice(message.text)).length)).toEqual([
			0, 0, 1, 1, 2, 2, 3,
		]);
		for (const index of [2, 4, 6]) {
			const messages = requests[index]!;
			expect(messages.at(-2)?.role).toBe("user");
			expect(isNotice(messages.at(-2)!.text)).toBe(false);
			expect(messages.at(-1)?.role).toBe("user");
			expect(isNotice(messages.at(-1)!.text)).toBe(true);
		}
		const notices = harness.session.messages.filter((message) => message.role === "custom");
		expect(notices).toHaveLength(3);
		expect(notices.every((message) => message.role === "custom" && message.display === false)).toBe(true);
		expect(requests.flat().some((message) => message.text.includes("Ultracode and Ultraloop are names"))).toBe(false);
		expect(harness.eventsOfType("tool_execution_start")).toEqual([]);
	});

	it.each(["session", "turn"])("explains unavailable workflow for a restricted profile (%s opt-in)", async (scope) => {
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
		if (scope === "session") await harness.session.prompt("/ultracode on");
		await harness.session.prompt(scope === "session" ? "Explain the available modes" : "ultracode: review this task");

		expect(harness.session.getActiveToolNames()).toEqual(["find_tools"]);
		expect(harness.session.getAllTools().some((tool) => tool.name === "workflow")).toBe(false);
		expect(latestModeNotice(harness)).toContain("not active");
		expect(latestModeNotice(harness)).toContain("tool profile");
		expect(latestModeNotice(harness)).not.toContain("To load the workflow tool");
		expect(latestModeNotice(harness)).toContain("instead of attempting to call it");
		if (scope === "turn")
			expect(latestModeNotice(harness)).not.toContain("use the workflow tool to fulfill the request");
		expect(harness.eventsOfType("tool_execution_start")).toEqual([]);
	});

	it("keeps standing consent independent of changes to the active tool profile", async () => {
		const harness = await createHarness({ tools: [], extensionFactories: [workflowCapabilities] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const requests: Array<{ tools: string[]; notices: string[] }> = [];
		harness.setResponses(
			Array.from({ length: 3 }, () => (context) => {
				requests.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					notices: context.messages.map(getMessageText).filter((text) => text.startsWith("<system-reminder>")),
				});
				return fauxAssistantMessage("OK");
			}),
		);
		harness.session.setActiveToolsByName([]);
		await harness.session.prompt("/ultracode on");
		await harness.session.prompt("First task");
		harness.session.setActiveToolsByName(["workflow"]);
		await harness.session.prompt("Second task");
		harness.session.setActiveToolsByName([]);
		await harness.session.prompt("Third task");
		expect(requests.map((request) => request.tools.includes("workflow"))).toEqual([false, true, false]);
		expect(requests.map((request) => request.notices.length)).toEqual([1, 1, 1]);
		expect(requests[0]!.notices[0]).toContain("If the workflow tool is not active");
		expect(requests[1]!.notices).toEqual(requests[0]!.notices);
		expect(requests[2]!.notices).toEqual(requests[0]!.notices);
	});

	it("keeps the normal system-prompt refresh when active tools change", async () => {
		const harness = await createHarness({ tools: [], extensionFactories: [workflowCapabilities] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		expect(harness.session.systemPrompt).toContain("- workflow:");
		harness.setResponses([fauxAssistantMessage("available")]);
		await harness.session.prompt("Explain the available modes");
		expect(latestModeNotice(harness)).toBe("");
		harness.session.setActiveToolsByName([]);
		expect(harness.session.getActiveToolNames()).toEqual([]);
		expect(harness.session.systemPrompt).not.toContain("- workflow:");
	});

	it("keeps per-turn authorization scoped to the user prompt", async () => {
		const harness = await createHarness({ tools: [], extensionFactories: [workflowCapabilities] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("OK"), fauxAssistantMessage("OK"), fauxAssistantMessage("OK")]);
		await harness.session.prompt("ultracode: review this task");
		expect(latestModeNotice(harness)).toContain("use the workflow tool to fulfill the request");
		expect(latestModeNotice(harness)).not.toContain("The workflow tool is not active");
		const firstCount = harness.session.messages.length;
		await harness.session.prompt("Explain one function");
		expect(harness.session.messages.slice(firstCount).some((message) => message.role === "custom")).toBe(false);
		await harness.session.prompt("ultracode: review a different task");
		const notices = harness.session.messages.filter((message) => message.role === "custom");
		expect(notices).toHaveLength(2);
		expect(
			notices.every(
				(message) => message.role === "custom" && (message.details as { source: string }).source === "turn",
			),
		).toBe(true);
	});

	it("re-announces standing consent when compaction removes the previous notice", async () => {
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				workflowCapabilities,
				(api) => {
					api.on("session_before_compact", (event) => ({
						compaction: {
							summary: "The previous tasks were discussed.",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage("First answer"),
			fauxAssistantMessage("Second answer"),
			fauxAssistantMessage("After compaction"),
		]);
		await harness.session.prompt("/ultracode on");
		await harness.session.prompt("First question");
		await harness.session.prompt("Second question");
		await harness.session.compact();
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "ultraloop-opt-in",
			),
		).toBe(false);
		await harness.session.prompt("Continue after compaction");
		expect(latestModeNotice(harness)).toContain("Ultraloop is on for the session");
		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "ultraloop-opt-in",
			),
		).toHaveLength(1);
	});

	it("revokes mode during streaming before the next provider call", async () => {
		const harness = await createHarness({ tools: [], extensionFactories: [workflowCapabilities] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const requests: string[][] = [];
		harness.setResponses([
			async (context) => {
				requests.push(context.messages.map(getMessageText));
				entered();
				await gate;
				return fauxAssistantMessage("First answer");
			},
			(context) => {
				requests.push(context.messages.map(getMessageText));
				return fauxAssistantMessage("Steering answer");
			},
			(context) => {
				requests.push(context.messages.map(getMessageText));
				return fauxAssistantMessage("Next answer");
			},
		]);
		await harness.session.prompt("/ultracode on");
		const running = harness.session.prompt("First question");
		try {
			await started;
			await harness.session.prompt("/ultracode off");
			await harness.session.prompt("Additional input", { streamingBehavior: "steer" });
			release();
			await running;
			expect(requests[1]!.at(-2)).toBe("Additional input");
			expect(requests[1]!.at(-1)).toContain("session mode is off");
			await harness.session.prompt("Next question");
			expect(
				requests.map((messages) => messages.filter((text) => text.startsWith("<system-reminder>")).length),
			).toEqual([1, 2, 2]);
		} finally {
			release();
			await harness.session.abort();
			await running;
		}
	});
});
