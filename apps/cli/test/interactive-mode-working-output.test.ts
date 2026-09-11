import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../../packages/coding-agent/src/core/agent-session.ts";
import { WorkingOutputTracker } from "../src/ui/components/status-indicator.ts";
import { InteractiveMode } from "../src/ui/interactive-mode.ts";

function assistantMessage(
	content: AssistantMessage["content"],
	options: { api?: AssistantMessage["api"]; output?: number; stopReason?: AssistantMessage["stopReason"] } = {},
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
		stopReason: options.stopReason ?? "pending",
		timestamp: 0,
	};
}

function progressEvent(type: "thinking_delta" | "text_delta", message: AssistantMessage): AssistantMessageEvent {
	return {
		type,
		contentIndex: 0,
		delta: type === "thinking_delta" ? "12345678" : "abcdefgh",
		partial: message,
	};
}

describe("interactive working output tracking", () => {
	it("tracks normalized stream events across model calls and corrects each response with final usage", async () => {
		const workingOutputTracker = new WorkingOutputTracker();
		workingOutputTracker.reset(0);
		workingOutputTracker.update(
			progressEvent("text_delta", assistantMessage([{ type: "text", text: "x".repeat(40) }])),
		);
		const updateContent = vi.fn();
		const fakeThis = {
			isInitialized: true,
			options: { tuiStyle: "step" },
			presentation: "step",
			footer: { invalidate: vi.fn() },
			workingOutputTracker,
			pendingTools: new Map(),
			stepSpinner: undefined,
			retryEscapeHandler: undefined,
			defaultEditor: { onEscape: undefined },
			streamingComponent: { updateContent },
			streamingMessage: undefined,
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
			redraw: { requestRender: vi.fn(), forceRender: vi.fn(), renderNow: vi.fn() },
			session: { retryAttempt: 0 },
			maybeShowCacheMissNotice: vi.fn(),
			clearStatusIndicator: vi.fn(),
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: AgentSessionEvent,
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "agent_start" });
		const anthropicPartial = assistantMessage([{ type: "thinking", thinking: "12345678" }]);
		await handleEvent.call(fakeThis, {
			type: "message_update",
			message: anthropicPartial,
			assistantMessageEvent: progressEvent("thinking_delta", anthropicPartial),
		});
		expect(workingOutputTracker.snapshot().outputTokens).toBe(2);
		expect(updateContent).toHaveBeenCalledWith(anthropicPartial, true);

		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: assistantMessage(anthropicPartial.content, { output: 5, stopReason: "stop" }),
		});
		expect(workingOutputTracker.snapshot().outputTokens).toBe(5);

		fakeThis.streamingComponent = { updateContent: vi.fn() };
		const openAiPartial = assistantMessage([{ type: "text", text: "abcdefgh" }], {
			api: "openai-completions",
		});
		await handleEvent.call(fakeThis, {
			type: "message_update",
			message: openAiPartial,
			assistantMessageEvent: progressEvent("text_delta", openAiPartial),
		});
		expect(workingOutputTracker.snapshot().outputTokens).toBe(7);

		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: assistantMessage(openAiPartial.content, {
				api: "openai-completions",
				output: 9,
				stopReason: "stop",
			}),
		});
		expect(workingOutputTracker.snapshot().outputTokens).toBe(14);
	});

	it("does not run Step output tracking for the native presentation", async () => {
		const workingOutputTracker = new WorkingOutputTracker();
		const reset = vi.spyOn(workingOutputTracker, "reset");
		const update = vi.spyOn(workingOutputTracker, "update");
		const complete = vi.spyOn(workingOutputTracker, "complete");
		const partial = assistantMessage([{ type: "text", text: "abcdefgh" }]);
		const updateContent = vi.fn();
		const fakeThis = {
			isInitialized: true,
			options: { tuiStyle: "native" },
			presentation: "native",
			footer: { invalidate: vi.fn() },
			workingOutputTracker,
			pendingTools: new Map(),
			stepSpinner: undefined,
			retryEscapeHandler: undefined,
			defaultEditor: { onEscape: undefined },
			streamingComponent: { updateContent },
			streamingMessage: undefined,
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
			redraw: { requestRender: vi.fn(), forceRender: vi.fn(), renderNow: vi.fn() },
			session: { retryAttempt: 0 },
			maybeShowCacheMissNotice: vi.fn(),
			clearStatusIndicator: vi.fn(),
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: AgentSessionEvent,
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "agent_start" });
		await handleEvent.call(fakeThis, {
			type: "message_update",
			message: partial,
			assistantMessageEvent: progressEvent("text_delta", partial),
		});
		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: assistantMessage(partial.content, { output: 2, stopReason: "stop" }),
		});

		expect(reset).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
		expect(complete).not.toHaveBeenCalled();
		expect(updateContent).toHaveBeenCalledWith(partial, true);
	});
});
