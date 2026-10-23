import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { createStepPlanExtension } from "../../../src/features/step-plan.ts";
import { createHarness } from "../harness.ts";

/**
 * Plan mode is a permission narrowing, not a capability change. The provider
 * serializes `tools` ahead of the system prompt and messages, so rewriting the
 * tool block invalidates the cached prefix for the entire conversation.
 *
 * A real Step profile already offers every plan tool; entering plan mode used to
 * reorder that same set and re-bill the whole prompt. Measured on a live session,
 * one entry at ~230k prompt tokens read back only 1.6k.
 */

const PLAN_TOOLS = [
	"read_file",
	"find_files",
	"search_files",
	"list_directory",
	"run_command",
	"clarify_user",
	"write_file",
	"edit_file",
] as const;

function stepTool(name: string) {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: name }], details: {} }),
	};
}

interface CapturedRequest {
	tools: string[];
	systemPrompt: string;
}

it("keeps the request tool block and system prompt byte-identical across a plan-mode entry", async () => {
	const harness = await createHarness({
		tools: [...PLAN_TOOLS, "find_tools"].map(stepTool),
		extensionFactories: [{ name: "step-plan", factory: createStepPlanExtension(), hidden: true }],
	});

	try {
		// This is the shape of an ordinary Step profile: every plan tool is already
		// available, so plan mode has nothing to add.
		harness.session.setActiveToolsByName([...PLAN_TOOLS, "find_tools", "enter_plan_mode", "exit_plan_mode"]);

		const captured: CapturedRequest[] = [];
		harness.setResponses([
			(context) => {
				captured.push({
					tools: (context.tools ?? []).map((tool) => tool.name),
					systemPrompt: context.systemPrompt ?? "",
				});
				return fauxAssistantMessage(fauxToolCall("enter_plan_mode", {}), { stopReason: "toolUse" });
			},
			(context) => {
				captured.push({
					tools: (context.tools ?? []).map((tool) => tool.name),
					systemPrompt: context.systemPrompt ?? "",
				});
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("Propose an approach.");

		expect(captured).toHaveLength(2);
		// Same tools, same order, same prompt: the cached prefix survives.
		expect(captured[1]?.tools).toEqual(captured[0]?.tools);
		expect(captured[1]?.systemPrompt).toBe(captured[0]?.systemPrompt);
		expect(harness.getPendingResponseCount()).toBe(0);
	} finally {
		harness.cleanup();
	}
});

it("still blocks non-plan mutations after entering plan mode with tools intact", async () => {
	const harness = await createHarness({
		tools: [...PLAN_TOOLS, "find_tools"].map(stepTool),
		extensionFactories: [{ name: "step-plan", factory: createStepPlanExtension(), hidden: true }],
	});

	try {
		harness.session.setActiveToolsByName([...PLAN_TOOLS, "find_tools", "enter_plan_mode", "exit_plan_mode"]);
		const toolsBefore = harness.session.agent.state.tools.map((tool) => tool.name);

		harness.setResponses([
			() => fauxAssistantMessage(fauxToolCall("enter_plan_mode", {}), { stopReason: "toolUse" }),
			// The editing tool is still visible; the policy must reject the target.
			() =>
				fauxAssistantMessage(fauxToolCall("write_file", { path: "src/app.ts", content: "x" }), {
					stopReason: "toolUse",
				}),
			() => fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("Propose an approach.");

		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		const blocked = results.find((message) => message.toolName === "write_file");
		expect(blocked).toBeDefined();
		expect(blocked?.isError).toBe(true);
		expect(JSON.stringify(blocked?.content)).toContain("Only the plan file may be written");
		// Nothing was removed: the guard, not the tool list, enforces plan mode.
		expect(harness.session.agent.state.tools.map((tool) => tool.name)).toEqual(toolsBefore);
	} finally {
		harness.cleanup();
	}
});
