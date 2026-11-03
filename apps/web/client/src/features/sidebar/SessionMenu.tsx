import { useT } from "../../i18n";
import { runSessionAction, type SessionAction } from "../../state/session";
import { useAppStore } from "../../state/store";
import type { SessionSummary } from "../../state/types";
import { Icon, Popover } from "../../ui";
import { closeSessionMenu, closeTagPicker, openTagPicker, toggleSessionPin } from "./actions";
import { TagPicker } from "./TagPicker";

/**
 * Content of `#sessionMenu`: move to group / pin / rename / archive / delete one
 * session (legacy app.js 1287-1329). Rendered by the sidebar's row menu and the
 * conversation header's; `onAction` lets a caller outside the sidebar close its
 * own menu. Only the sidebar passes `groups`: its first row, "Move to group",
 * opens `#tagPicker` as a submenu beside it (on hover or click), and the menu
 * stays open behind it.
 */
export function SessionMenu({
	session,
	onAction,
	groups = false,
}: {
	readonly session: SessionSummary;
	readonly onAction?: () => void;
	readonly groups?: boolean;
}) {
	const translate = useT();
	// Pinning is this reader's arrangement, kept in local storage, not a host write.
	const pinned = useAppStore((state) => state.pinnedSessions.includes(session.id));
	const submenuOpen = useAppStore((state) => groups && state.ui.tagPicker?.sessionId === session.id);
	const close = () => {
		closeSessionMenu();
		onAction?.();
	};
	const run = (action: SessionAction) => {
		close();
		void runSessionAction(action, session);
	};
	// Pointing at another row leaves the submenu, as in a native menu.
	const leaveSubmenu = groups ? closeTagPicker : undefined;
	return (
		<>
			{groups ? (
				// The outer menu owns outside clicks and the shell owns Escape (submenu first).
				<Popover
					bare
					className="sidebar-menu tag-picker session-submenu"
					id="tagPicker"
					placement="right-start"
					open={submenuOpen}
					onClose={closeTagPicker}
					dismissOn={false}
					closeOnEscape={false}
					content={<TagPicker sessionId={session.id} />}
				>
					<button
						type="button"
						data-action="group"
						className={submenuOpen ? "open" : undefined}
						aria-haspopup="menu"
						aria-expanded={submenuOpen}
						aria-controls="tagPicker"
						onPointerEnter={() => openTagPicker(session.id)}
						onClick={() => openTagPicker(session.id)}
					>
						<Icon name="tag" size="sm" />
						<span className="session-menu-label">{translate("moveToGroup")}</span>
						<Icon name="chevronRight" size="xs" className="session-menu-trailing" />
					</button>
				</Popover>
			) : null}
			<button
				type="button"
				data-action="pin"
				onPointerEnter={leaveSubmenu}
				onClick={() => {
					close();
					toggleSessionPin(session.id);
				}}
			>
				<Icon name={pinned ? "pinFilled" : "pin"} size="sm" />
				{pinned ? translate("unpinSession") : translate("pinSession")}
			</button>
			<button type="button" data-action="rename" onPointerEnter={leaveSubmenu} onClick={() => run("rename")}>
				<Icon name="pencil" size="sm" />
				{translate("rename")}
			</button>
			<button type="button" data-action="archive" onPointerEnter={leaveSubmenu} onClick={() => run("archive")}>
				<Icon name={session.archived ? "undo" : "archive"} size="sm" />
				{session.archived ? translate("restore") : translate("archive")}
			</button>
			<button
				className="danger"
				type="button"
				data-action="delete"
				onPointerEnter={leaveSubmenu}
				onClick={() => run("delete")}
			>
				<Icon name="trash" size="sm" />
				{translate("delete")}
			</button>
		</>
	);
}
