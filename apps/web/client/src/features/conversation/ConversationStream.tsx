import { Fragment, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useLocale, useT } from "../../i18n";
import { collectTurnChanges } from "../../lib/turn-changes";
import { showToast } from "../../state/session";
import { setUi, useAppStore } from "../../state/store";
import type { MessageTimelineItem, SteeringMessage, TimelineItem } from "../../state/types";
import { Icon } from "../../ui";
import { Composer } from "../composer";
import { openSettings } from "../settings/actions";
import { ClarificationPanel } from "./ClarificationPanel";
import { CommandRow } from "./CommandRow";
import { CompactionRow, CompactionRunningRow } from "./CompactionRow";
import { GoalRoundRow } from "./GoalRoundRow";
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
import { TurnChangesCard } from "./TurnChangesCard";
import { type TurnArtifact, turnArtifacts, withTurnChanges } from "./turn-artifacts";
import { collectTurnFooters } from "./turn-footers";

/**
 * Shown while the timeline is empty (legacy index.html 835-842, `renderTimeline`):
 * the StepCode mark, whose amber prompt chevron draws in once on mount, over a
 * single question.
 */
function EmptyConversation() {
	const t = useT();
	const draft = useAppStore((state) => state.current === null);
	return (
		<div className="empty-conversation">
			<div className="empty-state">
				<span className="empty-mark" aria-hidden="true">
					<Icon name="stepcode" />
				</span>
				<h1 className="empty-title">{t("emptyTitle")}</h1>
			</div>
			{draft ? (
				<button
					type="button"
					id="emptySessionImport"
					className="empty-session-import"
					onClick={() => openSettings("migration")}
				>
					<Icon name="folder" size="sm" />
					<span>{t("emptySessionImport")}</span>
				</button>
			) : null}
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
	const t = useT();
	const items = useAppStore((state) => state.timelineItems);
	const pendingTurn = useAppStore((state) => state.pendingTurn);
	// Sent with "立即" or Cmd/Ctrl+Enter: the kernel reads them after the current tool call; shown already.
	const steering = useAppStore((state) => state.current?.steeringMessages ?? NO_STEERING);
	const sessionId = useAppStore((state) => state.current?.id ?? "");
	// Before the first bootstrap pass picks a session or a draft there is no session to draw yet: treat it as
	// opening, so the pane never paints the centred new-session layout for a conversation that is about to arrive.
	const opening = useAppStore((state) => !state.booted || state.ui.openingSession !== null);
	const cwd = useAppStore((state) => state.current?.cwd ?? "");
	const status = useAppStore((state) => state.current?.status);
	const compacting = useAppStore((state) => state.compacting);
	const notices = useAppStore((state) => state.notices);
	const revertedTurns = useAppStore((state) => state.current?.revertedTurns);
	// Shown with a sent message's timestamp; the transcript stores no per-message model.
	// An interrupted turn has no finished reply, so it gets no model and no time.
	const lastRunAborted = useAppStore((state) => state.current?.lastRunAborted === true);
	// The newest turn was cut off (a stopped run, or a host that exited mid-stream).
	// The host derives it from the recorded entries, so a reopened session says it too.
	const interrupted = useAppStore((state) => state.current?.interruptedTurn === true);
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
	// Each delivery carries its own turn's change, so its card opens that turn's diff, not the file as it is now.
	const artifactsAfter = useMemo(() => {
		const changesByTurn = new Map(turns.map((turn) => [turn.turnId, turn]));
		return new Map(
			[...footerAfter].map(([index, footer]) => [
				index,
				withTurnChanges(turnArtifacts(items, footer, cwd), changesByTurn.get(footer.turnId), cwd),
			]),
		);
	}, [footerAfter, items, cwd, turns]);
	/*
	 * Each turn's deliverables attach to the bubble that closed it, as the
	 * answer handing its files over, instead of a strip after the whole turn.
	 */
	const attachmentsFor = useMemo(() => {
		const perMessage = new Map<MessageTimelineItem, readonly TurnArtifact[]>();
		let closing: MessageTimelineItem | null = null;
		items.forEach((item, index) => {
			if (item.kind === "message" && item.role === "user") closing = null;
			if (item.kind === "message" && item.role === "assistant") closing = item;
			const artifacts = footerAfter.get(index) ? artifactsAfter.get(index) : undefined;
			if (artifacts?.length && closing) perMessage.set(closing, artifacts);
		});
		return perMessage;
	}, [footerAfter, artifactsAfter, items]);

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
	// The reveal is cleared only after the lookup. Clearing it first and giving up
	// when the row is absent left the reader at the newest message with no
	// explanation, which reads as "the jump went to the end".
	useLayoutEffect(() => {
		if (!reveal || reveal.sessionId !== sessionId || !items.length) return;
		const target = innerRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(reveal.entryId)}"]`);
		setUi({ revealEntry: null });
		if (!target) {
			// A hit can name a row this transcript does not draw: the message belongs
			// to a branch the user rewound or retried away from (the file keeps those
			// rows, the page renders the live branch), or the entry is one the index
			// covers but the transcript has no row for. Say which, and say where the
			// reader ended up.
			showToast(t("revealNotFound"));
			return;
		}
		stick.current = false;
		target.scrollIntoView({ block: reveal.block ?? "center", behavior: reveal.behavior });
		target.animate([{ backgroundColor: "var(--selection)" }, { backgroundColor: "transparent" }], {
			duration: 1600,
			easing: "ease-out",
		});
	}, [reveal, sessionId, items, t]);
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
	// Rewriting swaps the message for the compact edit composer, in place.
	const editingPrompt = useAppStore((state) => state.ui.editingPrompt);
	// A turn that starts under an open editor (a goal round fires at any idle
	// boundary) leaves its fork stale; close it instead of keeping a dead
	// composer parked mid-flow.
	useEffect(() => {
		if (running && editingPrompt) setUi({ editingPrompt: null });
	}, [running, editingPrompt]);
	/*
	 * The rewrite target is a recorded message. Live rows — the streamed reply and the echo of the prompt being
	 * sent — carry no entry id yet, and `editingPrompt?.entryId` is `undefined` when nothing is being rewritten:
	 * comparing the two mounted an empty editor in the middle of every turn, beside the real composer.
	 */
	const editingEntryId = editingPrompt?.entryId ?? "";
	// Only the latest prompt is rewritable: fork to the entry before it.
	// A command echo is a prompt too: the newest of either kind is rewritable.
	let lastUserIndex = -1;
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const entry = items[index];
		if (entry.kind === "command" || (entry.kind === "message" && entry.role === "user")) {
			lastUserIndex = index;
			break;
		}
	}
	let rewriteBefore: string | undefined;
	for (let index = lastUserIndex - 1; index >= 0; index -= 1) {
		const entry = items[index];
		if (entry.kind === "message" && entry.entryId) {
			rewriteBefore = entry.entryId;
			break;
		}
	}
	/*
	 * Rewriting forks the session back before the latest prompt — only
	 * coherent once its turn has settled. While a turn runs, the latest prompt
	 * is a steering message parked mid-flow (a goal round keeps turns busy for
	 * minutes), and swapping it for an edit composer there reads as an input
	 * box intruding into the transcript.
	 */
	const rewriteClosed = running;
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
										editingEntryId !== "" && editingEntryId === row.item.entryId ? (
											<div className="edit-prompt-slot">
												<Composer variant="edit" />
											</div>
										) : (
											<MessageItem
												item={row.item}
												attachments={
													row.item.role === "assistant" ? attachmentsFor.get(row.item) : undefined
												}
												rewritableBefore={
													!rewriteClosed && items[lastUserIndex] === row.item
														? (rewriteBefore ?? "")
														: undefined
												}
											/>
										)
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
										editingEntryId !== "" && editingEntryId === row.item.entryId ? (
											<div className="edit-prompt-slot">
												<Composer variant="edit" />
											</div>
										) : (
											<CommandRow
												item={row.item}
												rewritableBefore={
													!rewriteClosed && items[lastUserIndex] === row.item
														? (rewriteBefore ?? "")
														: undefined
												}
											/>
										)
									) : row.item.kind === "compaction" ? (
										<CompactionRow item={row.item} />
									) : row.item.kind === "goal-round" ? (
										<GoalRoundRow item={row.item} />
									) : (
										<ApprovalCard approval={row.item.approval} />
									)}
									{card ? (
										<TurnChangesCard turn={card} reverted={Boolean(revertedTurns?.includes(card.turnId))} />
									) : null}
									{footer ? (
										<MessageActions key={footer.turnId} messages={footer.messages} aborted={lastRunAborted} />
									) : null}
								</Fragment>
							);
						})}
						{compacting ? <CompactionRunningRow /> : null}
						{interrupted ? (
							<div className="interrupted-row">
								<span className="interrupted-label">{t("interruptedTurn")}</span>
							</div>
						) : null}
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
