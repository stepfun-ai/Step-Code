import { useT } from "../../i18n";
import { knownWorkspaces, startDraft, workspaceLabel } from "../../state/session";
import { shallowEqual, useAppStore } from "../../state/store";
import { EmptyState, Icon, Popover } from "../../ui";
import { chooseWorkspaceFolder, closeWorkspacePopover, openWorkspacePopover } from "./actions";

/**
 * `#workspaceControl`: the draft's folder pill just above the composer card,
 * outside it. The popover lists the known workspaces, the current one
 * checked, then "Add workspace…". It opens downward over the prompt; when the
 * composer sits too close to the bottom of the window for the list to fit
 * there, it opens upward instead of running off screen.
 *
 * Hidden while a session is open. Before bootstrap there is no folder yet, and
 * `workspaceLabel()` would render its "recent" placeholder as if it were a
 * workspace name, so the neutral "Workspace" label stays until a real path
 * arrives. With no workspace on offer the label is "默认项目" — the folder new
 * work falls back to — not the folder's own last path segment.
 */
export function WorkspaceControl() {
	const t = useT();
	const view = useAppStore(
		(state) => ({
			hidden: Boolean(state.current),
			cwd: state.draftCwd || state.bootstrapCwd,
			// "默认项目" while no workspace is on offer, so the pill never names
			// the fallback folder after the last user or claims there is none.
			label: state.draftCwd || state.bootstrapCwd ? workspaceLabel(state, state.draftCwd || state.bootstrapCwd) : "",
			draftCwd: state.draftCwd,
			open: state.ui.workspacePopoverOpen,
		}),
		shallowEqual,
	);
	const workspaces = useAppStore(knownWorkspaces, shallowEqual);
	return (
		<div className="workspace-control" id="workspaceControl" hidden={view.hidden}>
			<Popover
				bare
				className="workspace-popover"
				id="workspacePopover"
				open={view.open}
				onClose={() => closeWorkspacePopover()}
				dismissOn="click"
				closeOnEscape={false}
				content={
					<>
						{/* An empty list has no folders to title: the reason is the state itself. */}
						{workspaces.length ? <div className="workspace-popover-title">{t("recentFolders")}</div> : null}
						{/* Keep the list's own name: the empty row inside it states the condition,
						    and a label repeating it would be announced twice. */}
						<div id="workspaceRecentList" role="listbox" aria-label={t("recentFolders")}>
							{workspaces.map((path) => (
								<RecentItem key={path} path={path} selected={path === view.draftCwd} />
							))}
							{workspaces.length ? null : <EmptyState>{t("noWorkspaces")}</EmptyState>}
						</div>
						<div className="workspace-popover-divider" />
						<button
							className="workspace-browse-button"
							id="workspaceBrowseButton"
							type="button"
							onClick={() => {
								closeWorkspacePopover();
								void chooseWorkspaceFolder();
							}}
						>
							<Icon name="plus" size="sm" />
							<span>{t("addWorkspaceEllipsis")}</span>
						</button>
					</>
				}
			>
				<button
					id="workspaceButton"
					className="workspace-pill"
					type="button"
					aria-haspopup="listbox"
					aria-expanded={view.open}
					aria-label={`${t("workspacePickerLabel")}: ${view.cwd ? view.label : "Workspace"}`}
					onClick={() => (view.open ? closeWorkspacePopover() : openWorkspacePopover())}
				>
					<Icon name="folder" size="sm" />
					<span id="workspaceButtonName">{view.cwd ? view.label : "Workspace"}</span>
					<Icon name="chevronDown" size="2xs" className="chevron" />
				</button>
			</Popover>
		</div>
	);
}

/** One workspace: its name; the full path is the tooltip, for same-named folders. */
function RecentItem({ path, selected }: { readonly path: string; readonly selected: boolean }) {
	const label = useAppStore((state) => workspaceLabel(state, path));
	return (
		<button
			type="button"
			role="option"
			aria-selected={selected}
			className={`workspace-recent-item${selected ? " selected" : ""}`}
			title={path}
			onClick={() => {
				startDraft(path);
				closeWorkspacePopover();
			}}
		>
			<Icon name="folder" size="sm" />
			<span>{label}</span>
			{selected ? <Icon name="check" size="sm" className="workspace-check" /> : null}
		</button>
	);
}
