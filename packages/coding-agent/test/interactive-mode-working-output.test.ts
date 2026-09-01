import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { WorkingOutputTracker } from "../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

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
		workingOutputTracker.update(assistantMessage([{ type: "text", text: "x".repeat(40) }]), "text_delta");
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			workingOutputTracker,
			pendingTools: new Map(),
			stepSpinner: undefined,
			retryEscapeHandler: undefined,
			defaultEditor: { onEscape: undefined },
			streamingComponent: { updateContent: vi.fn() },
			streamingMessage: undefined,
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
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
});
