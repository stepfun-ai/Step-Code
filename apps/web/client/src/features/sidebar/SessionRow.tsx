import { type DragEvent, type KeyboardEvent, type MouseEvent, useState } from "react";
import { formatRelativeTime, useRelativeTimeClock, useT } from "../../i18n";
import { cx } from "../../lib/format";
import { openSession, sessionTitle, taskStatus } from "../../state/session";
import { mapWith, setState, shallowEqual, useAppStore } from "../../state/store";
import type { SessionSummary } from "../../state/types";
import { Icon, LEGACY_ICONS, Popover } from "../../ui";
import { applyTagFilter, closeSessionMenu, closeTagPicker, toggleSessionMenu, toggleTagPicker } from "./actions";
import { SessionMenu } from "./SessionMenu";
import { TagPicker } from "./TagPicker";
import { cssVar, groupName, SESSION_DRAG_TYPE, TAG_COLORS } from "./tags";

export interface SessionRowProps {
	readonly session: SessionSummary;
	/** Rows of the grouped view have no tag button (legacy `buildSessionRow(session, true)`). */
	readonly grouped?: boolean;
	/** Hidden by the project view's tag filter (legacy `row.style.display = "none"`). */
	readonly filteredOut?: boolean;
}

/** One conversation row (legacy `buildSessionRow`, 760-819). */
export function SessionRow({ session, grouped = false, filteredOut = false }: SessionRowProps) {
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
			tag,
			tagName: tag ? groupName(state.groups, tag) : "",
			view: state.currentView,
			filter: state.currentFilter,
			menuOpen: inView && state.ui.sessionMenu?.sessionId === session.id,
			tagPickerOpen: inView && state.ui.tagPicker?.sessionId === session.id,
		};
	}, shallowEqual);
	const { status, tag } = row;

	const open = () => {
		setState((state) => ({ unreadById: mapWith(state.unreadById, session.id, false) }));
		void openSession(session.id);
	};
	const onClick = (event: MouseEvent<HTMLDivElement>) => {
		if ((event.target as Element).closest(".session-menu-button,.session-tag-button,.session-tag")) return;
		open();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		// Only the row itself: Enter on a nested button must activate that button.
		if (event.target !== event.currentTarget) return;
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
	const onTagClick = (event: MouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		if (row.view === "project" && tag) applyTagFilter(row.filter === tag ? null : tag);
	};
	// Only the grouped view drags: it is the view where the drop targets (group sections) live.
	const [dragging, setDragging] = useState(false);
	const onDragStart = (event: DragEvent<HTMLDivElement>) => {
		event.dataTransfer.setData(SESSION_DRAG_TYPE, session.id);
		event.dataTransfer.effectAllowed = "move";
		setDragging(true);
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: the legacy row is a div[role=button] holding its own buttons, which a <button> cannot contain.
		<div
			className={cx("session-row", status, row.active && "active", row.unread && "unread", dragging && "dragging")}
			role="button"
			tabIndex={0}
			data-session-id={session.id}
			style={filteredOut ? { display: "none" } : undefined}
			draggable={grouped || undefined}
			onDragStart={grouped ? onDragStart : undefined}
			onDragEnd={grouped ? () => setDragging(false) : undefined}
			onClick={onClick}
			onKeyDown={onKeyDown}
		>
			<i className="session-dot" aria-hidden="true" />
			<span className="session-title-wrap">
				<span className="session-title">{sessionTitle(session)}</span>
			</span>
			<span className="session-meta">
				{status === "running" || status === "waiting" || status === "failed" ? (
					<span className={cx("session-badge", status)}>{t(status)}</span>
				) : null}
				<time className="session-time">{formatRelativeTime(session.modified)}</time>
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
						<button
							className="session-tag-button"
							type="button"
							title={t("setGroup")}
							aria-label={t("setGroup")}
							aria-haspopup="menu"
							aria-expanded={row.tagPickerOpen}
							aria-controls="tagPicker"
							onClick={onTagButtonClick}
						>
							<Icon {...LEGACY_ICONS.tag} />
						</button>
					</Popover>
				)}
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
					<button
						className="session-menu-button"
						type="button"
						title={t("moreActions")}
						aria-label={t("moreActions")}
						aria-haspopup="menu"
						aria-expanded={row.menuOpen}
						aria-controls="sessionMenu"
						onClick={onMenuClick}
					>
						<Icon {...LEGACY_ICONS.more} />
					</button>
				</Popover>
				{tag ? (
					<button
						className="tag-diamond session-tag"
						type="button"
						style={cssVar("--tag-color", TAG_COLORS[tag])}
						title={row.tagName}
						aria-label={row.tagName}
						onClick={onTagClick}
					/>
				) : null}
			</span>
		</div>
	);
}
