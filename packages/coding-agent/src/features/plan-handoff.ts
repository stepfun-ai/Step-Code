/**
 * The plan review handoff as a session fact.
 *
 * A handoff leaves plan mode and ends its turn, so the proposal is no longer in
 * an assistant message: it lives in the `exit_plan_mode` tool result. Hosts that
 * report a final answer, print text mode, or decide whether to continue on their
 * own all need the same reading of that result, and a second spelling would
 * drift from the tool that writes it.
 */

import type { AgentMessage } from "@step-harness/agent-core";

/** The reviewed proposal a run handed to its caller for approval. */
export interface ExternalPlanHandoff {
	/** Model-facing handoff text: the explanation plus the reviewed plan. */
	text: string;
}

/**
 * The handoff carried by one `exit_plan_mode` result, if that result is one.
 *
 * Consumers see the tool result through different shapes (an event, a stored
 * message), so this takes the result payload itself.
 */
export function readExternalPlanHandoff(result: unknown): ExternalPlanHandoff | undefined {
	if (typeof result !== "object" || result === null) return undefined;
	const details = (result as { details?: unknown }).details;
	if (
		typeof details !== "object" ||
		details === null ||
		(details as { outcome?: unknown }).outcome !== "external_approval_required"
	) {
		return undefined;
	}
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return { text: "" };
	const text = content
		.filter((part): part is { type: "text"; text: string } => {
			if (typeof part !== "object" || part === null) return false;
			const candidate = part as { type?: unknown; text?: unknown };
			return candidate.type === "text" && typeof candidate.text === "string";
		})
		.map((part) => part.text)
		.join("\n")
		.trim();
	return { text };
}

/**
 * The handoff this session has not been answered for yet.
 *
 * Approval belongs to the caller, so a run that hands the proposal over must not
 * be continued by any automatic turn starter. The answer is the caller's next
 * user message: once one arrives, the trailing cluster no longer ends in a
 * handoff and continuation is allowed again.
 *
 * The scan is a reverse walk that stops at the first user message, so it reads
 * only the tail of the conversation.
 */
export function findPendingExternalPlanApproval(messages: readonly AgentMessage[]): ExternalPlanHandoff | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "user") return undefined;
		if (message.role !== "toolResult" || message.toolName !== "exit_plan_mode" || message.isError) continue;
		const handoff = readExternalPlanHandoff(message);
		if (handoff) return handoff;
	}
	return undefined;
}

/**
 * {@link findPendingExternalPlanApproval} for a persisted session branch.
 *
 * Walks entries backwards and examines message entries in place, stopping at the
 * first user message or at a summary. A compaction or branch summary is a
 * boundary: the entries it replaced are no longer in the model's context, so a
 * handoff behind it is not something the user can answer any more.
 */
export function hasPendingExternalPlanApproval(manager: {
	getBranch(): readonly { type: string; message?: AgentMessage }[];
}): boolean {
	const branch = manager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "compaction" || entry.type === "branch_summary") return false;
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		if (message.role === "user") return false;
		if (message.role !== "toolResult" || message.toolName !== "exit_plan_mode" || message.isError) continue;
		if (readExternalPlanHandoff(message)) return true;
	}
	return false;
}
