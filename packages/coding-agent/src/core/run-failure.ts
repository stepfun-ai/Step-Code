import type { IncompleteTurnReason } from "@step-harness/providers";

/**
 * Why a run ended without a usable answer, when the transcript cannot say it.
 *
 * A provider error reaches hosts as the last assistant message's `stopReason`.
 * An incomplete turn cannot: its message keeps the provider's own stop reason,
 * because the run's outcome is a session decision, not a provider fact. Hosts
 * that map a settled run to an exit code, a lane status, or a goal status read
 * this instead of inferring success from the transcript.
 */
export interface AgentRunFailure {
	kind: "incomplete_turn";
	reason: IncompleteTurnReason;
	message: string;
}
