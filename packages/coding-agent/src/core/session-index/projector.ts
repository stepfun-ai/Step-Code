import type { SessionEntry, SessionHeader } from "../session-manager.ts";
import { extractMessageText } from "../session-summary.ts";

/**
 * Turns parsed JSONL lines into searchable rows. Pure functions: no I/O and no
 * runtime imports beyond the summary helpers, so the worker can load it.
 */

/** Bump when projected text changes; sources with an older version are rebuilt. */
export const PROJECTOR_VERSION = 1;

/** Per-entry cap; the trigram index grows about 3x with text length. */
export const MAX_ENTRY_TEXT_CHARS = 64 * 1024;

export interface ProjectedEntry {
	entryId: string;
	parentId: string | null;
	type: string;
	role: string | null;
	ts: number;
	text: string;
}

/** How entry ids were derived; v1 files have none and use physical line numbers. */
export type EntryIdScheme = "entry" | "line";

export function isSessionHeader(value: Record<string, unknown>): value is Record<string, unknown> & SessionHeader {
	return value.type === "session" && typeof value.id === "string";
}

export function headerVersion(header: SessionHeader): number {
	return typeof header.version === "number" ? header.version : 1;
}

export function entryIdSchemeFor(header: SessionHeader): EntryIdScheme {
	return headerVersion(header) < 2 ? "line" : "entry";
}

/**
 * Bring one raw entry to the v3 shape in memory, mirroring SessionManager's
 * migrations without touching the file. `lineNo` is the 1-based physical line.
 */
export function normalizeEntry(
	raw: Record<string, unknown>,
	scheme: EntryIdScheme,
	lineNo: number,
	previousId: string | null,
): SessionEntry | null {
	if (typeof raw.type !== "string" || raw.type === "session") return null;
	const entry = { ...raw } as Record<string, unknown>;
	if (scheme === "line") {
		entry.id = `L${lineNo}`;
		entry.parentId = previousId;
	} else if (typeof entry.id !== "string") {
		return null;
	}
	if (entry.type === "message") {
		const message = entry.message as { role?: unknown } | undefined;
		if (message && typeof message === "object" && message.role === "hookMessage") {
			entry.message = { ...message, role: "custom" };
		}
	}
	return entry as unknown as SessionEntry;
}

function entryTime(entry: SessionEntry, fallback: number): number {
	if (entry.type === "message") {
		const messageTime = (entry.message as { timestamp?: unknown } | undefined)?.timestamp;
		if (typeof messageTime === "number" && Number.isFinite(messageTime)) return messageTime;
	}
	const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
	return Number.isNaN(parsed) ? fallback : parsed;
}

function capText(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > MAX_ENTRY_TEXT_CHARS ? trimmed.slice(0, MAX_ENTRY_TEXT_CHARS) : trimmed;
}

/**
 * Searchable row for an entry, or null when it carries no indexed text.
 * Indexed: user/assistant message text, compaction and branch summaries,
 * displayed custom messages, and labels. Tool results, bash output, and
 * extension-private entries are not indexed.
 */
export function projectEntry(entry: SessionEntry, fallbackTs: number): ProjectedEntry | null {
	let role: string | null = null;
	let text = "";
	if (entry.type === "message") {
		const message = entry.message as { role?: unknown; content?: unknown } | undefined;
		if (!message || (message.role !== "user" && message.role !== "assistant")) return null;
		role = message.role;
		text = extractMessageText(message as Parameters<typeof extractMessageText>[0]);
	} else if (entry.type === "compaction" || entry.type === "branch_summary") {
		text = typeof entry.summary === "string" ? entry.summary : "";
	} else if (entry.type === "custom_message") {
		if (entry.display !== true) return null;
		text = extractMessageText({ content: entry.content } as Parameters<typeof extractMessageText>[0]);
	} else if (entry.type === "label") {
		text = typeof entry.label === "string" ? entry.label : "";
	} else {
		return null;
	}
	text = capText(text);
	if (!text) return null;
	return {
		entryId: entry.id,
		parentId: typeof entry.parentId === "string" ? entry.parentId : null,
		type: entry.type,
		role,
		ts: entryTime(entry, fallbackTs),
		text,
	};
}
