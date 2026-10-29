/**
 * How many conversations a workspace group shows before "show the rest".
 *
 * A collapsed group draws its first rows in the order the sidebar already
 * arranges them (`state/session-order.ts`: pinned rows lead), so the pinned
 * block is always part of what shows. A pin is the reader saying "keep this in
 * sight": a group with more pins than the limit shows every pin and no
 * unpinned row rather than hide one of them. The open conversation stays
 * visible in its own place as well, so a session opened from search or a link
 * never loses its selection mark behind the fold.
 *
 * Expansion is a page-load preference held per workspace (`expandedProjects`),
 * like a folded group; it is not session data.
 */

/** Rows a collapsed workspace group shows, pinned rows included. */
export const COLLAPSED_SESSION_LIMIT = 5;

export interface CollapsedRows {
	/** The ids to draw, in drawn order. */
	readonly shownIds: readonly string[];
	/** Drawn rows the collapsed group leaves out (0 when expanded). */
	readonly hiddenCount: number;
	/** The group has more rows than the limit, so it offers a show-more or show-less control. */
	readonly collapsible: boolean;
}

/**
 * The rows of one workspace group that show.
 *
 * `drawnIds` are the rows the reader could see (tag-filtered rows already
 * removed), pinned first; `pinnedIds` the stored pins; `activeId` the open
 * conversation, if any.
 */
export function collapsedRows(
	drawnIds: readonly string[],
	pinnedIds: readonly string[],
	activeId: string | null,
	expanded: boolean,
): CollapsedRows {
	const pinned = new Set(pinnedIds);
	const limit = Math.max(COLLAPSED_SESSION_LIMIT, drawnIds.filter((id) => pinned.has(id)).length);
	const collapsible = drawnIds.length > limit;
	if (expanded || !collapsible) return { shownIds: drawnIds, hiddenCount: 0, collapsible };
	const shownIds = drawnIds.filter((id, index) => index < limit || id === activeId);
	return { shownIds, hiddenCount: drawnIds.length - shownIds.length, collapsible };
}
