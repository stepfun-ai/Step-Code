import type { MessageTimelineItem, SessionStatus, TimelineItem } from "../../state/types";

export interface TurnFooter {
	readonly turnId: string;
	readonly lastIndex: number;
	readonly messages: readonly MessageTimelineItem[];
}

/**
 * Presentation groups only: user messages bound turns; the host status decides
 * whether the latest one has settled, never an individual message/tool ending.
 */
export function collectTurnFooters(
	items: readonly TimelineItem[],
	status: SessionStatus | undefined,
	pendingPrompt: boolean,
	/** Include settled error-only turns for metadata, without adding action footers. */
	includeErrorOnly = false,
): TurnFooter[] {
	const turns: { turnId: string; lastIndex: number; messages: MessageTimelineItem[]; unsettled: boolean }[] = [];
	items.forEach((item, index) => {
		if (item.kind === "message" && item.role === "user") {
			turns.push({ turnId: item.entryId ?? item.itemId, lastIndex: index, messages: [], unsettled: false });
			return;
		}
		if (!turns.length) turns.push({ turnId: item.itemId, lastIndex: index, messages: [], unsettled: false });
		const turn = turns[turns.length - 1];
		turn.lastIndex = index;
		if (item.kind === "message" && item.role === "assistant") {
			turn.messages.push(item);
			turn.unsettled ||= item.itemId.startsWith("message-live");
		}
		turn.unsettled ||= item.kind === "thinking" && item.itemId.startsWith("message-live");
		turn.unsettled ||= item.kind === "approval" || (item.kind === "tool" && item.state === "pending");
	});
	return turns.filter((turn, index) => {
		if (!turn.messages.some((message) => (message.content && !message.error) || (includeErrorOnly && message.error)))
			return false;
		if (index < turns.length - 1) return true;
		if (turn.unsettled) return false;
		// A prompt not yet recorded belongs after this timeline, not to its last turn.
		return pendingPrompt || status === "idle" || status === "completed" || status === "failed";
	});
}
