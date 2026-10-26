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
import { copyText } from "../../state/session";
import { setUi } from "../../state/store";
import type { CommandTimelineItem } from "../../state/types";
import { Icon, LEGACY_ICONS } from "../../ui";
import { commandLeadIcon, MODES, modeFromCommand } from "../composer";

export function CommandRow({
	item,
	rewritableBefore,
}: {
	readonly item: CommandTimelineItem;
	readonly rewritableBefore?: string;
}) {
	const t = useT();
	const match = /^\/([A-Za-z0-9][\w.:-]*)\s*([\s\S]*)$/u.exec(item.command);
	const name = match?.[1] ?? "";
	const args = (match?.[2] ?? "").trim();
	const mode = modeFromCommand(name.replace(/:$/u, ""));
	const meta = mode ? MODES.find((entry) => entry.id === mode) : undefined;
	const badge = (
		<span className={mode ? `message-skill message-skill--${mode}` : "message-skill message-skill--command"}>
			{/* The model output's own glyph: the tool rows' 16px grid, not bespoke markup. */}
			<span className="tool-glyph" aria-hidden="true">
				<Icon className="tool-kind-icon" name={meta?.icon ?? commandLeadIcon(name)} size="xs" />
			</span>
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
			{/* The same action row an ordinary user bubble carries: copy what was sent. */}
			<div className="prompt-actions">
				<button
					type="button"
					className="message-action"
					title={t("copy")}
					aria-label={t("copy")}
					onClick={() => void copyText(item.command)}
				>
					<Icon {...LEGACY_ICONS.copy} />
				</button>
				{rewritableBefore !== undefined ? (
					<button
						type="button"
						className="message-action"
						title={t("promptRewrite")}
						aria-label={t("promptRewrite")}
						onClick={() =>
							item.entryId
								? setUi({
										editingPrompt: {
											entryId: item.entryId,
											before: rewritableBefore || undefined,
											text: item.command,
										},
									})
								: undefined
						}
					>
						<Icon name="squarePen" size="xs" />
					</button>
				) : null}
			</div>
		</article>
	);
}
