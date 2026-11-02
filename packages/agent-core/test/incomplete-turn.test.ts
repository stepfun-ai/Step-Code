import type { AssistantMessage, Usage } from "@step-harness/providers";
import { describe, expect, it } from "vitest";
import { classifyIncompleteAssistantTurn, isIncompleteAssistantTurn } from "../src/incomplete-turn.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage,
		stopReason,
		timestamp: 1,
	};
}

describe("isIncompleteAssistantTurn", () => {
	it.each([
		["an empty stop", [], "stop", "no_visible_output"],
		["thinking-only stop", [{ type: "thinking" as const, thinking: "reasoning" }], "stop", "no_visible_output"],
		["whitespace-only text", [{ type: "text" as const, text: " \n\t" }], "stop", "no_visible_output"],
		["a tool-use stop without a tool call", [], "toolUse", "missing_tool_call"],
		[
			"a tool-use stop with visible text but no tool call",
			[{ type: "text" as const, text: "I will inspect it." }],
			"toolUse",
			"missing_tool_call",
		],
	] as const)("classifies %s as incomplete", (_label, content, stopReason, reason) => {
		expect(classifyIncompleteAssistantTurn(assistant([...content], stopReason))).toBe(reason);
		expect(isIncompleteAssistantTurn(assistant([...content], stopReason))).toBe(true);
	});

	it.each([
		["visible text", [{ type: "text" as const, text: "answer" }], "stop"],
		["a structured tool call", [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: {} }], "toolUse"],
		["a length stop", [{ type: "thinking" as const, thinking: "reasoning" }], "length"],
		["an error stop", [], "error"],
		["an aborted stop", [], "aborted"],
	] as const)("does not classify %s as incomplete", (_label, content, stopReason) => {
		expect(isIncompleteAssistantTurn(assistant([...content], stopReason))).toBe(false);
	});
});
