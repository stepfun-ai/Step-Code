/**
 * `#warningsTrigger`: the composer's warning badge.
 *
 * Warnings nobody asked for (a background failure, a startup problem) arrive
 * as `ui.notify` notices; they are not transcript rows. A persistent
 * exclamation mark at the bottom of the conversation carries their count, and
 * opening it lists every such warning the current session collected, newest
 * first, with a per-row dismiss and one "clear all". A warning that answers the
 * user's own input stays in the transcript instead (see `state/notices.ts`).
 */

import { useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n";
import { badgeWarnings } from "../../state/notices";
import { dismissNotice, dismissWarnings } from "../../state/session";
import { useAppStore } from "../../state/store";
import { Button, Icon, IconButton, Popover, Tooltip } from "../../ui";

export function WarningsButton() {
	const t = useT();
	const notices = useAppStore((state) => state.notices);
	const sessionId = useAppStore((state) => state.current?.id);
	const [open, setOpen] = useState(false);
	const warnings = useMemo(() => badgeWarnings(notices, sessionId), [notices, sessionId]);

	// The badge disappears with the last warning; a panel left open over an empty
	// list would reopen by itself when the session records the next one.
	const empty = warnings.length === 0;
	useEffect(() => {
		if (empty) setOpen(false);
	}, [empty]);

	// The badge is an attention signal, not a permanent control: an empty list
	// leaves the composer row exactly as it was.
	if (sessionId === undefined || empty) return null;

	const label = t("warningsOpen", { count: warnings.length });
	const panel = (
		<div className="warnings-panel-body">
			<header className="warnings-panel-head">
				<strong>{t("warningsTitle", { count: warnings.length })}</strong>
				<Button className="warnings-clear" onClick={() => dismissWarnings(sessionId)}>
					{t("warningsClear")}
				</Button>
			</header>
			<ul className="warnings-list">
				{warnings.map((warning) => (
					<li key={warning.id} className="warnings-item">
						<p className="warnings-text">{warning.text}</p>
						<IconButton
							icon="closeSm"
							iconSize="xs"
							className="warnings-dismiss"
							aria-label={t("warningsDismiss")}
							onClick={() => dismissNotice(warning.id)}
						/>
					</li>
				))}
			</ul>
		</div>
	);

	return (
		<Popover
			open={open}
			onClose={() => setOpen(false)}
			content={panel}
			placement="top-start"
			className="warnings-panel"
		>
			<Tooltip content={open ? null : label}>
				<button
					type="button"
					id="warningsTrigger"
					className="warnings-trigger"
					aria-label={label}
					aria-expanded={open}
					onClick={() => setOpen((value) => !value)}
				>
					<Icon name="alert" size="sm" />
					<span className="warnings-count">{warnings.length}</span>
				</button>
			</Tooltip>
		</Popover>
	);
}
