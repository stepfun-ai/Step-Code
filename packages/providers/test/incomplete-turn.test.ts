import { describe, expect, it } from "vitest";
import type { AssistantMessage, Usage } from "../src/types.ts";
import {
	assistantTerminalFailure,
	classifyIncompleteAssistantTurn,
	INCOMPLETE_TURN_MESSAGES,
	isIncompleteAssistantTurn,
} from "../src/utils/incomplete-turn.ts";

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

	it("tolerates a text block whose text is missing", () => {
		const malformed = assistant([{ type: "text" } as never], "stop");
		expect(classifyIncompleteAssistantTurn(malformed)).toBe("no_visible_output");
	});

	it("tolerates a null entry inside an otherwise valid content array", () => {
		const malformed = {
			...assistant([], "stop"),
			content: [null, { type: "text", text: " " }],
		} as unknown as AssistantMessage;
		expect(classifyIncompleteAssistantTurn(malformed)).toBe("no_visible_output");
	});

	it.each([
		["a plain string", "answer"],
		["null", null],
		["undefined", undefined],
		["an object", { type: "text", text: "answer" }],
	])("tolerates content that is %s", (_label, content) => {
		// Session files are read without validation, so this runs on real input.
		const malformed = { ...assistant([], "stop"), content } as unknown as AssistantMessage;
		expect(() => classifyIncompleteAssistantTurn(malformed)).not.toThrow();
		expect(classifyIncompleteAssistantTurn(malformed)).toBe("no_visible_output");
	});
});

describe("assistantTerminalFailure", () => {
	it("reports provider errors and cancellations from the stop reason", () => {
		expect(assistantTerminalFailure(assistant([], "error"))).toEqual({
			kind: "error",
			message: "The model request failed.",
		});
		const aborted = { ...assistant([], "aborted"), errorMessage: "Operation aborted" };
		expect(assistantTerminalFailure(aborted)).toEqual({ kind: "aborted", message: "Operation aborted" });
	});

	it("reports an incomplete turn without rewriting its stop reason", () => {
		const message = assistant([{ type: "thinking" as const, thinking: "reasoning" }], "stop");
		expect(assistantTerminalFailure(message)).toEqual({
			kind: "incomplete",
			message: INCOMPLETE_TURN_MESSAGES.no_visible_output,
			incompleteReason: "no_visible_output",
		});
		expect(message.stopReason).toBe("stop");
	});

	it("reports nothing for a completed turn", () => {
		expect(assistantTerminalFailure(assistant([{ type: "text" as const, text: "done" }], "stop"))).toBeUndefined();
	});
});
