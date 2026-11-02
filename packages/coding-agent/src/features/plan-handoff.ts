/**
 * The plan review handoff as a session fact.
 *
 * A handoff ends its turn, so the proposal is no longer in an assistant message:
 * it lives in the `exit_plan_mode` tool result. Hosts that report a final answer
 * or print text mode need the same reading of that result, and a second spelling
 * would drift from the tool that writes it.
 *
 * Whether the user has answered is a separate session fact (the `step-plan`
 * entry's `pendingProposalHash`), because this scan cannot tell an answer from a
 * question and cannot see a decision that wrote no user message.
 */

import type { AgentMessage } from "@step-harness/agent-core";

/** The reviewed proposal a run handed to its caller for approval. */
export interface ExternalPlanHandoff {
	/** Model-facing handoff text: the explanation plus the reviewed plan. */
	text: string;
	/** Hash of the reviewed snapshot, when the result recorded one. */
	planHash?: string;
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
	const planHash = (details as { planHash?: unknown }).planHash;
	const hash = typeof planHash === "string" ? { planHash } : {};
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return { text: "", ...hash };
	const text = content
		.filter((part): part is { type: "text"; text: string } => {
			if (typeof part !== "object" || part === null) return false;
			const candidate = part as { type?: unknown; text?: unknown };
			return candidate.type === "text" && typeof candidate.text === "string";
		})
		.map((part) => part.text)
		.join("\n")
		.trim();
	return { text, ...hash };
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
 * The proposal a caller should be shown instead of the assistant's last line.
 *
 * A handoff ends the turn on its tool result, so the last assistant message only
 * introduces the submission. But "still unanswered" is the session fact, not the
 * shape of the transcript: an approval that writes no user message — a decision
 * made in a host that draws the card — would leave a scan reporting the old
 * proposal forever.
 */
export function pendingHandoffText(
	state: { pendingProposalHash?: string } | undefined,
	messages: readonly AgentMessage[],
): string | undefined {
	if (state?.pendingProposalHash === undefined) return undefined;
	return findPendingExternalPlanApproval(messages)?.text;
}

/**
 * The handoff a session written before the decision fact still leaves open.
 *
 * Only `restorePlanState` calls this, and only for an entry older than the
 * `pendingProposalHash` field: those builds recorded the wait in the transcript
 * alone, so a resumed session would otherwise resume with no gate at all. An
 * entry written by this build always carries the fact, which a decision clears
 * explicitly, and nothing else consults the transcript again.
 *
 * A `step-plan` entry after the handoff means the mode changed after it — the
 * user left, or turned planning back on — and that is not a decision this
 * function may replay.
 */
export function findLegacyUnansweredHandoff(manager: {
	getBranch(): readonly { type: string; message?: AgentMessage; customType?: string }[];
}): ExternalPlanHandoff | undefined {
	const branch = manager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "compaction" || entry.type === "branch_summary") return undefined;
		// A plan entry above the handoff is a later transition: the handoff's own
		// exit is written before its result, so it is still below.
		if (entry.type === "custom" && entry.customType === "step-plan") return undefined;
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		if (message.role === "user") return undefined;
		if (message.role !== "toolResult" || message.toolName !== "exit_plan_mode" || message.isError) continue;
		const handoff = readExternalPlanHandoff(message);
		if (handoff) return handoff;
	}
	return undefined;
}
