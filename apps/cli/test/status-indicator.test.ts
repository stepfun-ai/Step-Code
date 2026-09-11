import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	IdleStatus,
	RetryStatusIndicator,
	STEP_WORKING_INDICATOR_INTERVAL_MS,
	WorkingOutputTracker,
	WorkingStatusIndicator,
} from "../src/ui/view/chrome/status-indicator.ts";
import { initTheme } from "../../../packages/coding-agent/src/theme/theme.ts";

function assistantMessage(
	content: AssistantMessage["content"],
	options: { api?: AssistantMessage["api"]; output?: number } = {},
): AssistantMessage {
	const output = options.output ?? 0;
	return {
		role: "assistant",
		content,
		api: options.api ?? "anthropic-messages",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: 0,
	};
}

function deltaEvent<T extends "thinking_delta" | "text_delta" | "toolcall_delta">(
	type: T,
	delta: string,
	partial: AssistantMessage,
	contentIndex = 0,
): Extract<AssistantMessageEvent, { type: T }> {
	return { type, contentIndex, delta, partial } as Extract<AssistantMessageEvent, { type: T }>;
}

function toolCallStartEvent(
	partial: AssistantMessage,
	contentIndex = 0,
): Extract<AssistantMessageEvent, { type: "toolcall_start" }> {
	return { type: "toolcall_start", contentIndex, partial };
}

describe("status indicators", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps idle status at the same height as status indicators", () => {
		const idleStatus = new IdleStatus();

		const lines = idleStatus.render(20);
		expect(lines).toHaveLength(2);
		expect(lines).toEqual([" ".repeat(20), " ".repeat(20)]);
	});

	it("uses the slower cadence reserved for Step working indicators", () => {
		expect(STEP_WORKING_INDICATOR_INTERVAL_MS).toBe(200);
	});

	it("disposes retry countdown updates", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 1000);
		const callsBeforeDispose = requestRender.mock.calls.length;

		indicator.dispose();
		vi.advanceTimersByTime(2000);

		expect(requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
	});

	it("renders Claude-style elapsed time, estimated output tokens, and thinking phase for Step", () => {
		initTheme("step");
		vi.useFakeTimers();
		vi.setSystemTime(6500);
		const tracker = new WorkingOutputTracker();
		tracker.reset(0);
		const partial = assistantMessage([{ type: "thinking", thinking: "x".repeat(576) }]);
		tracker.update(deltaEvent("thinking_delta", "x".repeat(576), partial));
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const indicator = new WorkingStatusIndicator(tui, "Working...", undefined, "step", tracker);

		const line = stripTerminalSequences(indicator.render(80)[0] ?? "");

		expect(line).toContain("Working... (6s · ↓ 144 tokens · thinking)");
		indicator.dispose();
	});

	it("accumulates normalized Anthropic and OpenAI responses and replaces estimates with final usage", () => {
		const tracker = new WorkingOutputTracker();
		tracker.reset(1000);
		const anthropicPartial = assistantMessage([{ type: "thinking", thinking: "12345678" }]);
		tracker.update(deltaEvent("thinking_delta", "12345678", anthropicPartial));
		expect(tracker.snapshot(2000)).toEqual({ elapsedSeconds: 1, outputTokens: 2, phase: "thinking" });

		tracker.complete(assistantMessage(anthropicPartial.content, { output: 5 }));
		const openAiPartial = assistantMessage(
			[
				{ type: "text", text: "12345678" },
				{ type: "toolCall", id: "call-1", name: "tool", arguments: { x: "abcd" } },
			],
			{ api: "openai-completions" },
		);
		tracker.update(deltaEvent("text_delta", "12345678", openAiPartial));
		tracker.update(toolCallStartEvent(openAiPartial, 1));
		tracker.update(deltaEvent("toolcall_delta", '{"x":"abcd"}', openAiPartial, 1));

		expect(tracker.snapshot(3000)).toEqual({ elapsedSeconds: 2, outputTokens: 11, phase: undefined });
		tracker.complete(assistantMessage(openAiPartial.content, { api: "openai-completions", output: 9 }));
		expect(tracker.snapshot(4000)).toEqual({ elapsedSeconds: 3, outputTokens: 14, phase: undefined });
	});

	it("keeps the local estimate when a completed response has zero usage", () => {
		const tracker = new WorkingOutputTracker();
		tracker.reset(0);
		const message = assistantMessage([{ type: "text", text: "12345678" }]);
		tracker.update(deltaEvent("text_delta", "12345678", message));
		tracker.complete(message);

		expect(tracker.snapshot(1000).outputTokens).toBe(2);
	});

	it("estimates from event deltas without rescanning the accumulated message", () => {
		const tracker = new WorkingOutputTracker();
		tracker.reset(0);
		const partial = assistantMessage([]);
		Object.defineProperty(partial, "content", {
			get: () => {
				throw new Error("accumulated content was read");
			},
		});

		tracker.update(deltaEvent("text_delta", "1234", partial));
		tracker.update(deltaEvent("text_delta", "5678", partial));

		expect(tracker.snapshot(1000).outputTokens).toBe(2);
	});

	it("keeps native working status unchanged and Step status within the available width", () => {
		initTheme("step");
		const tracker = new WorkingOutputTracker();
		tracker.reset(0);
		const partial = assistantMessage([{ type: "text", text: "x".repeat(400) }]);
		tracker.update(deltaEvent("text_delta", "x".repeat(400), partial));
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const native = new WorkingStatusIndicator(tui, "Working...", undefined, "native", tracker);
		const step = new WorkingStatusIndicator(tui, "Working...", undefined, "step", tracker);

		expect(stripTerminalSequences(native.render(80).join("\n"))).not.toContain("tokens");
		expect(visibleWidth(step.render(24)[0] ?? "")).toBeLessThanOrEqual(24);

		native.dispose();
		step.dispose();
	});
});
