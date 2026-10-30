import { describe, expect, it } from "vitest";
import { parseJsonEvent, type StepSubagentDetails, type StepSubagentRunResult } from "../src/features/step-subagent.ts";
import { renderSubagentResult } from "../src/features/subagent/rendering.ts";
import type { Theme } from "../src/theme/theme.ts";

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

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

describe("subagent TUI result while the child reasons", () => {
	it("does not print the child's reasoning as its output preview", () => {
		const details: StepSubagentDetails = {
			mode: "single",
			agentScope: "user",
			userAgentsDir: "/agents",
			projectAgentsDir: null,
			results: [
				{
					...emptyResult(),
					agent: "explore",
					agentSource: "user",
					task: "map the docs",
					status: "running",
					activeThinking: "secret chain of thought",
				},
			],
		};
		for (const expanded of [false, true]) {
			const text = renderSubagentResult({ content: [], details }, { expanded, isPartial: true }, plainTheme)
				.render(120)
				.join("\n");
			expect(text).not.toContain("secret chain of thought");
		}
	});
});
