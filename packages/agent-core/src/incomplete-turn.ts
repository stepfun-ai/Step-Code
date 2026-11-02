import type { AssistantMessage } from "@step-harness/providers";

/** Why an assistant turn cannot stand as a completed response. */
export type IncompleteAssistantTurnReason = "missing_tool_call" | "no_visible_output";

/** Classify an incomplete turn by its structured stop reason and content blocks. */
export function classifyIncompleteAssistantTurn(message: AssistantMessage): IncompleteAssistantTurnReason | undefined {
	const content = message.content ?? [];
	const hasVisibleText = content.some((block) => block.type === "text" && block.text.trim().length > 0);
	const hasToolCall = content.some((block) => block.type === "toolCall");

	if (message.stopReason === "toolUse" && !hasToolCall) return "missing_tool_call";
	if (message.stopReason !== "stop") return undefined;
	return !hasVisibleText && !hasToolCall ? "no_visible_output" : undefined;
}

/** Whether an assistant turn cannot stand as a completed response. */
export function isIncompleteAssistantTurn(message: AssistantMessage): boolean {
	return classifyIncompleteAssistantTurn(message) !== undefined;
}
