import { type DragEvent, type KeyboardEvent, type MouseEvent, useRef, useState } from "react";
import { formatRelativeTime, formatRelativeTimeLong, useRelativeTimeClock, useT } from "../../i18n";
import { cx } from "../../lib/format";
import { openSession, sessionTitle, taskStatus } from "../../state/session";
import { mapWith, setState, shallowEqual, useAppStore } from "../../state/store";
import type { SessionSummary } from "../../state/types";
import { Icon, IconButton, LEGACY_ICONS, Popover, Tooltip } from "../../ui";
import {
	applyTagFilter,
	closeSessionMenu,
	closeTagPicker,
	reorderSession,
	toggleSessionMenu,
	toggleSessionPin,
	toggleTagPicker,
} from "./actions";
import { beginSessionDrag, canReorder, draggedSession, dropPlaceAt, endSessionDrag } from "./drag";
import { SessionMenu } from "./SessionMenu";
import { TagPicker } from "./TagPicker";
import { cssVar, groupName, SESSION_DRAG_TYPE, TAG_COLORS } from "./tags";

export interface SessionRowProps {
	readonly session: SessionSummary;
	/** Rows of the grouped view have no tag button (legacy `buildSessionRow(session, true)`). */
	readonly grouped?: boolean;
	/** Hidden by the project view's tag filter (legacy `row.style.display = "none"`). */
	readonly filteredOut?: boolean;
	/**
	 * The list this row sits in: its project folder, `recent`, or a tag colour.
	 * Only rows of one list reorder against each other; in the grouped view a row
	 * dragged onto another section still retags instead.
	 */
	readonly listId: string;
	/** The ids of the rows the reader can actually see, in drawn order (pins first, filtered rows out). */
	readonly drawnIds: readonly string[];
	/**
	 * The whole list a reorder rewrites, in drawn order, when it is longer than
	 * `drawnIds`: a collapsed workspace group draws only its first rows, yet a
	 * drag among them must keep the rows past the fold in their places.
	 */
	readonly listIds?: readonly string[];
}

/** One conversation row (legacy `buildSessionRow`, 760-819). */
export function SessionRow({
	session,
	grouped = false,
	filteredOut = false,
	listId,
	drawnIds,
	listIds = drawnIds,
}: SessionRowProps) {
	const t = useT();
	useRelativeTimeClock();
	const row = useAppStore((state) => {
		const tag = state.tags.get(session.id);
		// The project and grouped views both render a row per session; only the visible one owns its menus.
		const inView = state.currentView === (grouped ? "group" : "project");
		const status = taskStatus(state, session);
		// While another session loads, its row is already the selection.
		const active = (state.ui.openingSession ?? state.current?.id) === session.id;
		return {
			status,
			// The green dot marks a finished run the user has not looked at yet; a
			// running row keeps its pulse and badge, and the open row is being looked at.
			unread: status === "completed" && !active && state.unreadById.get(session.id) === true,
			active,
			pinned: state.pinnedSessions.includes(session.id),
			pinnedIds: state.pinnedSessions,
			tag,
			tagName: tag ? groupName(state.groups, tag) : "",
			view: state.currentView,
			filter: state.currentFilter,
			menuOpen: inView && state.ui.sessionMenu?.sessionId === session.id,
			tagPickerOpen: inView && state.ui.tagPicker?.sessionId === session.id,
		};
	}, shallowEqual);
	const { status, tag } = row;
	// The keyboard neighbour comes from the unpinned rows the reader can see: the
	// pinned block is fixed, and a filtered-out row is not a place they can land
	// beside.
	const movableIds = drawnIds.filter((id) => !row.pinnedIds.includes(id));
	const index = movableIds.indexOf(session.id);
	const previousId = index > 0 ? movableIds[index - 1] : null;
	const nextId = index >= 0 && index < movableIds.length - 1 ? movableIds[index + 1] : null;

	const title = sessionTitle(session);
	// The card says "completed" only where the row shows its green dot (a finished run not yet
	// looked at); any other settled row reads as idle, whether or not this host ran it.
	const cardStatus = status === "completed" && !row.unread ? "idle" : status;
	// Measured when the row is entered: the sidebar width, the hover actions (shown by then) and
	// the title itself all change the cut. Only a cut title earns the hover card.
	const [titleClipped, setTitleClipped] = useState(false);
	const measureTitle = (event: { readonly currentTarget: HTMLDivElement }) => {
		const element = event.currentTarget.querySelector(".session-title");
		setTitleClipped(element !== null && element.scrollWidth > element.clientWidth);
	};

	const [dragging, setDragging] = useState(false);
	const [dropPlace, setDropPlace] = useState<"before" | "after" | null>(null);
	// Keeping focus on this row after a keyboard reorder needs the live node.
	const rowRef = useRef<HTMLDivElement | null>(null);

	const open = () => {
		setState((state) => ({ unreadById: mapWith(state.unreadById, session.id, false) }));
		void openSession(session.id);
	};
	const onClick = (event: MouseEvent<HTMLDivElement>) => {
		if (
			(event.target as Element).closest(
				".session-menu-button,.session-tag-button,.session-tag,.session-pin,.session-pin-action",
			)
		)
			return;
		open();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		// Only the row itself: Enter on a nested button must activate that button.
		if (event.target !== event.currentTarget) return;
		// A pointer drag is not the only way to arrange a list (see ResizeHandle).
		if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
			// Alt+↑/↓ is a browser shortcut elsewhere; the row owns it even at the ends.
			event.preventDefault();
			// A pinned row is not movable: the pinned block keeps the pin order.
			const targetId = row.pinned ? null : event.key === "ArrowUp" ? previousId : nextId;
			if (!targetId) return;
			const element = event.currentTarget;
			reorderSession(session.id, targetId, event.key === "ArrowUp" ? "before" : "after", listIds);
			// React moves the existing row nodes; Chrome drops focus from a node it
			// re-inserts, so the next keypress would go nowhere.
			requestAnimationFrame(() => (rowRef.current ?? element).focus({ preventScroll: true }));
			return;
		}
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			open();
		}
	};
	const onMenuClick = (event: MouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		toggleSessionMenu(session.id);
	};
	const onTagButtonClick = (event: MouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		toggleTagPicker(session.id);
	};
	const onPinClick = (event: MouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		toggleSessionPin(session.id);
	};
	const onTagClick = (event: MouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		if (row.view === "project" && tag) applyTagFilter(row.filter === tag ? null : tag);
	};

	// Dragging a row reorders it inside its own list; the grouped view's sections
	// are separate retag targets (see GroupedView), which a row's own drop prefix
	// leaves untouched when the drag came from another list.
	const onDragStart = (event: DragEvent<HTMLDivElement>) => {
		// A src row can vanish mid-drag (a refresh, a view switch), leaving no
		// dragend to clean up after it: start every drag from a clean slate.
		endSessionDrag();
		event.dataTransfer.setData(SESSION_DRAG_TYPE, session.id);
		event.dataTransfer.effectAllowed = "move";
		beginSessionDrag(session.id, listId, row.pinned);
		setDragging(true);
	};
	const onDragEnd = () => {
		endSessionDrag();
		setDragging(false);
		setDropPlace(null);
	};
	const onDragOver = (event: DragEvent<HTMLDivElement>) => {
		// Only a session row drag can land here: files or links dragged in from
		// outside must never turn into a reorder.
		if (!event.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return;
		const source = draggedSession();
		// Another list's row: leave the event to the section (retag) and to the
		// other view, rather than pretending this row can take it.
		if (!canReorder(source, listId, session.id, row.pinned)) return;
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = "move";
		setDropPlace(dropPlaceAt(event.currentTarget, event.clientY));
	};
	const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
		// Moving onto a child is not leaving the row.
		if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
		setDropPlace(null);
	};
	const onDrop = (event: DragEvent<HTMLDivElement>) => {
		setDropPlace(null);
		// Same fence as dragover: a payload dragged in from outside is never a drop.
		if (!event.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return;
		const source = draggedSession();
		if (!canReorder(source, listId, session.id, row.pinned)) return;
		event.preventDefault();
		event.stopPropagation();
		// Read the pointer here: React may not have committed the last `dragover`,
		// and a drop that lands on the other half must not fall back to "before".
		reorderSession(source.sessionId, session.id, dropPlaceAt(event.currentTarget, event.clientY), listIds);
		endSessionDrag();
	};

	return (
		// The whole row shows a card with the full title when the ellipsis cut it.
		<Tooltip
			placement="right"
			className="session-hover-card"
			content={
				titleClipped ? (
					<>
						<span className="session-hover-card-title">{title}</span>
						<span className="session-hover-card-time">{formatRelativeTimeLong(session.modified)}</span>
						<span className={cx("session-hover-card-status", cardStatus)}>{t(cardStatus)}</span>
					</>
				) : null
			}
		>
			{/* biome-ignore lint/a11y/useSemanticElements: the legacy row is a div[role=button] holding its own buttons, which a <button> cannot contain. */}
			<div
				ref={rowRef}
				className={cx(
					"session-row",
					status,
					row.active && "active",
					row.unread && "unread",
					dragging && "dragging",
					dropPlace && `drop-${dropPlace}`,
				)}
				role="button"
				tabIndex={0}
				data-session-id={session.id}
				data-pinned={row.pinned ? "true" : undefined}
				style={filteredOut ? { display: "none" } : undefined}
				// The pinned block is fixed: its rows cannot be grabbed at all.
				draggable={row.pinned ? undefined : true}
				onDragStart={row.pinned ? undefined : onDragStart}
				onDragEnd={onDragEnd}
				onDragOver={onDragOver}
				onDragLeave={onDragLeave}
				onDrop={onDrop}
				onClick={onClick}
				onKeyDown={onKeyDown}
				onPointerEnter={measureTitle}
				onFocus={measureTitle}
			>
				<i className="session-dot" aria-hidden="true" />
				<span className="session-title-wrap">
					<span className="session-title">{title}</span>
				</span>
				<span className="session-meta">
					{status === "running" || status === "waiting" || status === "failed" ? (
						<span className={cx("session-badge", status)}>{t(status)}</span>
					) : null}
					<time className="session-time">{formatRelativeTime(session.modified)}</time>
					{/* Escape belongs to the shell's chain. */}
					<Popover
						bare
						className="sidebar-menu session-menu"
						id="sessionMenu"
						placement="bottom-end"
						open={row.menuOpen}
						onClose={closeSessionMenu}
						dismissOn="click"
						closeOnEscape={false}
						content={<SessionMenu session={session} />}
					>
						{/* No hint while its menu is open: the menu already says what the button did. */}
						<Tooltip content={row.menuOpen ? null : t("moreActions")}>
							<IconButton
								className="session-menu-button"
								icon={LEGACY_ICONS.more.name}
								iconSize={LEGACY_ICONS.more.size}
								aria-label={t("moreActions")}
								aria-haspopup="menu"
								aria-expanded={row.menuOpen}
								aria-controls="sessionMenu"
								onClick={onMenuClick}
							/>
						</Tooltip>
					</Popover>
					{grouped ? null : (
						// Escape belongs to the shell's chain (the group name field closes the picker itself).
						<Popover
							bare
							className="sidebar-menu tag-picker"
							id="tagPicker"
							placement="bottom-end"
							open={row.tagPickerOpen}
							onClose={closeTagPicker}
							dismissOn="click"
							closeOnEscape={false}
							content={<TagPicker sessionId={session.id} />}
						>
							{/* No hint while the picker is open: the picker already says what the button did. */}
							<Tooltip content={row.tagPickerOpen ? null : t("setGroup")}>
								<IconButton
									className="session-tag-button"
									icon={LEGACY_ICONS.tag.name}
									iconSize={LEGACY_ICONS.tag.size}
									aria-label={t("setGroup")}
									aria-haspopup="menu"
									aria-expanded={row.tagPickerOpen}
									aria-controls="tagPicker"
									onClick={onTagButtonClick}
								/>
							</Tooltip>
						</Popover>
					)}
					{tag ? (
						<Tooltip content={row.tagName}>
							<button
								className="tag-diamond session-tag"
								type="button"
								style={cssVar("--tag-color", TAG_COLORS[tag])}
								aria-label={row.tagName}
								onClick={onTagClick}
							/>
						</Tooltip>
					) : null}
					{/* The row's last slot, after the hover actions, so every pin lines up at the
				    same right edge. A pinned row always shows its solid pin, so hovering the row
				    adds "…" and the tag button to its left without moving it; an unpinned row
				    shows the outline pin only on hover. Each icon swaps for the other while the
				    button itself is hovered, previewing the state a click leads to. */}
					<Tooltip content={row.pinned ? t("unpinSession") : t("pinSession")}>
						<IconButton
							className={row.pinned ? "session-pin" : "session-pin-action"}
							aria-label={row.pinned ? t("unpinSession") : t("pinSession")}
							onClick={onPinClick}
						>
							<Icon name="pinFilled" size="xs" className="session-pin-filled" />
							<Icon name="pin" size="xs" className="session-pin-outline" />
						</IconButton>
					</Tooltip>
				</span>
			</div>
		</Tooltip>
	);
}
