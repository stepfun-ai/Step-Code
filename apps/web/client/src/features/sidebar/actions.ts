/**
 * Sidebar actions, callable from any feature. The sidebar feature owns this
 * file; `openSearch` / `closeSearch` are the fixed cross-feature names.
 */

import { type TagColor, t } from "../../i18n";
import { api } from "../../lib/api";
import { arrangementChanged, moveSession, writeSessionPreferences } from "../../state/session-order";
import { type ConversationView, getState, setState, setToggled, setUi } from "../../state/store";
import { updateTagGroups } from "../../state/tag-group-persistence";
import { pruneTagGroups, withoutSessionTag } from "../../state/tag-groups";
import type { SessionSearchResult } from "../../state/types";

/* ── Global search (legacy 1199-1211) ────────────────────────────────────── */

const searchOpenListeners = new Set<() => void>();

/**
 * Called on every `openSearch()`, even when the modal is already open (⌘K
 * again): the legacy function cleared `#globalSearchInput`, reset the
 * selection and focused the input each time. The search modal subscribes.
 */
export function subscribeSearchOpen(listener: () => void): () => void {
	searchOpenListeners.add(listener);
	return () => {
		searchOpenListeners.delete(listener);
	};
}

/** Show the global search modal with an empty query (legacy `openSearch`, 1199-1205). */
export function openSearch(): void {
	setUi({ searchOpen: true });
	for (const listener of [...searchOpenListeners]) listener();
}

/** Hits per query; several can fall in one session, which the modal shows once. */
const SEARCH_HIT_LIMIT = 100;

/** Full-text search over session content through the host's index (GET /api/v1/search). */
export function searchSessionContent(query: string, signal: AbortSignal): Promise<SessionSearchResult> {
	const params = new URLSearchParams({ q: query, limit: String(SEARCH_HIT_LIMIT) });
	return api<SessionSearchResult>(`/api/v1/search?${params}`, { signal });
}

/** Hide the global search modal (legacy `closeSearch`, 1207-1211); the modal drops its results. */
export function closeSearch(): void {
	setUi({ searchOpen: false });
}

/* ── Sidebar menus ───────────────────────────────────────────────────────── */
/* At most one is open; each is a Popover around its trigger in ProjectGroup / SessionRow. */

export function toggleWorkspaceMenu(cwd: string): void {
	if (getState().ui.workspaceMenu?.cwd === cwd) {
		closeWorkspaceMenu(true);
		return;
	}
	setUi({ workspaceMenu: { cwd }, sessionMenu: null, tagPicker: null, streamMenu: false });
}

export function closeWorkspaceMenu(restoreFocus = false): void {
	const menu = getState().ui.workspaceMenu;
	setUi({ workspaceMenu: null });
	if (restoreFocus && menu) {
		document
			.querySelector<HTMLButtonElement>(`.project-group[data-cwd="${CSS.escape(menu.cwd)}"] .workspace-menu-button`)
			?.focus({ preventScroll: true });
	}
}

/** Open or close `#sessionMenu` for a session (legacy `openSessionMenu`, 1291-1329). */
export function toggleSessionMenu(sessionId: string): void {
	const open = getState().ui.sessionMenu?.sessionId === sessionId;
	setUi({ sessionMenu: open ? null : { sessionId }, workspaceMenu: null, tagPicker: null, streamMenu: false });
}

/** Legacy `closeSessionMenu` (1287-1289). */
export function closeSessionMenu(): void {
	setUi({ sessionMenu: null });
}

/** Open or close `#tagPicker` for a session (legacy `openTagPicker`, 1022-1060). */
export function toggleTagPicker(sessionId: string): void {
	const open = getState().ui.tagPicker?.sessionId === sessionId;
	setUi({ tagPicker: open ? null : { sessionId }, workspaceMenu: null, sessionMenu: null, streamMenu: false });
}

export function closeTagPicker(): void {
	setUi({ tagPicker: null });
}

/* ── Conversation list ───────────────────────────────────────────────────── */

/**
 * Switch between the project and grouped views; entering the grouped view
 * drops the tag filter unless `clearFilter` is false (legacy
 * `switchConversationView`, 914-927).
 */
export function switchConversationView(view: string, clearFilter = true): void {
	const currentView: ConversationView = view === "group" ? "group" : "project";
	setState((state) => ({
		currentView,
		currentFilter: clearFilter && currentView === "group" ? null : state.currentFilter,
	}));
}

/** Filter the project view by a tag colour; null shows every row (legacy `applyTagFilter`, 929-955). */
export function applyTagFilter(key: TagColor | null): void {
	setState({ currentFilter: key || null });
}

/** Toggle between active and archived conversations (legacy `toggleArchived`, 1282-1285). */
export function toggleArchived(): void {
	setState((state) => ({ showArchived: !state.showArchived }));
}

/** Fold or unfold a project group (legacy project header click, 857-861). */
export function toggleProjectFolded(cwd: string): void {
	setState((state) => ({ foldedProjects: setToggled(state.foldedProjects, cwd) }));
}

/** Show every conversation of a workspace group, or only its first few again. */
export function toggleProjectExpanded(cwd: string): void {
	setState((state) => ({ expandedProjects: setToggled(state.expandedProjects, cwd) }));
}

/** Collapse or show the sidebar (legacy `#sidebarToggle`, 3383-3385). */
export function toggleSidebar(): void {
	setUi((ui) => ({ sidebarHidden: !ui.sidebarHidden }));
}

/**
 * Tag a session with `color`, or untag it with null. Tags are client-only, as in
 * the legacy code.
 *
 * Untagging the last session of a group also removes that group: a group that
 * no session carries is invisible in the grouped view, so leaving its record
 * behind only made the picker offer a group that no longer exists.
 */
export function setSessionTag(sessionId: string, color: TagColor | null): void {
	updateTagGroups((state) => {
		if (!color) return withoutSessionTag(state, sessionId);
		if (!state.groups.some((group) => group.key === color)) throw new Error(t("groupColorUnavailable"));
		const tags = new Map(state.tags);
		tags.set(sessionId, color);
		return pruneTagGroups({ ...state, tags }, new Set(tags.keys()));
	});
}

/**
 * Create a group for an unused colour and tag `sessionId` with it (legacy
 * `showTagNameInput` accept, 1066-1071). One commit, so a group and the tag
 * that keeps it alive never appear apart.
 */
export function createGroupAndTag(sessionId: string, color: TagColor, name: string): void {
	updateTagGroups((state) => {
		if (state.groups.some((group) => group.key === color)) throw new Error(t("groupColorUnavailable"));
		if (state.groups.some((group) => group.name.toLowerCase() === name.trim().toLowerCase())) {
			throw new Error(t("groupNameDuplicate"));
		}
		const tags = new Map(state.tags);
		tags.set(sessionId, color);
		const groups = [...state.groups, { key: color, name: name.trim() }];
		return pruneTagGroups({ ...state, groups, tags }, new Set(tags.keys()));
	});
}

/* ── Arrangement: pinning and drag order ─────────────────────────────────── */

/**
 * Pin or unpin a conversation. A pinned row leads the list it already belongs
 * to (its project, Recent, or its tag section) instead of moving out of it, so
 * pinning never hides which project a conversation came from; the row pinned
 * last is the one nearest the top. Stored in local storage, like the theme: the
 * host has no opinion about one reader's order.
 */
export function toggleSessionPin(sessionId: string): void {
	const state = getState();
	const pinnedSessions = state.pinnedSessions.includes(sessionId)
		? state.pinnedSessions.filter((id) => id !== sessionId)
		: [sessionId, ...state.pinnedSessions];
	setState({ pinnedSessions });
	writeSessionPreferences({ pinnedSessions, sessionOrder: state.sessionOrder });
}

/**
 * Move a dragged row before or after another row of its own list
 * (`features/sidebar/drag.ts`). `drawnIds` is that list in drawn order; a drop
 * beside a pinned row pins the row there, beside an unpinned row it unpins it.
 * The stored arrangement keeps only the lists the reader has actually moved.
 */
export function reorderSession(
	draggedId: string,
	targetId: string,
	place: "before" | "after",
	drawnIds: readonly string[],
): void {
	const state = getState();
	const preferences = moveSession(drawnIds, state, draggedId, targetId, place);
	// A drag that changes nothing must not write (nor repaint) the arrangement.
	if (!arrangementChanged(state, preferences)) return;
	setState(preferences);
	writeSessionPreferences(preferences);
}

/** Rename the group a tag colour stands for; rows and the filter chip follow the colour, not the name. */
export function renameGroup(key: TagColor, name: string): void {
	updateTagGroups((state) => {
		if (state.groups.some((group) => group.key !== key && group.name.toLowerCase() === name.trim().toLowerCase())) {
			throw new Error(t("groupNameDuplicate"));
		}
		return { groups: state.groups.map((group) => (group.key === key ? { ...group, name: name.trim() } : group)) };
	});
}
