import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n";
import { api, errorMessage } from "../../lib/api";
import { cx } from "../../lib/format";
import { activeRightPanel } from "../../state/right-panel";
import { timelineFromEntries } from "../../state/session";
import { setUi, useAppStore } from "../../state/store";
import {
	cacheRates,
	compactTokens,
	formatRate,
	sumUsage,
	usageFromEntries,
	usageFromTask,
} from "../../state/subagent-usage";
import type { ChildAgentSummary, ChildSessionSnapshot, SubagentTask, SubagentUsage } from "../../state/types";
import { Icon, IconButton, Tooltip } from "../../ui";
import { closeChildAgent, openSubagentTask } from "./actions";
import { MessageItem } from "./MessageItem";
import { clockTime } from "./message-meta";
import { RetryRow } from "./RetryRow";
import { SubagentStatusIcon } from "./SubagentStatusIcon";
import { ThinkingDisclosure } from "./ThinkingDisclosure";
import { ToolRow } from "./TimelineRows";

/** A running parent may still have children writing; their transcripts are re-read this often. */
const REFRESH_MS = 2000;

function childPath(parentId: string, childId: string): string {
	return `/api/v1/sessions/${encodeURIComponent(parentId)}/children/${encodeURIComponent(childId)}`;
}

/** Re-runs `load` every REFRESH_MS while `live`; the latest result wins. */
function usePolled<T>(key: string | null, live: boolean, load: () => Promise<T>): { value?: T; error?: string } {
	const [state, setState] = useState<{ key: string | null; value?: T; error?: string }>({ key: null });
	// biome-ignore lint/correctness/useExhaustiveDependencies: `key` identifies what `load` reads.
	useEffect(() => {
		if (!key) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const run = async () => {
			await load().then(
				(value) => !cancelled && setState({ key, value }),
				(error: unknown) => !cancelled && setState({ key, error: errorMessage(error) }),
			);
			if (!cancelled && live) timer = setTimeout(run, REFRESH_MS);
		};
		void run();
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, [key, live]);
	return state.key === key ? state : {};
}

/**
 * `.subagent-usage`: what the run cost.
 *
 * A subagent's tokens are spent in a child session, so nothing else in the UI
 * accounts for them: the parent's figures stop at the tool call. The strip names
 * the raw sums and both cache rates, because "cheap" and "cheap because cached"
 * are different findings — and a low figure is often a prompt that never reused
 * its prefix.
 */
function SubagentUsageStrip({
	task,
	tasks,
	transcriptUsage,
}: {
	readonly task: SubagentTask | undefined;
	readonly tasks: readonly SubagentTask[] | undefined;
	readonly transcriptUsage: SubagentUsage | undefined;
}) {
	const t = useT();
	// The tool result's own sum, else the transcript's (per child, so still this run).
	const totals = usageFromTask(task) ?? transcriptUsage;
	// A parallel or chained call reports one figure for the whole dispatch.
	const runTotals = tasks && tasks.length > 1 ? sumUsage(tasks.map((entry) => usageFromTask(entry))) : undefined;
	if (!totals && !runTotals) return null;
	const rates = totals ? cacheRates(totals) : undefined;
	const figures = (usage: SubagentUsage) => (
		<>
			<span data-usage="records">{t("subagentUsageRecords", { count: usage.records })}</span>
			<span data-usage="input">{t("subagentUsageInput", { count: compactTokens(usage.input) })}</span>
			<span data-usage="cache-read">{t("subagentUsageCacheRead", { count: compactTokens(usage.cacheRead) })}</span>
			<span data-usage="cache-write">
				{t("subagentUsageCacheWrite", { count: compactTokens(usage.cacheWrite) })}
			</span>
			<span data-usage="output">{t("subagentUsageOutput", { count: compactTokens(usage.output) })}</span>
			<span data-usage="total">{t("subagentUsageTotal", { count: compactTokens(usage.total) })}</span>
		</>
	);
	return (
		<section className="subagent-usage" id="subagentUsage" aria-label={t("subagentUsageTitle")}>
			<div className="subagent-usage-head">
				<h3>{t("subagentUsageTitle")}</h3>
				{runTotals ? (
					<span className="subagent-usage-run">
						{t("subagentUsageRunTotal", { count: compactTokens(runTotals.total) })}
					</span>
				) : null}
			</div>
			{totals ? (
				<>
					<div className="subagent-usage-figures">{figures(totals)}</div>
					{rates ? (
						<div className="subagent-usage-rates">
							<span data-usage="context-rate">
								{t("subagentUsageContextRate")} <strong>{formatRate(rates.context)}</strong>
							</span>
							<span data-usage="total-rate">
								{t("subagentUsageTotalRate")} <strong>{formatRate(rates.total)}</strong>
							</span>
						</div>
					) : null}
				</>
			) : null}
			{runTotals ? (
				<div className="subagent-usage-figures subagent-usage-aggregate">{figures(runTotals)}</div>
			) : null}
		</section>
	);
}

/**
 * The task a child was given, as a collapsed receipt rather than a field.
 *
 * A child transcript can carry more than the dispatch task (a follow-up the
 * parent injected, or the task itself when the run records no separate copy).
 * Those rows are context the parent produced — the reader never types here — so
 * they render as a one-line "message received" row that opens to the prose. A
 * bubble or a boxed paragraph both read as a prompt input in this read-only
 * panel, and a long task would bury the run below it.
 */
function SubagentInputRow({
	text,
	label,
	time,
	followUp = false,
}: {
	readonly text: string;
	readonly label: string;
	readonly time?: string;
	readonly followUp?: boolean;
}) {
	const [open, setOpen] = useState(false);
	return (
		<section className={cx("subagent-input-block", followUp && "is-follow-up")} aria-label={label}>
			<button
				type="button"
				className="subagent-input-toggle"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}
			>
				<Icon name="prompt" size="xs" />
				<span className="subagent-input-label">{label}</span>
				{time ? <time className="subagent-input-time">{time}</time> : null}
				<Icon name="chevronDown" size="xs" className="subagent-input-chevron" />
			</button>
			{open ? <p className="subagent-task">{text}</p> : null}
		</section>
	);
}

/**
 * `#childAgentView`: a responsive child transcript inspector beside the parent.
 * Strictly read-only: there is no composer, and messages carry no vote or fork
 * actions. Opened from a subagent call (one child) or a workflow call (the
 * run's agents, as tabs). The parent stays selected in the sidebar.
 *
 * The panel leads with an overview of the run, then the input the parent sent,
 * then the model's execution. A child transcript's user rows are part of the
 * input, never chat bubbles: read-only rows must not look typable.
 */
export function ChildAgentView({ embedded = false }: { readonly embedded?: boolean }) {
	const t = useT();
	const view = useAppStore((state) => state.ui.childView);
	const currentId = useAppStore((state) => state.current?.id);
	const panel = useAppStore(activeRightPanel);
	const selectedTool = useAppStore((state) => state.timelineItems.find((item) => item.itemId === view?.toolItemId));
	const tasks = selectedTool?.kind === "tool" ? selectedTool.subagentTasks : undefined;
	const task = view?.taskIndex === undefined ? undefined : tasks?.[view.taskIndex];
	const dispatchError =
		!task && selectedTool?.kind === "tool" && selectedTool.state === "failed"
			? selectedTool.outputDetail || selectedTool.outputSummary
			: "";
	const [expanded, setExpanded] = useState(false);
	const parentBusy = useAppStore(
		(state) => state.current?.status === "running" || state.current?.status === "waiting",
	);
	const panelExpanded = useAppStore((state) => state.ui.rightPanelExpanded);
	const open = Boolean(view && view.parentId === currentId && (!embedded || panel === "subagent"));
	const parentId = view?.parentId ?? "";
	const workflowRun = open ? view?.workflowRun : undefined;
	const scrollRef = useRef<HTMLDivElement | null>(null);

	const agents = usePolled(workflowRun ? `${parentId}:${workflowRun}` : null, parentBusy, () =>
		api<{ children: ChildAgentSummary[] }>(
			`/api/v1/sessions/${encodeURIComponent(parentId)}/children?${new URLSearchParams({ workflowRun: workflowRun ?? "" })}`,
		).then((body) => body.children),
	);
	const childId = task?.sessionId ?? view?.childId ?? agents.value?.[0]?.id ?? null;
	const transcript = usePolled(
		open && childId ? `${parentId}:${childId}` : null,
		parentBusy || task?.status === "running",
		() => api<ChildSessionSnapshot>(childPath(parentId, childId ?? "")),
	);
	const items = useMemo(() => timelineFromEntries(transcript.value?.entries ?? []), [transcript.value]);
	/**
	 * The transcript row that repeats the dispatch task.
	 *
	 * The child is started with the task as its first user message. Comparison
	 * collapses whitespace, because the transcript may wrap or indent the same
	 * text. The row is not rendered again: the input section shows the task once.
	 */
	const taskRowIndex = useMemo(() => {
		const taskText = task?.task?.replace(/\s+/gu, " ").trim();
		if (!taskText) return -1;
		return items.findIndex((item) => {
			if (item.kind !== "message" || item.role !== "user") return false;
			const spoken = item.content.replace(/\s+/gu, " ").trim();
			return spoken.includes(taskText) || taskText.includes(spoken);
		});
	}, [items, task?.task]);
	/**
	 * User rows are inputs, not execution.
	 *
	 * Every user row of a child transcript is text the parent (or the runtime)
	 * put there; drawing it as a message bubble made the read-only panel look
	 * like it contained a prompt input. They live in the input section.
	 */
	const userEntries = useMemo(
		() =>
			items.flatMap((item, index) =>
				item.kind === "message" && item.role === "user"
					? [{ index, content: item.content, timestamp: item.timestamp }]
					: [],
			),
		[items],
	);
	const taskText = task?.task?.trim() ?? "";
	const primaryInputIndex = taskText ? taskRowIndex : (userEntries[0]?.index ?? -1);
	const primaryEntry = userEntries.find((entry) => entry.index === primaryInputIndex);
	const primaryInput = taskText || primaryEntry?.content || view?.label || "";
	const extraInputs = userEntries.filter((entry) => entry.index !== primaryInputIndex);
	// Execution is everything the model produced; input rows were peeled off above.
	const executionItems = useMemo(
		() => items.filter((item) => !(item.kind === "message" && item.role === "user")),
		[items],
	);
	/**
	 * The run's token totals.
	 *
	 * The tool result's own sum is authoritative — the kernel counted every turn,
	 * including the ones a transcript excerpt would miss — and the transcript is
	 * read only when the details carry none.
	 */
	const transcriptUsage = useMemo(() => usageFromEntries(transcript.value?.entries ?? []), [transcript.value]);
	// A new task, child, run or panel width starts at the overview, not wherever
	// the last transcript was left. Re-reading the same run must not scroll.
	const resetKey = `${parentId}:${childId ?? ""}:${view?.toolItemId ?? ""}:${view?.taskIndex ?? ""}:${workflowRun ?? ""}:${open}:${panelExpanded}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `resetKey` is the value-stable form of the identity above.
	useLayoutEffect(() => {
		scrollRef.current?.scrollTo({ top: 0 });
	}, [resetKey]);
	const selectAgent = (id: string) => {
		if (view) setUi({ childView: { ...view, childId: id } });
	};
	const emptyText = dispatchError
		? t("subagentNoTranscript")
		: view?.toolItemId && !task
			? t("subagentNoTranscript")
			: transcript.error || agents.error
				? transcript.error || agents.error
				: workflowRun && agents.value?.length === 0
					? t("childAgentNoneInRun")
					: task && !childId
						? t(
								task.status === "queued" || task.status === "running"
									? "subagentWaitingTranscript"
									: // A rejected or aborted dispatch never created a child session;
										// say so instead of waiting for a transcript that cannot arrive.
										task.status === "failed" || task.status === "aborted"
										? "subagentFailedBeforeStart"
										: "subagentNoTranscript",
							)
						: transcript.value
							? t("childAgentEmpty")
							: t("childAgentLoading");
	const overviewError = task?.error || dispatchError;

	return (
		<section
			className={cx("child-agent-view", open && "open", expanded && "expanded")}
			id="childAgentView"
			hidden={!open}
			aria-label={t("childAgent")}
		>
			<header className="child-agent-header" hidden={embedded}>
				<IconButton
					id="childAgentBack"
					icon="back"
					title={t("backToConversation")}
					aria-label={t("backToConversation")}
					onClick={closeChildAgent}
				/>
				<Icon name={workflowRun ? "layers" : "bot"} size="sm" />
				<strong className="child-agent-title">{workflowRun ? view?.label : t("subagents")}</strong>
				<span className="child-agent-badge">{t("childAgentReadOnly")}</span>
				<IconButton
					icon="panelRight"
					className="child-agent-expand"
					aria-label={t(expanded ? "subagentCollapse" : "subagentExpand")}
					data-tooltip={t(expanded ? "subagentCollapse" : "subagentExpand")}
					aria-pressed={expanded}
					onClick={() => setExpanded((value) => !value)}
				/>
				<IconButton
					icon="close"
					aria-label={t("subagentClose")}
					data-tooltip={t("subagentClose")}
					onClick={closeChildAgent}
				/>
			</header>
			{tasks && tasks.length > 1 ? (
				<section className="child-agent-tabs" aria-label={t("childAgentList")}>
					{tasks.map((candidate, index) => (
						<button
							// biome-ignore lint/suspicious/noArrayIndexKey: runtime task order is stable.
							key={index}
							type="button"
							className={cx("child-agent-tab", index === view?.taskIndex && "active")}
							aria-pressed={index === view?.taskIndex}
							onClick={() => view?.toolItemId && openSubagentTask(view.toolItemId, index)}
						>
							<SubagentStatusIcon status={candidate.status} />
							<span>
								{candidate.agent || t("subagent")} · {index + 1}
							</span>
						</button>
					))}
				</section>
			) : null}
			{workflowRun && agents.value?.length ? (
				<div className="child-agent-tabs" role="tablist" aria-label={t("childAgentList")}>
					{agents.value.map((agent, index) => (
						<Tooltip key={agent.id} content={agent.title}>
							<button
								type="button"
								role="tab"
								aria-selected={agent.id === childId}
								className={cx("child-agent-tab", agent.id === childId && "active")}
								data-child-session-id={agent.id}
								onClick={() => selectAgent(agent.id)}
							>
								<span className="child-agent-tab-index">#{index + 1}</span>
								<span>{agent.title || agent.id}</span>
							</button>
						</Tooltip>
					))}
				</div>
			) : null}
			<div className="stream child-agent-stream" ref={scrollRef}>
				<div className="stream-inner">
					{task || transcriptUsage ? (
						<section className="subagent-overview" aria-label={t("subagentOverview")}>
							<h3 className="subagent-section-title">{t("subagentOverview")}</h3>
							{task ? (
								<div className="subagent-head">
									<span className="lane-type">{task.agent || t("subagent")}</span>
									<SubagentStatusIcon status={task.status} />
									<span className="subagent-state-label">{t(`subagentStatus.${task.status}`)}</span>
									<span className="child-agent-badge">{t("childAgentReadOnly")}</span>
									<span className="subagent-meta">
										{task.model}
										{task.turns !== undefined ? (
											<span>{t("subagentTurns", { count: task.turns })}</span>
										) : null}
									</span>
								</div>
							) : null}
							<SubagentUsageStrip task={task} tasks={tasks} transcriptUsage={transcriptUsage} />
							{overviewError ? (
								<p className="subagent-error" role="alert">
									{overviewError}
								</p>
							) : null}
						</section>
					) : null}
					<section className="subagent-input" aria-label={t("subagentInput")}>
						<SubagentInputRow
							key={`input-${resetKey}`}
							text={primaryInput || t("subagentNoTask")}
							label={t("subagentInputReceived")}
							time={primaryEntry ? clockTime(primaryEntry.timestamp ?? "") : undefined}
						/>
						{extraInputs.map((entry, index) => (
							<SubagentInputRow
								key={`input-${entry.index}`}
								text={entry.content}
								label={t("subagentInputFollowUp", { index: index + 1 })}
								time={clockTime(entry.timestamp ?? "")}
								followUp
							/>
						))}
					</section>
					<section className="subagent-execution" aria-label={t("subagentExecution")}>
						<h3 className="subagent-section-title">{t("subagentExecution")}</h3>
						{executionItems.length ? (
							executionItems.map((item) =>
								item.kind === "message" ? (
									<MessageItem key={item.itemId} item={item} fileCwd={transcript.value?.cwd} />
								) : item.kind === "tool" ? (
									<ToolRow key={item.itemId} item={item} readOnly />
								) : item.kind === "thinking" ? (
									<ThinkingDisclosure key={item.itemId} item={item} />
								) : item.kind === "retry" ? (
									<RetryRow key={item.itemId} item={item} />
								) : null,
							)
						) : (
							<p
								className={cx("child-agent-empty", dispatchError && "subagent-error")}
								role={dispatchError ? "alert" : undefined}
							>
								{emptyText}
							</p>
						)}
					</section>
				</div>
			</div>
		</section>
	);
}
