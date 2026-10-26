/**
 * Opening an agent record, from wherever the user picked it.
 *
 * Two surfaces list the same agents — the Summary board and the rail's subagent
 * panel — and both have to land on the same view. The mapping from a record to
 * its entry point therefore lives here once, instead of once per surface.
 */

import { openChildAgent, openSubagentTask, openWorkflowAgents } from "../conversation/actions";
import type { SummaryAgentRecord } from "./model";

export function openAgentRecord(record: SummaryAgentRecord): void {
	const target = record.target;
	if (target.kind === "task") openSubagentTask(target.toolItemId, target.taskIndex);
	else if (target.kind === "child") openChildAgent(target.sessionId, record.agent);
	else openWorkflowAgents(target.runId, record.agent);
}
