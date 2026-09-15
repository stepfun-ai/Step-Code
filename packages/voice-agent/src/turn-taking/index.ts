import type { Turn, VadEvent } from "@step-harness/realtime";

/**
 * When to commit a user turn (submit to the session) and when to interrupt agent
 * playback (barge-in). First-phase stub: the policy shape with trivial defaults; the
 * live logic lands with the driver in S6-4.
 */
export interface TurnTakingPolicy {
	/** True when a completed user turn should be submitted to the session. */
	shouldCommit(turn: Turn): boolean;
	/** True when incoming user speech should interrupt agent playback. */
	shouldInterrupt(vad: VadEvent): boolean;
}

export function createTurnTakingPolicy(): TurnTakingPolicy {
	return {
		shouldCommit: (turn) => turn.state === "committing",
		shouldInterrupt: (vad) => vad.state === "speech",
	};
}
