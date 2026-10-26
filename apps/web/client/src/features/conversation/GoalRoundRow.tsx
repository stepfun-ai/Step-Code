/**
 * A goal round separator: the hidden continuation message that starts the
 * goal's next round, drawn as a quiet divider so a long-running goal reads as
 * rounds in the flow instead of one undifferentiated stream. The round's work
 * follows below it; the steering lives in the summary board.
 */

import { useT } from "../../i18n";
import type { GoalRoundTimelineItem } from "../../state/types";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

export function GoalRoundRow({ item }: { readonly item: GoalRoundTimelineItem }) {
	const t = useT();
	const time =
		item.timestamp && !Number.isNaN(Date.parse(item.timestamp))
			? timeFormat.format(new Date(item.timestamp))
			: undefined;
	return (
		<div className="goal-round-row">
			<span className="goal-round-label">
				{t("goalRounds", { rounds: item.round })}
				{time ? ` · ${time}` : ""}
			</span>
		</div>
	);
}
