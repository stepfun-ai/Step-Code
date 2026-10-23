import type { AgentMessage } from "@step-harness/agent-core";
import type { Message, TextContent } from "@step-harness/providers";
import type { SessionEntry, SessionHeader, SessionMessageEntry } from "./session-manager.ts";

/**
 * Session list fields derived from entries. SessionManager.list() and the
 * session index both fold entries through this module so the two lists agree.
 * Kept free of runtime imports because the index worker loads it directly.
 */
export interface SessionSummaryFields {
	/** Latest session_info name; an empty name clears it. */
	name: string | undefined;
	/** First non-empty user text, or "" when there is none. */
	firstMessage: string;
	messageCount: number;
	/** Latest user/assistant activity time in epoch milliseconds. */
	lastActivityTime: number | undefined;
}

export function createSessionSummary(): SessionSummaryFields {
	return { name: undefined, firstMessage: "", messageCount: 0, lastActivityTime: undefined };
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

/** Join the text blocks of a user or assistant message; other blocks are ignored. */
export function extractMessageText(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is TextContent => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join(" ");
}

/** Activity time of a user/assistant message, preferring the message's own timestamp. */
export function getMessageActivityTime(entry: SessionMessageEntry): number | undefined {
	const message = entry.message;
	if (!message || !isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") {
		return msgTimestamp;
	}

	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

/**
 * Fold one entry into a summary. `onMessageText` receives each non-empty
 * user/assistant text in file order.
 */
export function foldSessionSummaryEntry(
	summary: SessionSummaryFields,
	entry: SessionEntry,
	onMessageText?: (text: string) => void,
): void {
	if (entry.type === "session_info") {
		summary.name = entry.name?.trim() || undefined;
	}

	if (entry.type !== "message") return;
	summary.messageCount++;

	const activityTime = getMessageActivityTime(entry);
	if (typeof activityTime === "number") {
		summary.lastActivityTime = Math.max(summary.lastActivityTime ?? 0, activityTime);
	}

	const message = entry.message;
	if (!message || !isMessageWithContent(message)) return;
	if (message.role !== "user" && message.role !== "assistant") return;

	const textContent = extractMessageText(message);
	if (!textContent) return;

	onMessageText?.(textContent);
	if (!summary.firstMessage && message.role === "user") {
		summary.firstMessage = textContent;
	}
}

export function summarizeSessionEntries(entries: readonly SessionEntry[]): SessionSummaryFields {
	const summary = createSessionSummary();
	for (const entry of entries) foldSessionSummaryEntry(summary, entry);
	return summary;
}

/**
 * The list's "modified" time: last activity, else the header timestamp, else
 * the file mtime.
 */
export function resolveSessionModifiedTime(
	header: Pick<SessionHeader, "timestamp">,
	lastActivityTime: number | undefined,
	fallbackMtimeMs: number,
): number {
	if (typeof lastActivityTime === "number" && lastActivityTime > 0) return lastActivityTime;
	const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : Number.NaN;
	return Number.isNaN(headerTime) ? fallbackMtimeMs : headerTime;
}
