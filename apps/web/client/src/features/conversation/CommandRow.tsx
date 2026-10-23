/**
 * A kernel slash command the user sent, echoed in the stream.
 *
 * Slash commands run without a user message, so this row is the transcript's
 * only record of the typed line. It renders like any other user message: the
 * ordinary right-aligned bubble, with the command as a kind badge (the same
 * pattern a `/skill:` invocation already uses) followed by the arguments as
 * the message body. A bare command has no body — just the badge.
 */

import { useT } from "../../i18n";
import type { CommandTimelineItem } from "../../state/types";
import { Icon } from "../../ui";
import { commandLeadIcon, MODES, modeFromCommand } from "../composer";
import { clockTime } from "./message-meta";

export function CommandRow({ item }: { readonly item: CommandTimelineItem }) {
	const t = useT();
	const match = /^\/([A-Za-z0-9][\w.:-]*)\s*([\s\S]*)$/u.exec(item.command);
	const name = match?.[1] ?? "";
	const args = (match?.[2] ?? "").trim();
	const mode = modeFromCommand(name.replace(/:$/u, ""));
	const meta = mode ? MODES.find((entry) => entry.id === mode) : undefined;
	const badge = (
		<span className={mode ? `message-skill message-skill--${mode}` : "message-skill message-skill--command"}>
			<Icon name={meta?.icon ?? commandLeadIcon(name)} size="xs" />
			{meta ? t(meta.labelKey) : `/${name}`}
		</span>
	);
	// Nothing was typed past the command: the badge alone, no empty bubble.
	if (!args) return badge;
	return (
		<article className="message user">
			{/* The badge rides inside the bubble, inline before the text — the same
			 * prefix position the lead chip had in the input. */}
			<div className="message-body">
				{badge}
				{args}
			</div>
			{item.timestamp ? (
				<span className="message-meta">
					<time className="message-meta-time" dateTime={item.timestamp}>
						{clockTime(item.timestamp)}
					</time>
				</span>
			) : null}
		</article>
	);
}
