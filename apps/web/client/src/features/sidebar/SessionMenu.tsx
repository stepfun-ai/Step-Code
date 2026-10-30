import { useT } from "../../i18n";
import { runSessionAction, type SessionAction } from "../../state/session";
import { useAppStore } from "../../state/store";
import type { SessionSummary } from "../../state/types";
import { Icon } from "../../ui";
import { closeSessionMenu, toggleSessionPin } from "./actions";

/**
 * Content of `#sessionMenu`: pin / rename / archive / delete one session
 * (legacy app.js 1287-1329). Rendered by the sidebar's row menu and the
 * conversation header's; `onAction` lets a caller outside the sidebar close its
 * own menu.
 */
export function SessionMenu({
	session,
	onAction,
}: {
	readonly session: SessionSummary;
	readonly onAction?: () => void;
}) {
	const translate = useT();
	// Pinning is this reader's arrangement, kept in local storage, not a host write.
	const pinned = useAppStore((state) => state.pinnedSessions.includes(session.id));
	const close = () => {
		closeSessionMenu();
		onAction?.();
	};
	const run = (action: SessionAction) => {
		close();
		void runSessionAction(action, session);
	};
	return (
		<>
			<button
				type="button"
				data-action="pin"
				onClick={() => {
					close();
					toggleSessionPin(session.id);
				}}
			>
				<Icon name={pinned ? "pinFilled" : "pin"} size="sm" />
				{pinned ? translate("unpinSession") : translate("pinSession")}
			</button>
			<button type="button" data-action="rename" onClick={() => run("rename")}>
				<Icon name="pencil" size="sm" />
				{translate("rename")}
			</button>
			<button type="button" data-action="archive" onClick={() => run("archive")}>
				<Icon name={session.archived ? "undo" : "archive"} size="sm" />
				{session.archived ? translate("restore") : translate("archive")}
			</button>
			<button className="danger" type="button" data-action="delete" onClick={() => run("delete")}>
				<Icon name="trash" size="sm" />
				{translate("delete")}
			</button>
		</>
	);
}
