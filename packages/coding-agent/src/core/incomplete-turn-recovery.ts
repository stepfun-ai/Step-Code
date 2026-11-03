import {
	type AssistantMessage,
	appendAssistantMessageDiagnostic,
	contentBlocks,
	type IncompleteTurnReason,
} from "@step-harness/providers";
import type { CustomMessage } from "./messages.ts";

export const INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE = "step-incomplete-turn-recovery";

/**
 * Recovery instructions for a turn that produced nothing actionable.
 *
 * The wording does not refer to "your previous response": a response with no
 * content blocks is dropped by the provider serializers, so the model may only
 * see the original prompt followed by this message.
 */
const RECOVERY_PROMPTS: Record<IncompleteTurnReason, string> = {
	no_visible_output: [
		"[Step runtime recovery] The last turn produced no visible answer and no tool call.",
		"If work remains, call the appropriate tool now; otherwise finish with a clear answer for me.",
		"Do not put tool calls or commands inside reasoning only.",
	].join("\n"),
	missing_tool_call: [
		"[Step runtime recovery] The last turn ended as a tool-use turn but carried no executable tool call.",
		"If work remains, call the appropriate tool now; otherwise finish with a clear answer for me.",
		"Do not put tool calls or commands inside reasoning only.",
	].join("\n"),
};

/**
 * The hidden follow-up that asks the model to continue an empty turn.
 *
 * `recoversEntryId` names the session entry this message was sent for, so a reader
 * can pair the two by identity instead of guessing from their position: a session
 * writes other entries in between (usage provenance, a compaction, a model or
 * thinking-level change). It is metadata, never sent to the model.
 */
export function createIncompleteTurnRecoveryMessage(
	reason: IncompleteTurnReason,
	recoversEntryId?: string,
): CustomMessage {
	return {
		role: "custom",
		customType: INCOMPLETE_TURN_RECOVERY_CUSTOM_TYPE,
		content: RECOVERY_PROMPTS[reason],
		display: false,
		...(recoversEntryId ? { details: { recoversEntryId } } : {}),
		timestamp: Date.now(),
	};
}

/**
 * Record why an incomplete turn could not stand, on the turn itself.
 *
 * The message keeps the provider's stop reason: this only adds the diagnostic and
 * never rewrites a provider fact.
 */
export function recordIncompleteTurn(
	message: AssistantMessage,
	reason: IncompleteTurnReason,
	options: { streak: number; details?: Record<string, unknown> },
): void {
	const content = contentBlocks(message);
	appendAssistantMessageDiagnostic(message, {
		type: "incomplete_turn",
		timestamp: Date.now(),
		details: {
			reason,
			consecutiveTurns: options.streak,
			hadThinking: content.some((block) => block.type === "thinking"),
			hadVisibleText: content.some(
				(block) => block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
			),
			...(message.rawStopReason ? { rawStopReason: message.rawStopReason } : {}),
			...options.details,
		},
	});
}
