import type { AssistantMessage } from "../types.ts";

/**
 * Why a finished provider turn carries nothing a client can act on.
 *
 * A client executes structured tool calls and renders text. A turn that reports
 * a normal stop while offering neither will end a run with nothing visible and
 * no work done, which reads as the task stopping early.
 */
export type IncompleteTurnReason = "missing_tool_call" | "no_visible_output";

/** Neutral, user-facing description of each reason. */
export const INCOMPLETE_TURN_MESSAGES: Record<IncompleteTurnReason, string> = {
	no_visible_output: "The model returned no visible answer or executable tool call.",
	missing_tool_call: "The model ended a tool-use turn without an executable tool call.",
};

type ContentBlocks = AssistantMessage["content"];

/**
 * A finished turn's content blocks, tolerating a persisted or hand-built message.
 *
 * Session files are read without validation, so `content` can be missing, or be a
 * plain string from an older or hand-edited transcript. Only a real array can be
 * inspected; anything else behaves as "no blocks", which classifies the turn
 * rather than throwing inside every `message_end`.
 */
export function contentBlocks(message: { content?: unknown }): ContentBlocks {
	if (!Array.isArray(message.content)) return [];
	// Elements come off a JSON pipe too: a `null` entry must not turn every
	// `message_end` into a TypeError.
	return (message.content as ContentBlocks).filter(
		(block): block is ContentBlocks[number] => typeof block === "object" && block !== null && "type" in block,
	);
}

function hasVisibleText(blocks: ContentBlocks): boolean {
	return blocks.some(
		(block) => block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
	);
}

/**
 * Classify a turn from its structured stop reason and content-block types.
 *
 * Only `stop` and `toolUse` can be incomplete: `error` and `aborted` carry their
 * own outcome, `length` is truncation that compaction owns, and `pending` /
 * `deferred` are not finished turns. Visible text or a structured tool call are
 * both actionable, so either one makes the turn complete.
 */
export function classifyIncompleteAssistantTurn(message: AssistantMessage): IncompleteTurnReason | undefined {
	const content = contentBlocks(message);
	// A tool-use stop promises a call the client can execute. Text does not make
	// that promise good: the call is what the provider said it produced.
	if (message.stopReason === "toolUse") {
		return content.some((block) => block.type === "toolCall") ? undefined : "missing_tool_call";
	}
	if (message.stopReason !== "stop") return undefined;
	const actionable = hasVisibleText(content) || content.some((block) => block.type === "toolCall");
	return actionable ? undefined : "no_visible_output";
}

/** Whether a finished turn carries nothing a client can act on. */
export function isIncompleteAssistantTurn(message: AssistantMessage): boolean {
	return classifyIncompleteAssistantTurn(message) !== undefined;
}

/** Why a run may treat this assistant message as its terminal failure. */
export interface AssistantTerminalFailure {
	kind: "error" | "aborted" | "incomplete";
	message: string;
	/** Set when `kind` is `incomplete`; the empty turn that ended the run. */
	incompleteReason?: IncompleteTurnReason;
}

/**
 * Describe a terminal run failure carried by an assistant message.
 *
 * Provider errors and cancellations are reported by `stopReason`. An incomplete
 * turn keeps the provider's stop reason and is reported separately, so consumers
 * must not decide "the run succeeded" from `stopReason` alone.
 */
export function assistantTerminalFailure(message: AssistantMessage): AssistantTerminalFailure | undefined {
	if (message.stopReason === "error") {
		return { kind: "error", message: message.errorMessage || "The model request failed." };
	}
	if (message.stopReason === "aborted") {
		return { kind: "aborted", message: message.errorMessage || "The model request was cancelled." };
	}
	const reason = classifyIncompleteAssistantTurn(message);
	if (reason) return { kind: "incomplete", message: INCOMPLETE_TURN_MESSAGES[reason], incompleteReason: reason };
	return undefined;
}
