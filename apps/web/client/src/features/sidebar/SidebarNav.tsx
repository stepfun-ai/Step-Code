import { useT } from "../../i18n";
import { isMacPlatform } from "../../lib/format";
import { activeCwd, startDraft } from "../../state/session";
import { shallowEqual, useAppStore } from "../../state/store";
import { Icon, IconButton, Kbd, SegmentedControl, Tooltip } from "../../ui";
import { openMidView } from "../market";
import { chooseWorkspaceFolder } from "../workspace/actions";
import { applyTagFilter, openSearch, switchConversationView, toggleArchived, toggleSidebar } from "./actions";
import { GroupedView } from "./GroupedView";
import { ProjectView } from "./ProjectView";
import { cssVar, groupName, TAG_COLORS } from "./tags";

/** `.brand-row` (legacy index.html 539-555). */
export function BrandRow() {
	return (
		<div className="brand-row">
			<div className="brand">
				<span className="brand-mark" aria-hidden="true">
					<Icon name="stepcode" />
				</span>
				<strong>Step Code</strong>
			</div>
			<IconButton
				id="sidebarToggle"
				title="收起侧边栏 ⌘B"
				aria-label="收起侧边栏"
				icon="sidebar"
				onClick={toggleSidebar}
			/>
		</div>
	);
}

/** `nav.sidebar-actions`: new conversation and the search launcher (legacy index.html 557-576). */
export function SidebarActions() {
	const t = useT();
	const midView = useAppStore((state) => state.ui.midView);
	return (
		<nav className="sidebar-actions" aria-label="会话操作">
			<button
				className="sidebar-action primary"
				id="newSession"
				type="button"
				onClick={() => startDraft(activeCwd())}
			>
				<Icon name="newChat" />
				<span>{t("newConversation")}</span>
			</button>
			<button
				className="sidebar-action"
				id="cronButton"
				type="button"
				aria-current={midView === "cron" ? "page" : undefined}
				title={t("cronTasks")}
				onClick={() => openMidView("cron")}
			>
				<Icon name="clock" />
				<span>{t("cronTasks")}</span>
			</button>
			<button
				className="sidebar-action"
				id="marketButton"
				type="button"
				aria-current={midView === "market" ? "page" : undefined}
				title={t("pluginMarket")}
				onClick={() => openMidView("market")}
			>
				<Icon name="pluginMarket" />
				<span>{t("pluginMarket")}</span>
			</button>
			<button
				className="sidebar-search"
				id="searchPlaceholder"
				type="button"
				title={t("search")}
				onClick={openSearch}
			>
				<Icon name="search" />
				<span>{t("search")}</span>
				<Kbd bare>⌘K</Kbd>
			</button>
		</nav>
	);
}

/** `#tagFilter`: the active tag filter of the project view (legacy index.html 597-603, `applyTagFilter`). */
function TagFilter() {
	const filter = useAppStore(
		(state) => ({
			key: state.currentFilter,
			name: state.currentFilter ? groupName(state.groups, state.currentFilter) : "",
			hidden: !state.currentFilter || state.currentView !== "project",
		}),
		shallowEqual,
	);
	return (
		<div className="tag-filter" id="tagFilter" hidden={filter.hidden}>
			<button className="filter-chip" id="tagFilterChip" type="button" onClick={() => applyTagFilter(null)}>
				<span
					className="tag-diamond"
					id="tagFilterDiamond"
					style={filter.key ? cssVar("--tag-color", TAG_COLORS[filter.key]) : undefined}
				/>
				<span id="tagFilterName">{filter.name}</span>
				<span>×</span>
			</button>
		</div>
	);
}

/** `⌥⌘O` on macOS, `Ctrl+Alt+O` elsewhere (legacy `applyLocale` chord, 582-583). */
function chord(key: string): string {
	return isMacPlatform() ? `⌥⌘${key}` : `Ctrl+Alt+${key}`;
}

/**
 * `section.conversation-list`: one compact header row (view tabs on the left,
 * add-workspace and archive on the right, remote commit 4aea0f8), the tag
 * filter, then the project and grouped views (legacy index.html 578-640).
 */
export function ConversationList() {
	const t = useT();
	const view = useAppStore(
		(state) => ({ current: state.currentView, showArchived: state.showArchived, pickingFolder: state.pickingFolder }),
		shallowEqual,
	);
	return (
		<section className="conversation-list" aria-label="会话列表">
			<div className="list-header-row">
				<SegmentedControl
					bare
					className="view-tabs"
					itemClassName="view-tab"
					selection="class"
					value={view.current}
					onChange={(value) => switchConversationView(value)}
					items={[
						{ value: "project", label: t("projects"), attrs: { "data-view": "project" } },
						{ value: "group", label: t("groups"), attrs: { "data-view": "group" } },
					]}
				/>
				<div className="list-header-actions">
					<Tooltip content={`${t("addWorkspace")} ${chord("O")}`}>
						<IconButton
							className="list-mode-button list-action"
							id="addWorkspace"
							aria-label={t("addWorkspace")}
							aria-keyshortcuts="Alt+Meta+O"
							aria-busy={view.pickingFolder ? "true" : undefined}
							onClick={() => void chooseWorkspaceFolder()}
						>
							<Icon name="folderPlus" size="md" />
						</IconButton>
					</Tooltip>
					<Tooltip content={view.showArchived ? t("archiveClose") : t("archivedTooltip")}>
						<IconButton
							className={
								view.showArchived ? "list-mode-button list-action active" : "list-mode-button list-action"
							}
							id="archiveToggle"
							aria-label={view.showArchived ? t("archiveClose") : t("archivedTooltip")}
							aria-pressed={view.showArchived}
							onClick={toggleArchived}
						>
							{/* While the archive is shown, the same button closes it. */}
							<Icon name={view.showArchived ? "close" : "archive"} size="md" />
						</IconButton>
					</Tooltip>
				</div>
			</div>
			<TagFilter />
			<ProjectView />
			<GroupedView />
		</section>
	);
}
