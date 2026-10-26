import type { AgentTool } from "@step-harness/agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * MCP hot reload registers a newly installed server's tools from the awaited
 * `before_agent_start` and `turn_end` hooks. These tests pin the session
 * contract it relies on: tools registered there reach the very next request.
 */
describe("tools registered while a session runs", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const echoTool: AgentTool = {
		name: "echo",
		label: "Echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
	};

	const lateTool: ToolDefinition = {
		name: "late_tool",
		label: "Late tool",
		description: "Registered after the session started",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "late" }], details: {} }),
	};

	const toolNames = (context: Context) => (context.tools ?? []).map((tool) => tool.name);

	it("a tool registered in before_agent_start reaches the prompt's first request", async () => {
		const seen: string[][] = [];
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						pi.registerTools([lateTool]);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				seen.push(toolNames(context));
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("hi");

		expect(seen).toEqual([expect.arrayContaining(["echo", "late_tool"])]);
	});

	it("a tool registered in turn_end reaches the next request of the same prompt", async () => {
		const seen: string[][] = [];
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", async (event) => {
						if (event.toolResults.length > 0) pi.registerTools([lateTool]);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				seen.push(toolNames(context));
				return fauxAssistantMessage([fauxToolCall("echo", { text: "install" })], { stopReason: "toolUse" });
			},
			(context) => {
				seen.push(toolNames(context));
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("install a server and use it");

		expect(seen[0]).not.toContain("late_tool");
		expect(seen[1]).toContain("late_tool");
	});
});
