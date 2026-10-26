import { useT } from "../../i18n";
import { basename } from "../../lib/format";
import { hostPlatform } from "../../platform/host";
import { sessionTitle } from "../../state/session";
import { setUi, shallowEqual, useAppStore } from "../../state/store";
import { Icon, IconButton, LEGACY_ICONS, Popover, Tooltip } from "../../ui";
import { SessionMenu } from "../sidebar/SessionMenu";
import { openWorkspaceFolder } from "../workspace/actions";

/** The file manager's own icon and name: Finder, File Explorer, or a plain folder elsewhere. */
const FILE_MANAGER = {
	darwin: { icon: "finder", label: "openWorkspaceInFinder" },
	win32: { icon: "folderWindows", label: "openWorkspaceInExplorer" },
	linux: { icon: "folder", label: "openWorkspaceFolder" },
} as const;

/**
 * `#sessionHeader`: the conversation's fixed title bar — what this session is, which project
 * folder it runs in and whether it is working. The branch is the composer's branch picker's job.
 * The more button after the title opens the rename / archive / delete menu (`#streamMenu`);
 * a draft has no session to act on yet, so it waits for the first real session. The trailing
 * button shows the project folder in Finder / File Explorer.
 */
export function SessionHeader() {
	const t = useT();
	const view = useAppStore((state) => {
		// The list summary carries the first message the snapshot lacks, so the bar names the session
		// exactly as its sidebar row does; its row is also what the more menu acts on.
		const row = state.current ? state.sessions.find((session) => session.id === state.current?.id) : undefined;
		return {
			title: state.current ? sessionTitle({ ...row, ...state.current }) : t("newConversation"),
			cwd: state.current?.cwd || state.draftCwd || state.bootstrapCwd,
			status: state.current?.status ?? "",
			session: state.current ? (row ?? state.current) : null,
			menuOpen: state.ui.streamMenu,
		};
	}, shallowEqual);
	const project = basename(view.cwd);
	const platform = hostPlatform();
	const manager = FILE_MANAGER[platform];
	return (
		<header className="session-header" id="sessionHeader">
			<h1 className="session-header-title" title={view.title}>
				{view.title}
			</h1>
			{view.session ? (
				// Escape belongs to the shell's chain.
				<Popover
					bare
					className="sidebar-menu session-menu"
					id="streamMenu"
					role="menu"
					aria-label={t("moreActions")}
					placement="bottom-end"
					open={view.menuOpen}
					onClose={() => setUi({ streamMenu: false })}
					dismissOn="click"
					closeOnEscape={false}
					content={<SessionMenu session={view.session} onAction={() => setUi({ streamMenu: false })} />}
				>
					{/* No hint while its menu is open: the menu already says what the button did. */}
					<Tooltip content={view.menuOpen ? null : t("moreActions")}>
						<IconButton
							className="session-header-menu-button"
							aria-label={t("moreActions")}
							aria-haspopup="menu"
							aria-expanded={view.menuOpen}
							aria-controls="streamMenu"
							onClick={() =>
								setUi((ui) => ({
									streamMenu: !ui.streamMenu,
									sessionMenu: null,
									workspaceMenu: null,
									tagPicker: null,
								}))
							}
						>
							<Icon {...LEGACY_ICONS.more} />
						</IconButton>
					</Tooltip>
				</Popover>
			) : null}
			{project ? (
				<span className="session-header-chip" title={view.cwd}>
					<Icon name="folder" size="xs" />
					{project}
				</span>
			) : null}
			{view.status ? (
				<span className="session-header-status" data-status={view.status}>
					<i aria-hidden="true" />
					{t(view.status)}
				</span>
			) : null}
			{view.cwd ? (
				<Tooltip content={t(manager.label)}>
					<IconButton
						className="session-header-open-folder"
						data-file-manager={platform}
						icon={manager.icon}
						iconSize="md"
						aria-label={`${t(manager.label)}: ${view.cwd}`}
						onClick={() => void openWorkspaceFolder(view.cwd)}
					/>
				</Tooltip>
			) : null}
		</header>
	);
}
