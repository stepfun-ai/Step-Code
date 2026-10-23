import { type DragEvent, type ReactNode, useState } from "react";
import { type TagColor, useT } from "../../i18n";
import { cx } from "../../lib/format";
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
	readonly name: string;
	readonly color: TagColor | null;
	readonly sessions: readonly SessionSummary[];
	readonly archived?: boolean;
}

/** One coloured section of the grouped view (legacy `buildGroupedSection`, 992-1012). */
function GroupedSection({ group, name, color, sessions, archived = false }: GroupedSectionProps) {
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
					<SessionRow key={session.id} session={session} grouped />
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
			hidden: state.currentView !== "group",
		}),
		shallowEqual,
	);
	const visible = view.sessions.filter((session) => !session.archived);
	const archived = view.sessions.filter((session) => session.archived);
	const sections: ReactNode[] = [];
	for (const color of TAG_COLOR_KEYS) {
		const group = view.groups.find((candidate) => candidate.key === color);
		if (!group) continue;
		const sessions = visible.filter((session) => view.tags.get(session.id) === color);
		if (!sessions.length) continue;
		sections.push(<GroupedSection key={color} group={group} name={group.name} color={color} sessions={sessions} />);
	}
	const ungrouped = visible.filter((session) => !view.tags.has(session.id));
	if (ungrouped.length) {
		sections.push(<GroupedSection key="ungrouped" name={t("ungrouped")} color={null} sessions={ungrouped} />);
	}
	if (archived.length) {
		sections.push(
			<GroupedSection key="archived" name={t("archivedConversations")} color={null} sessions={archived} archived />,
		);
	}
	return (
		<div className="grouped-view" id="groupedView" hidden={view.hidden}>
			{sections.length ? sections : <EmptyState>{t("noGroupedConversations")}</EmptyState>}
		</div>
	);
}
