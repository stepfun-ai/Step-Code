import { memo, useEffect, useId, useRef, useState } from "react";
import { useMarkdownLabels, useT } from "../../i18n";
import { copyText } from "../../state/session";
import { thinkingElapsed } from "../../state/thinking-timing";
import type { ThinkingTimelineItem } from "../../state/types";
import { Icon, MarkdownView } from "../../ui";
import { useSmoothText } from "./streaming";

const copyCode = (code: string) => copyText(code, null);

/** How long a folding block keeps its body mounted, so the closing transition still has content. */
const BODY_UNMOUNT_DELAY_MS = 320;

/**
 * Folded by default inside the Simple process group; only an actual live block animates.
 * The folded header carries no excerpt of the reasoning: a fast model rewrote that line
 * several times a second, and the text read as flicker rather than progress.
 *
 * Folded reasoning renders no Markdown: the hidden body was still parsed and laid out
 * on every streamed frame. The body mounts when the block opens and stays until its
 * closing transition has run, so it still slides shut instead of vanishing.
 */
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
	const [bodyShown, setBodyShown] = useState(false);
	const wasRunning = useRef(running);
	const id = useId();
	useEffect(() => {
		if (wasRunning.current && !running) setExpanded(false);
		wasRunning.current = running;
	}, [running]);
	useEffect(() => {
		if (expanded) {
			setBodyShown(true);
			return;
		}
		// Longer than the disclosure's 240ms row transition, and fine where motion is reduced.
		const timer = setTimeout(() => setBodyShown(false), BODY_UNMOUNT_DELAY_MS);
		return () => clearTimeout(timer);
	}, [expanded]);
	const label = t(running ? "thinkingIndicator" : "thinkingLabel");
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
			>
				<Icon name="brain" size="xs" />
				<span className="tool-verb">
					{label}
					<span className="tool-pending" data-label={label} aria-hidden="true" />
				</span>
				<ThinkingElapsed timing={item.timing} active={running} />
				<Icon name="disclosure" size="xs" className="thinking-chevron" />
			</button>
			<div
				id={id}
				className={`thinking-disclosure${expanded ? " expanded" : ""}`}
				aria-hidden={!expanded}
				inert={!expanded}
			>
				<div className="thinking-body">
					{/* Folded, nothing is parsed or laid out, and no reveal clock runs. */}
					{expanded || bodyShown ? <ThinkingBody content={item.content} running={running} /> : null}
				</div>
			</div>
		</section>
	);
});

/** The reasoning itself, mounted only while its disclosure is open or closing. */
function ThinkingBody({ content, running }: { readonly content: string; readonly running: boolean }) {
	const t = useT();
	const labels = useMarkdownLabels();
	// Opened mid-thought: what has arrived shows at once; only what follows is revealed.
	const text = useSmoothText(content, running, content);
	return (
		<MarkdownView
			className="message-body"
			source={text}
			labels={labels}
			streaming={running}
			onCopyCode={copyCode}
			copiedLabel={t("copied")}
		/>
	);
}

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
