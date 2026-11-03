/**
 * Which notices the transcript shows and which the composer's warning badge
 * holds. One place decides, so the stream, the badge and its "clear all" agree.
 *
 * A warning that answers the user's own input (`Usage: ...`, a refusal, the
 * paused-goal reminder) is a reply: the host marks it, and it stays in the
 * transcript where the user is looking. Every other warning arrived on its own
 * (a background failure, a problem mid-turn) and only counts in the badge, so
 * it does not interrupt the reading.
 */

import type { NoticeItem } from "./types";

/** A typed line the kernel answers as a command (with notices) rather than as a turn. */
export function isCommandText(text: string | undefined): boolean {
	return /^\s*\/[A-Za-z0-9]/u.test(text ?? "");
}

/** A warning that arrived on its own, not as the reply to a command. */
export function isAmbientWarning(notice: NoticeItem): boolean {
	return notice.level === "warning" && notice.reply !== true;
}

/** One session's notices as transcript rows: everything except ambient warnings. */
export function transcriptNotices(notices: readonly NoticeItem[], sessionId: string | undefined): NoticeItem[] {
	return notices.filter((notice) => notice.sessionId === sessionId && !isAmbientWarning(notice));
}

/** One session's ambient warnings for the badge, newest first. */
export function badgeWarnings(notices: readonly NoticeItem[], sessionId: string | undefined): NoticeItem[] {
	if (sessionId === undefined) return [];
	return notices.filter((notice) => notice.sessionId === sessionId && isAmbientWarning(notice)).reverse();
}
