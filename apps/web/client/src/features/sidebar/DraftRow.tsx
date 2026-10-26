import type { KeyboardEvent } from "react";
import { useT } from "../../i18n";
import { requestPromptFocus } from "../../state/session";
import { type AppState, useAppStore } from "../../state/store";

/**
 * Workspace whose sidebar list shows the draft placeholder, or null. The row exists only while the user
 * is on the draft they asked for: no session is open or loading, and no mid view covers the pane.
 */
export function draftRowCwd(state: AppState): string | null {
	const { draftRow, openingSession, midView } = state.ui;
	if (!draftRow || state.current || openingSession || midView || state.showArchived) return null;
	return draftRow;
}

/**
 * `.draft-row[data-draft-row]`: the "New conversation" the user just started. It has no session id yet (the host
 * creates the session on the first send), so it has no menus; activating it returns focus to the prompt.
 */
export function DraftRow() {
	const t = useT();
	const visible = useAppStore((state) => draftRowCwd(state) !== null);
	if (!visible) return null;
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			requestPromptFocus();
		}
	};
	return (
		// biome-ignore lint/a11y/useSemanticElements: matches the session rows, which are div[role=button].
		<div
			// Not `.session-row`: tests and other features read that class as "a saved session with an id".
			className="draft-row active"
			role="button"
			tabIndex={0}
			aria-current="true"
			data-draft-row=""
			onClick={requestPromptFocus}
			onKeyDown={onKeyDown}
		>
			<i className="session-dot" aria-hidden="true" />
			<span className="session-title-wrap">
				<span className="session-title">{t("newConversation")}</span>
			</span>
			<span className="session-meta" />
		</div>
	);
}
