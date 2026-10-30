/**
 * `.compaction-row`: a context compaction in the transcript.
 *
 * The kernel writes one `compaction` entry when it summarizes history. The row
 * reports what it replaced and stays collapsed by default, because the summary
 * is long and is the model's working context, not a reply. Opening it shows the
 * exact text the model now starts from. `live` is the compaction running right
 * now, which has no entry yet.
 *
 * It reads like the rest of the stream (`>_ compact · …`) instead of a system
 * banner: the same glyph, the same muted metadata, one chevron.
 */

import { useState } from "react";
import { useMarkdownLabels, useT } from "../../i18n";
import type { CompactionTimelineItem } from "../../state/types";
import { Icon, MarkdownView } from "../../ui";

function CompactionHeader({
	status,
	expanded,
	onToggle,
}: {
	readonly status: string;
	readonly expanded?: boolean;
	readonly onToggle?: () => void;
}) {
	const t = useT();
	const content = (
		<>
			<span className="compaction-glyph" aria-hidden="true">
				<Icon name="prompt" size="2xs" />
			</span>
			<span className="compaction-name">compact</span>
			<span className="compaction-separator" aria-hidden="true">
				·
			</span>
			<span className="compaction-status">{status}</span>
			{onToggle ? (
				<span className="compaction-chevron">
					<Icon name="chevronDown" size="2xs" />
				</span>
			) : null}
		</>
	);
	if (!onToggle) return <div className="compaction-head">{content}</div>;
	return (
		<button
			type="button"
			className="compaction-head"
			aria-expanded={expanded}
			aria-label={`${status} — ${t(expanded ? "compactionCollapse" : "compactionExpand")}`}
			onClick={onToggle}
		>
			{content}
		</button>
	);
}

/** The compacting run, shown until its `compaction` entry arrives. */
export function CompactionRunningRow() {
	const t = useT();
	return (
		<section className="compaction-row" data-running="true" aria-live="polite">
			<CompactionHeader status={t("compactionRunning")} />
		</section>
	);
}

export function CompactionRow({ item }: { readonly item: CompactionTimelineItem }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const labels = useMarkdownLabels();
	const tokens = Number.isFinite(item.tokensBefore) ? (item.tokensBefore as number).toLocaleString() : "";
	const status =
		item.removedMessages > 0
			? t("compactionCount", { count: item.removedMessages, tokens })
			: t("compactionTokens", { tokens });
	return (
		<section className="compaction-row" data-expanded={expanded || undefined}>
			<CompactionHeader status={status} expanded={expanded} onToggle={() => setExpanded((value) => !value)} />
			<div className="compaction-body" hidden={!expanded}>
				<MarkdownView source={item.summary} labels={labels} className="compaction-summary" />
			</div>
		</section>
	);
}
