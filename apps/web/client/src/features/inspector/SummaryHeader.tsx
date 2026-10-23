import { useMemo } from "react";
import { useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import type { SessionInspector } from "../../state/types";
import { Icon, Tooltip } from "../../ui";
import { sessionIsLive, summaryAgentRecords } from "./model";

export function SummaryHeader({ data }: { readonly data?: SessionInspector }) {
	const t = useT();
	const sessionId = useAppStore((state) => state.current?.id);
	const items = useAppStore((state) => state.timelineItems);
	// The session's own status decides whether anything can still be running: a
	// task row or agent record keeps the status it had when the turn was stopped,
	// so only the session can say "this is over".
	const status = useAppStore((state) => state.current?.status);
	const records = useMemo(() => (sessionId ? summaryAgentRecords(items) : []), [sessionId, items]);
	const tasks = data?.tasks ?? [];
	const done = tasks.filter((task) => task.status === "completed").length;
	const sessionLive = sessionIsLive(status);
	const running =
		sessionLive &&
		(tasks.some((task) => task.status === "in_progress") || records.some((row) => row.status === "running"));
	// An interrupted turn is reported as aborted rather than silently idle; the
	// board's rows render the same verdict via effectiveTaskStatus.
	const state = running
		? "running"
		: status === "failed"
			? "aborted"
			: !data || records.some((row) => row.status === "unknown")
				? "unknown"
				: "idle";
	const label = t(state === "idle" ? "idle" : `subagentStatus.${state}`);
	return (
		<>
			<h2 className="sb-header-title">
				<Tooltip content={label}>
					<span className="sb-activity" data-state={state} role="img" aria-label={label} />
				</Tooltip>
				{t("rightSummary")}
			</h2>
			<div className="sb-header-metrics">
				{tasks.length ? (
					<Tooltip content={t("rightTaskProgress", { done, total: tasks.length })}>
						<span className="sb-header-tasks">
							{t("tasks")}{" "}
							<strong>
								{done}/{tasks.length}
							</strong>
						</span>
					</Tooltip>
				) : null}
				{records.length ? (
					<Tooltip content={t("rightAgents")}>
						<span className="sb-header-agents">
							<Icon name="bot" size="xs" />
							{t("rightAgentRecords", { count: records.length })}
						</span>
					</Tooltip>
				) : null}
			</div>
		</>
	);
}
