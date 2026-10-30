import { describe, expect, it } from "vitest";
import { parseJsonEvent, type StepSubagentRunResult } from "../src/features/step-subagent.ts";

function emptyResult(): StepSubagentRunResult {
	return {
		messages: [],
		stderr: "",
		exitCode: -1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
}

function update(type: string, delta: string): string {
	return JSON.stringify({ type: "message_update", assistantMessageEvent: { type, contentIndex: 0, delta } });
}

describe("subagent live stream projection", () => {
	it("keeps reasoning and tool-call arguments out of the live reply text", () => {
		const current = emptyResult();
		parseJsonEvent(JSON.stringify({ type: "message_start" }), current, undefined);
		parseJsonEvent(update("thinking_delta", "Let me check "), current, undefined);
		parseJsonEvent(update("thinking_delta", "the docs."), current, undefined);
		expect(current.activeThinking).toBe("Let me check the docs.");
		expect(current.activeText).toBe("");

		parseJsonEvent(update("text_delta", "Found it."), current, undefined);
		parseJsonEvent(
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, toolName: "read" },
			}),
			current,
			undefined,
		);
		parseJsonEvent(update("toolcall_delta", '{"path":"a.md"}'), current, undefined);
		expect(current.activeText).toBe("Found it.");
		expect(current.activeToolArgs).toBe('{"path":"a.md"}');
	});

	it("clears the live reasoning when the message ends and resets it on the next message", () => {
		const current = emptyResult();
		parseJsonEvent(JSON.stringify({ type: "message_start" }), current, undefined);
		parseJsonEvent(update("thinking_delta", "planning"), current, undefined);
		parseJsonEvent(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "planning" },
						{ type: "text", text: "Done." },
					],
					api: "openai-completions",
					provider: "faux",
					model: "faux-model",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				},
			}),
			current,
			undefined,
		);
		expect(current.activeThinking).toBeUndefined();
		expect(current.activeText).toBe("Done.");

		parseJsonEvent(update("thinking_delta", "stale"), current, undefined);
		parseJsonEvent(JSON.stringify({ type: "message_start" }), current, undefined);
		expect(current.activeThinking).toBeUndefined();
	});
});
