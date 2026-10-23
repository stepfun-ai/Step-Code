import { useT } from "../../i18n";
import { runSessionAction, type SessionAction } from "../../state/session";
import type { SessionSummary } from "../../state/types";
import { closeSessionMenu } from "./actions";

/**
 * Content of `#sessionMenu`: rename / archive / delete one session (legacy
 * app.js 1287-1329). Rendered by the sidebar's row menu and the conversation
 * header's; `onAction` lets a caller outside the sidebar close its own menu.
 */
export function SessionMenu({
	session,
	onAction,
}: {
	readonly session: SessionSummary;
	readonly onAction?: () => void;
}) {
	const translate = useT();
	const run = (action: SessionAction) => {
		closeSessionMenu();
		onAction?.();
		void runSessionAction(action, session);
	};
	return (
		<>
			<button type="button" data-action="rename" onClick={() => run("rename")}>
				{translate("rename")}
			</button>
			<button type="button" data-action="archive" onClick={() => run("archive")}>
				{session.archived ? translate("restore") : translate("archive")}
			</button>
			<button className="danger" type="button" data-action="delete" onClick={() => run("delete")}>
				{translate("delete")}
			</button>
		</>
	);
}
