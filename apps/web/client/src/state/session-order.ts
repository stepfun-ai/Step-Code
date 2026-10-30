/**
 * How the sidebar arranges conversations: pinned rows and the order a drag
 * placed them in.
 *
 * Both are page preferences, not session data: the host owns a session's cwd,
 * title and timestamps, and a sidebar arrangement is this reader's own view of
 * them, kept in local storage like the theme (last writer wins; two pages of
 * the same profile share the file but do not watch each other).
 *
 * The list has two parts, and they are kept apart on purpose:
 *
 * - Pinned rows are a fixed block at the top, newest pin first: pinning a
 *   conversation from the menu puts it on top, so the row pinned last is the row
 *   nearest the top. The pin order is the stored `pinnedSessions` array.
 * - Everything else follows the stored `sessionOrder` (the order drags gave it)
 *   and, for a row no drag has placed, the host's order (newest first). A new
 *   conversation therefore lands on top of the unpinned rows instead of below
 *   everything the reader has touched.
 *
 * Dragging only rearranges the unpinned rows. The pinned block is not a drop
 * target and a pinned row is not draggable: a drag can neither enter the block
 * nor push a row above it, so "pinned" always reads as "these are the fixed ones
 * on top". Membership changes only through the row menu, and pinning never
 * writes the unpinned order — a row that had a place keeps it while pinned, so
 * unpinning returns it there. A row pinned before it was ever arranged has no
 * place to return to and leads the unpinned rows once unpinned, exactly like a
 * conversation the host lists for the first time.
 *
 * Arranging one list writes that list's ids only, so another project keeps
 * following the host. A place belongs to the session, not to the list:
 * retagging or unarchiving a conversation keeps the rank it already had.
 */

import { readStorage, STORAGE_KEYS, writeStorage } from "../lib/storage";
import type { SessionSummary } from "./types";

/** The arrangement as it is stored and mirrored in the app state. */
export interface SessionPreferences {
	/** Pinned session ids, most recently pinned first. */
	readonly pinnedSessions: readonly string[];
	/** Session ids in the order a drag gave the unpinned rows. */
	readonly sessionOrder: readonly string[];
}

/** A session id list without repeats, in its stored order. */
function uniqueIds(ids: readonly string[]): string[] {
	return [...new Set(ids)];
}

/** A session id list, or an empty one when the stored value is not a list of strings. */
function parseIds(stored: string | null): string[] {
	if (!stored) return [];
	try {
		const parsed: unknown = JSON.parse(stored);
		if (!Array.isArray(parsed)) return [];
		return uniqueIds(parsed.filter((id): id is string => typeof id === "string" && id.length > 0));
	} catch {
		// A corrupt preference is a lost arrangement, not a broken sidebar.
		return [];
	}
}

export function readSessionPreferences(): SessionPreferences {
	return {
		pinnedSessions: parseIds(readStorage(STORAGE_KEYS.pinnedSessions)),
		sessionOrder: parseIds(readStorage(STORAGE_KEYS.sessionOrder)),
	};
}

export function writeSessionPreferences(preferences: SessionPreferences): void {
	writeStorage(STORAGE_KEYS.pinnedSessions, JSON.stringify(preferences.pinnedSessions));
	writeStorage(STORAGE_KEYS.sessionOrder, JSON.stringify(preferences.sessionOrder));
}

/** Whether two arrangements differ (references first: an unchanged pair needs no write). */
export function arrangementChanged(before: SessionPreferences, after: SessionPreferences): boolean {
	return before.pinnedSessions !== after.pinnedSessions || before.sessionOrder !== after.sessionOrder;
}

/**
 * Sessions as the sidebar draws them: pinned first in pin order, then the
 * stored order with the host's own position for every session no drag has
 * placed yet.
 */
export function orderedSessions(
	sessions: readonly SessionSummary[],
	pinnedSessions: readonly string[],
	sessionOrder: readonly string[],
): SessionSummary[] {
	const pinRank = new Map(pinnedSessions.map((id, index) => [id, index]));
	const rank = new Map(sessionOrder.map((id, index) => [id, index]));
	return [...sessions].sort((left, right) => {
		const leftPin = pinRank.get(left.id);
		const rightPin = pinRank.get(right.id);
		if (leftPin !== undefined || rightPin !== undefined) {
			if (leftPin === undefined) return 1;
			if (rightPin === undefined) return -1;
			return leftPin - rightPin;
		}
		// -1 keeps an unplaced (new) session ahead of every arranged one.
		return (rank.get(left.id) ?? -1) - (rank.get(right.id) ?? -1);
	});
}

/** The ids of one list in the order the arrangement gives them (no pins applied). */
function listOrder(listIds: readonly string[], sessionOrder: readonly string[]): string[] {
	const rank = new Map(sessionOrder.map((id, index) => [id, index]));
	return [...listIds].sort((left, right) => (rank.get(left) ?? -1) - (rank.get(right) ?? -1));
}

/** `ids` with `id` inserted next to `target` on the requested side. */
function insertBeside(ids: readonly string[], target: string, id: string, place: "before" | "after"): string[] {
	const next = ids.filter((candidate) => candidate !== id);
	const at = next.indexOf(target);
	if (at < 0) return [...next];
	next.splice(place === "before" ? at : at + 1, 0, id);
	return next;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * The arrangement after dragging `draggedId` before or after `targetId` in
 * `listIds` (one list, in drawn order).
 *
 * Only unpinned rows move. A drag that starts on a pinned row, or is dropped on
 * one, changes nothing: the pinned block stays the fixed area at the top and its
 * order stays the pin order. A drag that cannot move anything — the same row, a
 * row from another list, a row the list no longer has — returns the arrangement
 * unchanged.
 */
export function moveSession(
	listIds: readonly string[],
	preferences: SessionPreferences,
	draggedId: string,
	targetId: string,
	place: "before" | "after",
): SessionPreferences {
	if (draggedId === targetId) return preferences;
	if (!listIds.includes(draggedId) || !listIds.includes(targetId)) return preferences;
	// The pinned block is fixed: neither its rows nor drops onto it reorder.
	if (preferences.pinnedSessions.includes(draggedId) || preferences.pinnedSessions.includes(targetId)) {
		return preferences;
	}

	// Rewrite this list's unpinned rows and keep every other stored rank (another
	// list's rows, and the pinned rows' remembered places, so unpinning one later
	// returns it where a drag left it).
	const unpinned = listIds.filter((id) => !preferences.pinnedSessions.includes(id));
	const arranged = insertBeside(listOrder(unpinned, preferences.sessionOrder), targetId, draggedId, place);
	const rewritten = new Set(unpinned);
	const sessionOrder = [...preferences.sessionOrder.filter((id) => !rewritten.has(id)), ...arranged];
	if (sameIds(sessionOrder, preferences.sessionOrder)) return preferences;
	return { pinnedSessions: preferences.pinnedSessions, sessionOrder };
}

/**
 * Keep the arrangement to the sessions the list still has. A deleted session
 * must not hold a place (or a pin) that outlives it, and the same references
 * come back when nothing changed so the store can skip the update.
 */
export function pruneSessionPreferences(state: SessionPreferences, listed: ReadonlySet<string>): SessionPreferences {
	const pinnedSessions = state.pinnedSessions.filter((id) => listed.has(id));
	const sessionOrder = state.sessionOrder.filter((id) => listed.has(id));
	const pinnedUnchanged = pinnedSessions.length === state.pinnedSessions.length;
	const orderUnchanged = sessionOrder.length === state.sessionOrder.length;
	if (pinnedUnchanged && orderUnchanged) return state;
	return {
		pinnedSessions: pinnedUnchanged ? state.pinnedSessions : pinnedSessions,
		sessionOrder: orderUnchanged ? state.sessionOrder : sessionOrder,
	};
}
