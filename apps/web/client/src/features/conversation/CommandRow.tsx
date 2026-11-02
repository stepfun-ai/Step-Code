/**
 * A kernel slash command the user sent, echoed in the stream.
 *
 * Slash commands run without a user message, so this row is the transcript's
 * only record of the typed line. It renders like any other user message: the
 * ordinary right-aligned bubble, with the command as a kind badge (the same
 * pattern a `/skill:` invocation already uses) followed by the arguments as
 * the message body. A bare command has no body — just the badge.
 */

import { type ReactNode, useMemo } from "react";
import { useT } from "../../i18n";
import { type AttachedFile, FILE_MARKER, markAttachedFiles, splitAttachedFiles } from "../../lib/attached-files";
import { setUi } from "../../state/store";
import type { CommandTimelineItem } from "../../state/types";
import { Icon } from "../../ui";
import { commandLeadIcon, MODES, modeFromCommand } from "../composer";
import { CopyAction } from "./CopyAction";
import { MessageFileChip } from "./MessageItem";

/** The arguments as plain text with each attached file as its chip, where the user put it. */
function commandBody(args: string, files: readonly AttachedFile[]): ReactNode[] {
	if (!files.length) return args ? [args] : [];
	const marked = markAttachedFiles(args, files);
	const body: ReactNode[] = [];
	let position = 0;
	for (const marker of marked.matchAll(FILE_MARKER)) {
		if (marker.index > position) body.push(marked.slice(position, marker.index));
		// The marker's offset is stable for this text, so it keys the chip.
		body.push(<MessageFileChip key={marker.index} file={files[Number(marker[1])]} />);
		position = marker.index + marker[0].length;
	}
	if (position < marked.length) body.push(marked.slice(position));
	return body;
}

export function CommandRow({
	item,
	rewritableBefore,
}: {
	readonly item: CommandTimelineItem;
	readonly rewritableBefore?: string;
}) {
	const t = useT();
	// Files sent with the command (`/goal` + a dropped file) arrive as blocks after its line; show them as chips.
	const attached = useMemo(() => splitAttachedFiles(item.command), [item.command]);
	const match = /^\/([A-Za-z0-9][\w.:-]*)\s*([\s\S]*)$/u.exec(attached.text);
	const name = match?.[1] ?? "";
	const args = (match?.[2] ?? "").trim();
	const body = useMemo(() => commandBody(args, attached.files), [args, attached.files]);
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
	if (!body.length) return badge;
	return (
		<article className="message user">
			{/* The badge rides inside the bubble, inline before the text — the same
			 * prefix position the lead chip had in the input. */}
			<div className="message-body">
				{badge}
				{body}
			</div>
			{/* The same action row an ordinary user bubble carries: copy what was typed, not the file blocks. */}
			<div className="prompt-actions">
				<CopyAction value={attached.text} />
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
