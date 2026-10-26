import type { MouseEvent } from "react";
import { useT } from "../../i18n";
import { basename, cx } from "../../lib/format";
import { startDraft } from "../../state/session";
import { useAppStore } from "../../state/store";
import type { SessionSummary } from "../../state/types";
import { EmptyState, Icon, IconButton, LEGACY_ICONS, Popover, Tooltip } from "../../ui";
import { openTree } from "../files/actions";
import { closeWorkspaceMenu, toggleProjectFolded, toggleWorkspaceMenu } from "./actions";
import { DraftRow } from "./DraftRow";
import { SessionRow } from "./SessionRow";
import { WorkspaceMenu } from "./WorkspaceMenu";

export interface ProjectGroupProps {
	readonly cwd: string;
	readonly sessions: readonly SessionSummary[];
	readonly folded: boolean;
	/** Session ids hidden by the tag filter. */
	readonly hiddenIds: ReadonlySet<string>;
	/** The whole group is hidden by the tag filter. */
	readonly filteredOut: boolean;
	/** The group lists the draft placeholder row of a just-started conversation first. */
	readonly draft?: boolean;
}

/** `section.project-group[data-cwd]` (legacy `renderSessionLists`, 848-885). */
export function ProjectGroup({ cwd, sessions, folded, hiddenIds, filteredOut, draft = false }: ProjectGroupProps) {
	const t = useT();
	const menuOpen = useAppStore((state) => state.ui.workspaceMenu?.cwd === cwd);
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
				<span className="project-name">{basename(cwd)}</span>
				<span className={cx("project-actions", menuOpen && "menu-open")}>
					{/* Escape belongs to the shell's chain, which also refocuses this button. */}
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
							<Icon {...LEGACY_ICONS.plus} />
						</IconButton>
					</Tooltip>
				</span>
			</div>
			<div className="project-sessions">
				<div>
					{draft ? <DraftRow /> : null}
					{sessions.map((session) => (
						<SessionRow key={session.id} session={session} filteredOut={hiddenIds.has(session.id)} />
					))}
					{sessions.length || draft ? null : (
						<EmptyState className="project-empty">{t("noConversationsYet")}</EmptyState>
					)}
				</div>
			</div>
		</section>
	);
}
