import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { Type } from "typebox";
import { beforeAll, expect, it } from "vitest";
import { getPlanFilePath } from "../../../src/features/plan-mode-tools.ts";
import { createStepPlanExtension } from "../../../src/features/step-plan.ts";
import { initTheme } from "../../../src/theme/theme.ts";
import { createHarness } from "../harness.ts";

/**
 * Plan mode is a permission narrowing, not a capability change. The provider
 * serializes `tools` ahead of the system prompt and messages, so rewriting the
 * tool block invalidates the cached prefix for the entire conversation.
 *
 * A real Step profile already offers every plan tool; entering plan mode used to
 * reorder that same set and re-bill the whole prompt. Measured on a live session,
 * one entry at a ~230k-token prompt read back only 1.6k tokens.
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

function stepTool(name: string, execute?: (args: Record<string, unknown>) => void) {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({ path: Type.Optional(Type.String()), content: Type.Optional(Type.String()) }),
		execute: async (_toolCallId: string, params: unknown) => {
			execute?.((params ?? {}) as Record<string, unknown>);
			return { content: [{ type: "text" as const, text: name }], details: {} };
		},
	};
}

// The plan extension paints its status line through the active theme.
beforeAll(() => initTheme("dark"));

interface CapturedRequest {
	tools: string[];
	systemPrompt: string;
}

it("keeps the request tool block and system prompt byte-identical across a plan-mode cycle", async () => {
	// Filled in once the harness owns its workspace; the tool only runs later.
	let workspace = "";
	const harness = await createHarness({
		tools: [...PLAN_TOOLS, "find_tools"].map((name) =>
			stepTool(name, (args) => {
				if (name !== "write_file" || typeof args.path !== "string") return;
				const target = path.resolve(workspace, args.path);
				mkdirSync(path.dirname(target), { recursive: true });
				writeFileSync(target, typeof args.content === "string" ? args.content : "");
			}),
		),
		extensionFactories: [{ name: "step-plan", factory: createStepPlanExtension(), hidden: true }],
	});
	workspace = harness.tempDir;

	try {
		// The shape of an ordinary Step profile: every plan tool is already active,
		// so plan mode has nothing to add.
		harness.session.setActiveToolsByName([...PLAN_TOOLS, "find_tools", "enter_plan_mode", "exit_plan_mode"]);
		const planPath = getPlanFilePath(harness.sessionManager.getSessionId(), harness.tempDir);

		const captured: CapturedRequest[] = [];
		const capture = (context: { tools?: Array<{ name: string }>; systemPrompt?: string }) => {
			captured.push({
				tools: (context.tools ?? []).map((tool) => tool.name),
				systemPrompt: context.systemPrompt ?? "",
			});
		};
		harness.setResponses([
			(context) => {
				capture(context);
				return fauxAssistantMessage(fauxToolCall("enter_plan_mode", {}), { stopReason: "toolUse" });
			},
			(context) => {
				capture(context);
				return fauxAssistantMessage(
					fauxToolCall("write_file", {
						path: path.relative(workspace, planPath),
						content: "# Plan\n\n1. Do it.\n",
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				capture(context);
				return fauxAssistantMessage(fauxToolCall("exit_plan_mode", {}), { stopReason: "toolUse" });
			},
			(context) => {
				capture(context);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("Propose an approach.");

		// The system prompt embeds the active tool snippets, so equal tools plus an
		// equal prompt is exactly the prefix the provider caches.
		expect(captured).toHaveLength(4);
		for (const request of captured.slice(1)) {
			expect(request.tools).toEqual(captured[0]?.tools);
			expect(request.systemPrompt).toBe(captured[0]?.systemPrompt);
		}
		expect(harness.getPendingResponseCount()).toBe(0);
	} finally {
		harness.cleanup();
	}
});

it("still blocks non-plan mutations after entering plan mode with tools intact", async () => {
	const harness = await createHarness({
		tools: [...PLAN_TOOLS, "find_tools"].map((name) => stepTool(name)),
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
		expect(blocked?.isError).toBe(true);
		expect(JSON.stringify(blocked?.content)).toContain("Plan mode is active");
		// Nothing was removed: the guard, not the tool list, enforces plan mode.
		expect(harness.session.agent.state.tools.map((tool) => tool.name)).toEqual(toolsBefore);
	} finally {
		harness.cleanup();
	}
});
