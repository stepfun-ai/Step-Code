import { memo, useEffect, useId, useRef, useState } from "react";
import { useMarkdownLabels, useT } from "../../i18n";
import { copyText } from "../../state/session";
import { thinkingElapsed } from "../../state/thinking-timing";
import type { ThinkingTimelineItem } from "../../state/types";
import { Icon, MarkdownView } from "../../ui";
import { useSmoothText, useTypewriter } from "./streaming";
import { thinkingPreview } from "./thinking-preview";

const copyCode = (code: string) => copyText(code, null);

/** Folded by default inside the Simple process group; only an actual live block animates. */
export const ThinkingDisclosure = memo(function ThinkingDisclosure({
	item,
	active = false,
	onExpandedChange,
}: {
	readonly item: ThinkingTimelineItem;
	readonly active?: boolean;
	/** Preserve the reader's disclosure choice when a singleton gains siblings. */
	readonly onExpandedChange?: (expanded: boolean) => void;
}) {
	const t = useT();
	const running = active && item.running;
	const [expanded, setExpanded] = useState(false);
	// The reader may linger over the preview line: hold it while the pointer or the
	// keyboard focus is on the row, so a sentence can be finished without it moving.
	const [held, setHeld] = useState(false);
	const wasRunning = useRef(running);
	const id = useId();
	const text = useSmoothText(item.content, running);
	const labels = useMarkdownLabels();
	useEffect(() => {
		if (wasRunning.current && !running) setExpanded(false);
		wasRunning.current = running;
	}, [running]);
	const label = t(running ? "thinkingIndicator" : "thinkingLabel");
	// A sentence-aligned window that only grows at its tail, revealed at a reading
	// pace, instead of the trailing-character slice that used to sweep the line.
	const preview = running ? thinkingPreview(item.content) : undefined;
	const previewText = useTypewriter(preview?.text ?? "", Boolean(preview), preview?.key, held);
	return (
		<section className="thinking" data-entry-id={item.entryId} data-running={running} data-expanded={expanded}>
			<button
				type="button"
				className={`thinking-summary tool-row${running ? " pending" : ""}`}
				aria-expanded={expanded}
				aria-controls={id}
				onClick={() => {
					setExpanded(!expanded);
					onExpandedChange?.(!expanded);
				}}
				onPointerEnter={() => setHeld(true)}
				onPointerLeave={() => setHeld(false)}
				onFocus={() => setHeld(true)}
				onBlur={() => setHeld(false)}
			>
				<Icon name="brain" size="xs" />
				<span className="tool-verb">
					{label}
					<span className="tool-pending" data-label={label} aria-hidden="true" />
				</span>
				<ThinkingElapsed timing={item.timing} active={running} />
				<Icon name="disclosure" size="xs" className="thinking-chevron" />
				{!expanded && preview ? <span className="thinking-preview">{previewText}</span> : null}
			</button>
			<div
				id={id}
				className={`thinking-disclosure${expanded ? " expanded" : ""}`}
				aria-hidden={!expanded}
				inert={!expanded}
			>
				<div className="thinking-body">
					<MarkdownView
						className="message-body"
						source={text}
						labels={labels}
						streaming={running}
						onCopyCode={copyCode}
						copiedLabel={t("copied")}
					/>
				</div>
			</div>
		</section>
	);
});

/** Only the live label ticks; settled history has no timer or invented endpoint. */
export function ThinkingElapsed({
	timing,
	active,
	labelKey = "thinkingElapsed",
}: {
	readonly timing: ThinkingTimelineItem["timing"];
	readonly active: boolean;
	readonly labelKey?: "thinkingElapsed" | "processThinkingElapsed";
}) {
	const t = useT();
	const [now, setNow] = useState(Date.now);
	const running = active && timing !== undefined && timing.endedAt === undefined;
	useEffect(() => {
		if (!running) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [running]);
	if (!timing || (!running && timing.endedAt === undefined)) return null;
	// A settled sub-second think would only print "0s"; the label adds nothing.
	if (!running && (timing.endedAt ?? 0) - timing.startedAt < 1000) return null;
	return <span className="thinking-elapsed">{t(labelKey, { duration: thinkingElapsed(timing, now) })}</span>;
}
