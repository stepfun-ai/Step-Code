import { Fragment, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useLocale, useT } from "../../i18n";
import { collectTurnChanges } from "../../lib/turn-changes";
import { setUi, useAppStore } from "../../state/store";
import type { SteeringMessage, TimelineItem } from "../../state/types";
import { Icon } from "../../ui";
import { ClarificationPanel } from "./ClarificationPanel";
import { CommandRow } from "./CommandRow";
import { CompactionRow, CompactionRunningRow } from "./CompactionRow";
import { MessageActions, MessageItem } from "./MessageItem";
import { NoticeRow } from "./NoticeRow";
import { PlanReviewCard } from "./PlanReviewCard";
import { ProcessGroup } from "./ProcessGroup";
import {
	groupProcessRows,
	type IndexedTimelineRow,
	type ProcessGroup as ProcessGroupRow,
	reuseUnchangedRows,
} from "./process-groups";
import { RetryRow } from "./RetryRow";
import { ThinkingDisclosure } from "./ThinkingDisclosure";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { ApprovalCard, ToolRow } from "./TimelineRows";
import { TurnArtifacts } from "./TurnArtifacts";
import { TurnChangesCard } from "./TurnChangesCard";
import { turnArtifacts } from "./turn-artifacts";
import { collectTurnFooters } from "./turn-footers";

/**
 * Shown while the timeline is empty (legacy index.html 835-842, `renderTimeline`):
 * the StepCode mark, whose amber prompt chevron draws in once on mount, over a
 * single question.
 */
function EmptyConversation() {
	const t = useT();
	return (
		<div className="empty-state">
			<span className="empty-mark" aria-hidden="true">
				<Icon name="stepcode" />
			</span>
			<h1 className="empty-title">{t("emptyTitle")}</h1>
		</div>
	);
}

/**
 * Whether a running turn is between visible steps: right after the prompt, or
 * after a tool finished and before the model's next output. A streaming reply,
 * a running tool or an approval card already shows what is going on.
 */
function awaitingOutput(items: readonly TimelineItem[]): boolean {
	const last = items.at(-1);
	if (!last) return true;
	if (last.kind === "message") return last.role === "user";
	if (last.kind === "tool") return last.state !== "pending";
	// A retry under way shows its own status.
	if (last.kind === "retry") return !last.live;
	return false;
}

function scrollToEnd(stream: HTMLElement | null): void {
	if (stream) stream.scrollTop = stream.scrollHeight;
}

const NO_STEERING: readonly SteeringMessage[] = [];

/** Within this many pixels of the end the stream counts as "at the bottom" and follows new output. */
const STICK_THRESHOLD = 48;

/**
 * `#stream > #streamInner`: the session timeline (legacy `renderTimeline`,
 * app.js 2246-2281). New output keeps the view pinned to the bottom only while
 * the reader is there: scrolling up during a turn leaves the view alone.
 * Opening a session or sending a message pins it again.
 */
export function ConversationStream() {
	const items = useAppStore((state) => state.timelineItems);
	const pendingTurn = useAppStore((state) => state.pendingTurn);
	// Sent with "立即" or Cmd/Ctrl+Enter: the kernel reads them after the current tool call; shown already.
	const steering = useAppStore((state) => state.current?.steeringMessages ?? NO_STEERING);
	const sessionId = useAppStore((state) => state.current?.id ?? "");
	const opening = useAppStore((state) => state.ui.openingSession !== null);
	const cwd = useAppStore((state) => state.current?.cwd ?? "");
	const status = useAppStore((state) => state.current?.status);
	const compacting = useAppStore((state) => state.compacting);
	const notices = useAppStore((state) => state.notices);
	const revertedTurns = useAppStore((state) => state.current?.revertedTurns);
	// Shown with a sent message's timestamp; the transcript stores no per-message model.
	const modelId = useAppStore((state) => state.current?.model?.id);
	// An interrupted turn has no finished reply, so it gets no model and no time.
	const lastRunAborted = useAppStore((state) => state.current?.lastRunAborted === true);
	const reveal = useAppStore((state) => state.ui.revealEntry);
	const running = status === "running";
	const busy = running || status === "waiting";
	const locale = useLocale();
	const streamRef = useRef<HTMLDivElement>(null);
	const innerRef = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const previousRows = useRef<readonly (IndexedTimelineRow | ProcessGroupRow)[]>([]);
	// Notices belong to the page, not the session file: show only this session's.
	const sessionNotices = useMemo(
		() => notices.filter((notice) => notice.sessionId === sessionId),
		[notices, sessionId],
	);
	const turns = useMemo(() => collectTurnChanges(items, cwd), [items, cwd]);
	const footerAfter = useMemo(
		() => new Map(collectTurnFooters(items, status, pendingTurn !== null).map((turn) => [turn.lastIndex, turn])),
		[items, status, pendingTurn],
	);
	const artifactsAfter = useMemo(
		() => new Map([...footerAfter].map(([index, footer]) => [index, turnArtifacts(items, footer, cwd)])),
		[footerAfter, items, cwd],
	);

	// A new session or a sent message: follow the bottom again.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the session id and the pending messages are the triggers.
	useLayoutEffect(() => {
		stick.current = true;
		scrollToEnd(streamRef.current);
	}, [sessionId, pendingTurn, steering.length]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: items and locale change the content height.
	useLayoutEffect(() => {
		if (stick.current) scrollToEnd(streamRef.current);
	}, [items, locale]);
	// A search hit: once its session's timeline is drawn, centre the entry and stop following the end.
	useLayoutEffect(() => {
		if (!reveal || reveal.sessionId !== sessionId || !items.length) return;
		setUi({ revealEntry: null });
		const target = innerRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(reveal.entryId)}"]`);
		if (!target) return;
		stick.current = false;
		target.scrollIntoView({ block: reveal.block ?? "center", behavior: reveal.behavior });
		target.animate([{ backgroundColor: "var(--selection)" }, { backgroundColor: "transparent" }], {
			duration: 1600,
			easing: "ease-out",
		});
	}, [reveal, sessionId, items]);
	// The live reply grows between store updates (smooth reveal), so watch the size too.
	useEffect(() => {
		const inner = innerRef.current;
		if (!inner) return;
		const observer = new ResizeObserver(() => {
			if (stick.current) scrollToEnd(streamRef.current);
		});
		observer.observe(inner);
		return () => observer.disconnect();
	}, []);
	const onScroll = () => {
		const stream = streamRef.current;
		if (stream) stick.current = stream.scrollHeight - stream.scrollTop - stream.clientHeight < STICK_THRESHOLD;
	};

	// A pending message is drawn after the timeline, so the indicator follows it.
	const thinking = pendingTurn !== null || (running && awaitingOutput(items));
	const cardAfter = new Map(
		turns
			.filter((turn) => !turn.latest || pendingTurn !== null || !busy)
			.map((turn) => [turn.lastIndex, turn] as const),
	);
	const breaks = [...cardAfter.keys(), ...footerAfter.keys()].sort((a, b) => a - b).join(",");
	// `breaks` is the value-stable form of the two maps, so the grouping reruns only when they really change.
	const presentation = useMemo(() => {
		const next = reuseUnchangedRows(
			previousRows.current,
			groupProcessRows(items, running, new Set(breaks ? breaks.split(",").map(Number) : [])),
		);
		previousRows.current = next;
		return next;
	}, [items, running, breaks]);
	return (
		<div
			className="stream"
			id="stream"
			ref={streamRef}
			onScroll={onScroll}
			data-opening={opening ? "" : undefined}
			aria-busy={opening || undefined}
		>
			<div className="stream-inner" id="streamInner" ref={innerRef}>
				{items.length || pendingTurn || steering.length || compacting || sessionNotices.length ? (
					<>
						{presentation.map((row) => {
							const card = cardAfter.get(row.lastIndex);
							const footer = footerAfter.get(row.lastIndex);
							// Always a fragment, so a card appearing under a row does not remount the row.
							return (
								<Fragment key={`${sessionId}:${row.key}`}>
									{"kind" in row ? (
										<ProcessGroup
											group={row}
											revealEntryId={reveal?.sessionId === sessionId ? reveal.entryId : undefined}
										/>
									) : row.item.kind === "message" ? (
										<MessageItem item={row.item} model={modelId} />
									) : row.item.kind === "tool" ? (
										<>
											<ToolRow item={row.item} />
											{row.item.planReview ? <PlanReviewCard review={row.item.planReview} /> : null}
										</>
									) : row.item.kind === "thinking" ? (
										<ThinkingDisclosure item={row.item} active={running} />
									) : row.item.kind === "retry" ? (
										<RetryRow item={row.item} />
									) : row.item.kind === "command" ? (
										<CommandRow item={row.item} />
									) : row.item.kind === "compaction" ? (
										<CompactionRow item={row.item} />
									) : (
										<ApprovalCard approval={row.item.approval} />
									)}
									{footer ? (
										<TurnArtifacts
											key={`outputs-${sessionId}-${footer.turnId}`}
											artifacts={artifactsAfter.get(row.lastIndex) ?? []}
											cwd={cwd}
										/>
									) : null}
									{card ? (
										<TurnChangesCard turn={card} reverted={Boolean(revertedTurns?.includes(card.turnId))} />
									) : null}
									{footer ? (
										<MessageActions
											key={footer.turnId}
											messages={footer.messages}
											model={modelId}
											aborted={lastRunAborted}
										/>
									) : null}
								</Fragment>
							);
						})}
						{compacting ? <CompactionRunningRow /> : null}
						{steering.map((message, index) => (
							<MessageItem
								// Kernel texts carry no id; equal texts are interchangeable here.
								// biome-ignore lint/suspicious/noArrayIndexKey: see above.
								key={`steering-${index}`}
								item={{
									itemId: `message-steering-${index}`,
									kind: "message",
									role: "user",
									content: message.text,
									images: message.images.map((image) => `data:${image.mimeType};base64,${image.data}`),
								}}
							/>
						))}
						{pendingTurn ? (
							<MessageItem
								item={{
									itemId: "message-pending",
									kind: "message",
									role: "user",
									content: pendingTurn.text,
									images: pendingTurn.images,
								}}
								files={pendingTurn.files}
								model={modelId}
							/>
						) : null}
						{thinking ? <ThinkingIndicator /> : null}
						{sessionNotices.map((notice) => (
							<NoticeRow key={notice.id} notice={notice} />
						))}
					</>
				) : (
					<EmptyConversation />
				)}
				{/* The pending questionnaire is conversation, not composer chrome: it
				 * renders as the stream's latest element, where the question was asked. */}
				<ClarificationPanel />
			</div>
		</div>
	);
}
