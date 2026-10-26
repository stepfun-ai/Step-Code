import { useMemo } from "react";
import { useT } from "../../i18n";
import { useAppStore } from "../../state/store";
import { Icon } from "../../ui";
import { SubagentStatusIcon } from "../conversation";
import { summaryAgentRecords } from "./model";
import { openAgentRecord } from "./open-agent";

export function SummaryAgents() {
	const t = useT();
	const sessionId = useAppStore((state) => state.current?.id);
	const items = useAppStore((state) => state.timelineItems);
	const records = useMemo(() => (sessionId ? summaryAgentRecords(items) : []), [sessionId, items]);
	return (
		<section className="sb-agents" aria-label={t("rightAgents")}>
			<div className="sb-section-heading">
				<h3>{t("rightAgents")}</h3>
				<span>{t("rightAgentRecords", { count: records.length })}</span>
			</div>
			<ul>
				{records.map((record) => (
					<li key={record.key}>
						<button
							type="button"
							className="sb-agent-row"
							data-agent-status={record.status}
							aria-label={t("subagentOpenRecord", {
								status: t(`subagentStatus.${record.status}`),
								task: record.task || t("subagentNoTask"),
							})}
							onClick={() => openAgentRecord(record)}
						>
							<Icon name="bot" size="xs" />
							<SubagentStatusIcon status={record.status} />
							<span className="sb-agent-text">
								<span className="sb-agent-heading">
									<strong>{record.agent || t("subagent")}</strong>
									<small>{t(`subagentStatus.${record.status}`)}</small>
								</span>
								<span className="sb-agent-task">{record.task || t("subagentNoTask")}</span>
							</span>
							<Icon name="disclosure" size="xs" className="sb-agent-chevron" />
						</button>
					</li>
				))}
			</ul>
			{!records.length ? <p className="sb-state">{t(sessionId ? "rightNoAgents" : "rightNoSession")}</p> : null}
		</section>
	);
}
