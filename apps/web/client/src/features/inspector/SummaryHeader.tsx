import { useMemo } from "react";
import { useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import type { SessionInspector } from "../../state/types";
import { Icon, Tooltip } from "../../ui";
import { summaryHeaderState } from "./model";

export function SummaryHeader({ data }: { readonly data?: SessionInspector }) {
	const t = useT();
	const sessionId = useAppStore((state) => state.current?.id);
	const items = useAppStore((state) => state.timelineItems);
	// Checklist activity follows the parent; background lanes can keep working
	// while the parent is idle and carry their own lifecycle state.
	const status = useAppStore((state) => state.current?.status);
	const { count, state } = useMemo(
		() => summaryHeaderState(sessionId ? items : [], status, data?.tasks ?? [], Boolean(data)),
		[sessionId, items, status, data],
	);
	const tasks = data?.tasks ?? [];
	const done = tasks.filter((task) => task.status === "completed").length;
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
				{sessionId && count > 0 ? (
					<Tooltip content={t("rightAgents")}>
						<span className="sb-header-agents">
							<Icon name="bot" size="xs" />
							{t("rightAgentRecords", { count })}
						</span>
					</Tooltip>
				) : null}
			</div>
		</>
	);
}
