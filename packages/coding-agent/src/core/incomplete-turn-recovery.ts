import type { IncompleteAssistantTurnReason } from "@step-harness/agent-core";
import { appendAssistantMessageDiagnostic } from "@step-harness/providers";
import type { AssistantMessage } from "@step-harness/providers/compat";
import type { CustomMessage } from "./messages.ts";

export const INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE = "step-incomplete-turn-recovery";

const RECOVERY_PROMPTS: Record<IncompleteAssistantTurnReason, string> = {
	no_visible_output: [
		"I don't see a visible answer or a tool call in your previous response.",
		"If work remains, call the appropriate tool now; otherwise finish with a clear answer for me.",
		"Do not place tool calls or commands only inside reasoning.",
	].join("\n"),
	missing_tool_call: [
		"I don't see an executable tool call in your previous response, even though it ended as a tool-use turn.",
		"If work remains, call the appropriate tool now; otherwise finish with a clear answer for me.",
		"Do not place tool calls or commands only inside reasoning.",
	].join("\n"),
};

export const FAILURE_MESSAGES: Record<IncompleteAssistantTurnReason, string> = {
	no_visible_output: "The model returned no visible answer or executable tool call.",
	missing_tool_call: "The model ended a tool-use turn without an executable tool call.",
};

export function createIncompleteTurnRecoveryMessage(reason: IncompleteAssistantTurnReason): CustomMessage {
	return {
		role: "custom",
		customType: INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
		content: RECOVERY_PROMPTS[reason],
		display: false,
		timestamp: Date.now(),
	};
}

export function markIncompleteTurnFailed(
	message: AssistantMessage,
	reason: IncompleteAssistantTurnReason,
	options: { recoveryAttempts: number; errorMessage?: string; details?: Record<string, unknown> },
): void {
	const content = message.content ?? [];
	message.stopReason = "error";
	message.errorMessage = options.errorMessage ?? FAILURE_MESSAGES[reason];
	appendAssistantMessageDiagnostic(message, {
		type: "incomplete_turn",
		timestamp: Date.now(),
		details: {
			recoveryAttempts: options.recoveryAttempts,
			reason,
			hadThinking: content.some((block) => block.type === "thinking"),
			hadVisibleText: content.some((block) => block.type === "text" && block.text.trim().length > 0),
			...options.details,
		},
	});
}
