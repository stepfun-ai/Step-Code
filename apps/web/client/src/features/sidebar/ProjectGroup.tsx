import type { MouseEvent } from "react";
import { useT } from "../../i18n";
import { basename, cx } from "../../lib/format";
import { isDefaultWorkspace, startDraft } from "../../state/session";
import { shallowEqual, useAppStore } from "../../state/store";
import type { SessionSummary } from "../../state/types";
import { Button, EmptyState, Icon, IconButton, LEGACY_ICONS, Popover, Tooltip } from "../../ui";
import { openTree } from "../files/actions";
import { closeWorkspaceMenu, toggleProjectExpanded, toggleProjectFolded, toggleWorkspaceMenu } from "./actions";
import { collapsedRows } from "./collapse";
import { DraftRow } from "./DraftRow";
import { SessionRow } from "./SessionRow";
import { WorkspaceMenu } from "./WorkspaceMenu";

export interface ProjectGroupProps {
	readonly cwd: string;
	/** The group's rows in drawn order (pinned first). */
	readonly sessions: readonly SessionSummary[];
	/** The rows the tag filter leaves visible, in drawn order. */
	readonly drawnIds: readonly string[];
	readonly folded: boolean;
	/** Session ids hidden by the tag filter. */
	readonly hiddenIds: ReadonlySet<string>;
	/** The whole group is hidden by the tag filter. */
	readonly filteredOut: boolean;
	/** The group lists the draft placeholder row of a just-started conversation first. */
	readonly draft?: boolean;
	/**
	 * This group is the folder new work falls back to, not a workspace the user
	 * registered. It is named "默认项目" and cannot be removed: removal would only
	 * move the fallback, never the work already recorded here.
	 */
	readonly defaultProject?: boolean;
}

/** `section.project-group[data-cwd]` (legacy `renderSessionLists`, 848-885). */
export function ProjectGroup({
	cwd,
	sessions,
	drawnIds,
	folded,
	hiddenIds,
	filteredOut,
	draft = false,
	defaultProject = false,
}: ProjectGroupProps) {
	const t = useT();
	const menuOpen = useAppStore((state) => state.ui.workspaceMenu?.cwd === cwd);
	const defaultWorkspace = useAppStore((state) => isDefaultWorkspace(state, cwd));
	const collapse = useAppStore(
		(state) => ({
			expanded: state.expandedProjects.has(cwd),
			pinnedIds: state.pinnedSessions,
			// While another session loads, its row is already the selection (as in SessionRow).
			activeId: state.ui.openingSession ?? state.current?.id ?? null,
		}),
		shallowEqual,
	);
	// A long group shows its first rows (pins included) until the reader asks for the rest.
	const { shownIds, hiddenCount, collapsible } = collapsedRows(
		drawnIds,
		collapse.pinnedIds,
		collapse.activeId,
		collapse.expanded,
	);
	const shown = new Set(shownIds);
	const action = (run: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		closeWorkspaceMenu();
		run();
	};
	return (
		<section
			className={cx("project-group", folded && "folded")}
			data-cwd={cwd}
			style={filteredOut ? { display: "none" } : undefined}
		>
			{/* The whole bar toggles the group; no separate disclosure control (legacy markup). */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: legacy header is a plain clickable div; its buttons stay keyboard reachable. */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: see above. */}
			<div className="project-header" onClick={() => toggleProjectFolded(cwd)}>
				<Icon {...LEGACY_ICONS.folder} />
				<span className="project-name">
					{defaultProject ? t("defaultProject") : defaultWorkspace ? t("defaultWorkspace") : basename(cwd)}
				</span>
				<span className={cx("project-actions", menuOpen && "menu-open")}>
					{/* Escape belongs to the shell's chain, which also refocuses this button. */}
					{/* The fallback folder is not a registered workspace, so there is nothing
					    to remove; its other actions stay. */}
					{defaultProject ? null : (
						<Popover
							bare
							className="sidebar-menu"
							id="workspaceMenu"
							role="menu"
							aria-label={t("moreActions")}
							placement="bottom-end"
							open={menuOpen}
							onClose={() => closeWorkspaceMenu()}
							dismissOn="click"
							closeOnEscape={false}
							content={<WorkspaceMenu cwd={cwd} />}
						>
							{/* No hint while its menu is open: the menu already says what the button did. */}
							<Tooltip content={menuOpen ? null : t("moreActions")}>
								<IconButton
									className="project-action workspace-menu-button"
									aria-label={t("moreActions")}
									aria-haspopup="menu"
									aria-expanded={menuOpen}
									aria-controls="workspaceMenu"
									onClick={(event) => {
										event.stopPropagation();
										toggleWorkspaceMenu(cwd);
									}}
								>
									<Icon {...LEGACY_ICONS.more} />
								</IconButton>
							</Tooltip>
						</Popover>
					)}
					<Tooltip content={t("fileTree")}>
						<IconButton
							className="project-action tree-button"
							aria-label={t("fileTree")}
							onClick={action(() => void openTree({ cwd }))}
						>
							<Icon {...LEGACY_ICONS.tree} />
						</IconButton>
					</Tooltip>
					<Tooltip content={t("newConversationInWorkspace")}>
						<IconButton
							className="project-action new-project-session"
							aria-label={t("newConversationInWorkspace")}
							onClick={action(() => startDraft(cwd, { listed: true }))}
						>
							<Icon name="newChat" size="sm" />
						</IconButton>
					</Tooltip>
				</span>
			</div>
			<div className="project-sessions">
				<div>
					{draft ? <DraftRow /> : null}
					{sessions.map((session) =>
						// A tag-filtered row stays mounted and hidden; a row past the fold is not drawn.
						hiddenIds.has(session.id) || shown.has(session.id) ? (
							<SessionRow
								key={session.id}
								session={session}
								listId={cwd}
								drawnIds={shownIds}
								listIds={drawnIds}
								filteredOut={hiddenIds.has(session.id)}
							/>
						) : null,
					)}
					{collapsible ? (
						<Button
							className="project-more-sessions"
							aria-expanded={collapse.expanded}
							onClick={() => toggleProjectExpanded(cwd)}
						>
							{collapse.expanded ? t("showFewerSessions") : t("showMoreSessions", { count: hiddenCount })}
						</Button>
					) : null}
					{sessions.length || draft ? null : (
						<EmptyState className="project-empty">{t("noConversationsYet")}</EmptyState>
					)}
				</div>
			</div>
		</section>
	);
}
