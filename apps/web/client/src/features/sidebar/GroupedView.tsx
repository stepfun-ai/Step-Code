import { type DragEvent, type ReactNode, useState } from "react";
import { type TagColor, useT } from "../../i18n";
import { cx } from "../../lib/format";
import { orderedSessions } from "../../state/session-order";
import { shallowEqual, useAppStore } from "../../state/store";
import type { SessionSummary, TagGroup } from "../../state/types";
import { EmptyState, Icon, LEGACY_ICONS } from "../../ui";
import { setSessionTag } from "./actions";
import { GroupRenameInput } from "./GroupRenameInput";
import { SessionRow } from "./SessionRow";
import { cssVar, SESSION_DRAG_TYPE, TAG_COLOR_KEYS, TAG_COLORS } from "./tags";

interface GroupedSectionProps {
	/** Only real tag groups can rename; the ungrouped and archived sections have none. */
	readonly group?: TagGroup;
	/** The list id its rows reorder within: the tag colour, or `ungrouped` / `archived`. */
	readonly listId: string;
	/** The same rows in drawn order: the neighbours a reader can see, and the drag order. */
	readonly drawnIds: readonly string[];
	readonly name: string;
	readonly color: TagColor | null;
	readonly sessions: readonly SessionSummary[];
	readonly archived?: boolean;
}

/** One coloured section of the grouped view (legacy `buildGroupedSection`, 992-1012). */
function GroupedSection({ group, listId, drawnIds, name, color, sessions, archived = false }: GroupedSectionProps) {
	const t = useT();
	const [folded, setFolded] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [dropTarget, setDropTarget] = useState(false);
	const groupColor = archived ? "var(--ink-3)" : color ? TAG_COLORS[color] : "var(--line)";
	// Dropping a row on a section retags it with that group; the ungrouped
	// section's null colour clears the tag. The archive stays a folder, not a target.
	const onDragOver = (event: DragEvent<HTMLElement>) => {
		if (archived || !event.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		setDropTarget(true);
	};
	const onDrop = (event: DragEvent<HTMLElement>) => {
		const sessionId = event.dataTransfer.getData(SESSION_DRAG_TYPE);
		setDropTarget(false);
		if (archived || !sessionId) return;
		event.preventDefault();
		setSessionTag(sessionId, color);
	};
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: an HTML5 drop zone for dragged session rows; keyboard users retag via the tag picker.
		<section
			className={cx("group-section", archived && "archived-group", folded && "folded", dropTarget && "drop-target")}
			style={cssVar("--group-color", groupColor)}
			onDragOver={onDragOver}
			onDragLeave={() => setDropTarget(false)}
			onDrop={onDrop}
		>
			{group && renaming ? (
				<GroupRenameInput group={group} onDone={() => setRenaming(false)} />
			) : (
				// biome-ignore lint/a11y/noStaticElementInteractions: legacy heading is a plain clickable div.
				// biome-ignore lint/a11y/useKeyWithClickEvents: see above.
				<div className="group-heading" onClick={() => setFolded((value) => !value)}>
					{archived ? (
						<Icon {...LEGACY_ICONS.archive} />
					) : (
						<span
							className="tag-diamond"
							style={cssVar("--tag-color", color ? TAG_COLORS[color] : "var(--line-strong)")}
						/>
					)}
					<span>{name}</span>
					{group ? (
						<button
							type="button"
							className="group-rename-button"
							title={t("renameGroup")}
							aria-label={t("renameGroup")}
							onClick={(event) => {
								// The heading click folds the section; the pencil only renames.
								event.stopPropagation();
								setRenaming(true);
							}}
						>
							<Icon name="pencil" size="xs" />
						</button>
					) : null}
				</div>
			)}
			<i className="group-spine" />
			<div className="group-sessions">
				{sessions.map((session) => (
					<SessionRow key={session.id} session={session} listId={listId} drawnIds={drawnIds} grouped />
				))}
			</div>
		</section>
	);
}

/** `#groupedView` (legacy `renderGroupedView`, 957-990). */
export function GroupedView() {
	const t = useT();
	const view = useAppStore(
		(state) => ({
			sessions: state.sessions,
			groups: state.groups,
			tags: state.tags,
			pinnedSessions: state.pinnedSessions,
			sessionOrder: state.sessionOrder,
			hidden: state.currentView !== "group",
		}),
		shallowEqual,
	);
	// Pins lead inside their own section, and a dragged row keeps the place it was
	// given there (see state/session-order.ts); a section lists its rows in both
	// orders so a drag can edit the arrangement the section is drawn from.
	const active = view.sessions.filter((session) => !session.archived);
	const archived = view.sessions.filter((session) => session.archived);
	const sections: ReactNode[] = [];
	const push = (
		key: string,
		listId: string,
		name: string,
		color: TagColor | null,
		group: TagGroup | undefined,
		members: readonly SessionSummary[],
		isArchived = false,
	) => {
		if (!members.length) return;
		const ordered = orderedSessions(members, view.pinnedSessions, view.sessionOrder);
		sections.push(
			<GroupedSection
				key={key}
				group={group}
				listId={listId}
				drawnIds={ordered.map((session) => session.id)}
				name={name}
				color={color}
				sessions={ordered}
				archived={isArchived}
			/>,
		);
	};
	for (const color of TAG_COLOR_KEYS) {
		const group = view.groups.find((candidate) => candidate.key === color);
		if (!group) continue;
		push(
			color,
			`tag:${color}`,
			group.name,
			color,
			group,
			active.filter((session) => view.tags.get(session.id) === color),
		);
	}
	push(
		"ungrouped",
		"ungrouped",
		t("ungrouped"),
		null,
		undefined,
		active.filter((session) => !view.tags.has(session.id)),
	);
	push("archived", "archived", t("archivedConversations"), null, undefined, archived, true);
	return (
		<div className="grouped-view" id="groupedView" hidden={view.hidden}>
			{sections.length ? sections : <EmptyState>{t("noGroupedConversations")}</EmptyState>}
		</div>
	);
}
