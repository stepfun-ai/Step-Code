import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { registerFauxProvider, streamSimple } from "@step-harness/providers/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentEvent, AgentTool, AgentToolResult, ToolExecutionMode } from "../src/types.ts";

const providers: ReturnType<typeof registerFauxProvider>[] = [];
afterEach(() => {
	while (providers.length) providers.pop()?.unregister();
});

function setup(toolExecution: ToolExecutionMode, tools: AgentTool[]) {
	const provider = registerFauxProvider();
	providers.push(provider);
	const agent = new Agent({
		streamFn: streamSimple,
		getApiKey: () => "test-key",
		initialState: { model: provider.getModel(), tools },
		toolExecution,
	});
	const events: AgentEvent[] = [];
	agent.subscribe((event) => {
		events.push(event);
	});
	return { provider, agent, events };
}

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({ count: Type.Number() }),
		execute: async () => {
			if (name === "broken") throw new Error("execution failed");
			return { content: [{ type: "text", text: "original" }], details: { kept: true } };
		},
	};
}

describe.each<ToolExecutionMode>(["sequential", "parallel"])("final tool result transform (%s)", (mode) => {
	it("transforms executed, invalid, missing and denied results before publication", async () => {
		const { provider, agent, events } = setup(mode, [tool("ok"), tool("invalid"), tool("denied"), tool("broken")]);
		const after = vi.fn(async () => ({ content: [{ type: "text" as const, text: "after hook" }] }));
		agent.beforeToolCall = async ({ toolCall }) =>
			toolCall.name === "denied" ? { block: true, reason: "denied", terminate: true } : undefined;
		agent.afterToolCall = after;
		const transform = vi.fn(async (content: AgentToolResult<unknown>["content"]) => [
			{ type: "text" as const, text: `final:${JSON.stringify(content)}` },
		]);
		agent.transformToolResult = transform;
		provider.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("ok", { count: 1 }),
					fauxToolCall("invalid", { count: "bad" }),
					fauxToolCall("missing", {}),
					fauxToolCall("denied", { count: 1 }),
					fauxToolCall("broken", { count: 1 }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await agent.prompt("run tools");
		expect(transform).toHaveBeenCalledTimes(5);
		expect(after).toHaveBeenCalledTimes(2);
		const ended = events.filter((event) => event.type === "tool_execution_end");
		expect(ended).toHaveLength(5);
		for (const event of ended)
			expect(event.result.content[0]).toMatchObject({ text: expect.stringMatching(/^final:/) });
		const results = agent.state.messages.filter((message) => message.role === "toolResult");
		expect(results.map((message) => message.isError)).toEqual([false, true, true, true, true]);
		for (const message of results)
			expect(message.content[0]).toMatchObject({ text: expect.stringMatching(/^final:/) });
	});

	it("keeps a denied batch terminating and leaves the execution hook untouched", async () => {
		const blocked = tool("denied");
		const execute = vi.spyOn(blocked, "execute");
		const { provider, agent } = setup(mode, [blocked]);
		agent.beforeToolCall = async () => ({ block: true, reason: "policy says no", terminate: true });
		const after = vi.fn();
		agent.afterToolCall = after;
		agent.transformToolResult = async () => [{ type: "text", text: "bounded denial" }];
		provider.setResponses([fauxAssistantMessage(fauxToolCall("denied", { count: 1 }), { stopReason: "toolUse" })]);
		await agent.prompt("denied");
		expect(execute).not.toHaveBeenCalled();
		expect(after).not.toHaveBeenCalled();
		expect(agent.state.messages.at(-1)).toMatchObject({
			role: "toolResult",
			isError: true,
			content: [{ type: "text", text: "bounded denial" }],
		});
	});

	it("reports transform failure without dropping the termination hint", async () => {
		const done: AgentTool = {
			...tool("done"),
			execute: async () => ({
				content: [{ type: "text", text: "completed" }],
				details: { kept: true },
				terminate: true,
			}),
		};
		const { provider, agent } = setup(mode, [done]);
		agent.transformToolResult = async () => {
			throw new Error("cannot retain output");
		};
		provider.setResponses([fauxAssistantMessage(fauxToolCall("done", { count: 1 }), { stopReason: "toolUse" })]);
		await agent.prompt("run");
		expect(agent.state.messages.at(-1)).toMatchObject({
			role: "toolResult",
			isError: true,
			details: { kept: true },
			content: [{ type: "text", text: expect.stringContaining("cannot retain output") }],
		});
	});
});

it("transforms tools rejected for a truncated assistant message", async () => {
	const { provider, agent } = setup("parallel", [tool("ok")]);
	agent.transformToolResult = async () => [{ type: "text", text: "bounded length rejection" }];
	provider.setResponses([
		fauxAssistantMessage(fauxToolCall("ok", { count: 1 }), { stopReason: "length" }),
		fauxAssistantMessage("done"),
	]);
	await agent.prompt("run");
	expect(agent.state.messages.find((message) => message.role === "toolResult")).toMatchObject({
		content: [{ type: "text", text: "bounded length rejection" }],
		isError: true,
	});
});

it("honors the constructor transform while preserving usage and newly discovered tool names", async () => {
	const provider = registerFauxProvider();
	providers.push(provider);
	const usage = {
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 3,
		cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
	};
	const discover: AgentTool = {
		...tool("discover"),
		execute: async () => ({
			content: [{ type: "text", text: "large source" }],
			details: { kept: true },
			usage,
			addedToolNames: ["new_tool"],
			terminate: true,
		}),
	};
	const agent = new Agent({
		streamFn: streamSimple,
		getApiKey: () => "test-key",
		initialState: { model: provider.getModel(), tools: [discover] },
		transformToolResult: async () => [{ type: "text", text: "retained preview" }],
	});
	provider.setResponses([fauxAssistantMessage(fauxToolCall("discover", { count: 1 }), { stopReason: "toolUse" })]);
	await agent.prompt("discover");
	expect(agent.state.messages.at(-1)).toMatchObject({
		role: "toolResult",
		content: [{ type: "text", text: "retained preview" }],
		details: { kept: true },
		usage,
		addedToolNames: ["new_tool"],
		isError: false,
	});
});

it("keeps image blocks when final text processing fails", async () => {
	const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
	const capture: AgentTool = {
		...tool("capture"),
		execute: async () => ({
			content: [image, { type: "text", text: "x".repeat(60000) }],
			details: {},
			terminate: true,
		}),
	};
	const { agent, provider } = setup("parallel", [capture]);
	agent.transformToolResult = async () => {
		throw new Error("storage unavailable");
	};
	provider.setResponses([fauxAssistantMessage(fauxToolCall("capture", { count: 1 }), { stopReason: "toolUse" })]);
	await agent.prompt("capture");
	const result = agent.state.messages.at(-1);
	expect(result?.role).toBe("toolResult");
	if (result?.role !== "toolResult") throw new Error("Expected tool result");
	expect(result.isError).toBe(true);
	expect(result.content.filter((part) => part.type === "image")).toEqual([image]);
});
