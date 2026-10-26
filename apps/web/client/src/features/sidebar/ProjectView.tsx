import { useT } from "../../i18n";
import { shallowEqual, useAppStore } from "../../state/store";
import type { SessionSummary } from "../../state/types";
import { EmptyState, Icon } from "../../ui";
import { DraftRow, draftRowCwd } from "./DraftRow";
import { ProjectGroup } from "./ProjectGroup";
import { SessionRow } from "./SessionRow";

/**
 * `#projectView`: `#projectGroups` and `#recentGroup` (legacy
 * index.html 607-638, `renderSessionLists` 821-904 and the row filter of
 * `applyTagFilter` 929-955).
 */
export function ProjectView() {
	const t = useT();
	const view = useAppStore(
		(state) => ({
			sessions: state.sessions,
			workspaces: state.workspaces,
			showArchived: state.showArchived,
			foldedProjects: state.foldedProjects,
			tags: state.tags,
			filter: state.currentFilter,
			hidden: state.currentView !== "project",
		}),
		shallowEqual,
	);
	const draftCwd = useAppStore(draftRowCwd);
	const { showArchived, filter } = view;

	let projects = new Map<string, SessionSummary[]>();
	const recent: SessionSummary[] = [];
	const removed = new Set(view.workspaces.filter((workspace) => workspace.hidden).map((workspace) => workspace.path));
	// Registered workspaces stay listed even before their first conversation,
	// and a freshly added one (registry order is newest first) leads the list.
	const registered = new Set(
		view.workspaces
			.filter((workspace) => workspace.available && !workspace.hidden)
			.map((workspace) => workspace.path),
	);
	if (!showArchived) {
		const withSessions = new Set(view.sessions.filter((session) => !session.archived).map((session) => session.cwd));
		for (const cwd of registered) if (!withSessions.has(cwd)) projects.set(cwd, []);
	}
	for (const session of view.sessions) {
		if (session.archived !== showArchived) continue;
		if (!session.cwd || session.cwdAvailable === false || removed.has(session.cwd)) {
			recent.push(session);
			continue;
		}
		const sessions = projects.get(session.cwd) ?? [];
		sessions.push(session);
		projects.set(session.cwd, sessions);
	}

	// The draft placeholder joins its workspace's group, opening one for a workspace without
	// conversations; a draft in a removed workspace shows under Recent.
	const draftInRecent = draftCwd !== null && removed.has(draftCwd);
	if (draftCwd !== null && !draftInRecent && !projects.has(draftCwd)) {
		projects = new Map([[draftCwd, []], ...projects]);
	}

	const hiddenIds = new Set<string>();
	if (filter) {
		for (const session of view.sessions) if (view.tags.get(session.id) !== filter) hiddenIds.add(session.id);
	}

	return (
		<div id="projectView" hidden={view.hidden}>
			<div id="projectGroups">
				{[...projects].map(([cwd, sessions]) => (
					<ProjectGroup
						key={cwd}
						cwd={cwd}
						sessions={sessions}
						folded={view.foldedProjects.has(cwd)}
						hiddenIds={hiddenIds}
						draft={cwd === draftCwd}
						// With a filter, a group without a matching row is hidden (legacy applyTagFilter).
						filteredOut={
							Boolean(filter) && cwd !== draftCwd && sessions.every((session) => hiddenIds.has(session.id))
						}
					/>
				))}
				{projects.size ? null : (
					<EmptyState>
						{showArchived ? t("noArchivedProjectConversations") : t("noProjectConversations")}
					</EmptyState>
				)}
			</div>
			<div className="recent-group" id="recentGroup" hidden={recent.length === 0 && !draftInRecent}>
				<div className="project-label">
					<Icon name="clock" />
					<span>{t("recent")}</span>
				</div>
				<div id="recentTasks">
					{draftInRecent ? <DraftRow /> : null}
					{recent.map((session) => (
						<SessionRow key={session.id} session={session} filteredOut={hiddenIds.has(session.id)} />
					))}
				</div>
			</div>
		</div>
	);
}
