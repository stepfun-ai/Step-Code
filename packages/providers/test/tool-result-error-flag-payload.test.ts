import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Context, ToolResultMessage, Usage } from "../src/types.ts";
import { responsesModel } from "./helpers/step-fixtures.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The text a failed command produces: its output plus the declared outcome. */
const FAILED_TEXT = "tests failed\n  ✗ renders markdown\n\nCommand exited with code 1";

function context(isError: boolean): Context {
	const now = Date.now();
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "run_command", arguments: { command: "pnpm test" } }],
		api: "openai-responses",
		provider: "modelproxy",
		model: "deepseek-v4.1-flash-api",
		usage,
		stopReason: "toolUse",
		timestamp: now,
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "run_command",
		content: [{ type: "text", text: FAILED_TEXT }],
		isError,
		timestamp: now + 1,
	};
	return { messages: [{ role: "user", content: "run the tests", timestamp: now - 1 }, assistant, result] };
}

/**
 * The request the model receives must not depend on how a result was classified
 * internally. A command's outcome reaches the model through its text; the
 * invocation-failure flag is a local fact and must not leak into the payload of
 * a dialect that has no field for it.
 */
describe("a tool result's request payload", () => {
	it("is identical on openai-responses whether isError is true or false", () => {
		const model = responsesModel();
		const asError = JSON.stringify(
			convertResponsesMessages(model, context(true), new Set(["openai", "openai-codex", "opencode"])),
		);
		const asResult = JSON.stringify(
			convertResponsesMessages(model, context(false), new Set(["openai", "openai-codex", "opencode"])),
		);
		expect(asResult).toBe(asError);
		// The outcome still reaches the model, so it keeps the signal it had.
		expect(asResult).toContain("Command exited with code 1");
	});
});
