// Turn / TurnState — who is speaking, and the start/end of one conversational turn.

/** Which side currently holds the speaking turn. */
export type TurnSpeaker = "user" | "agent";

/** Lifecycle state of a single speaking turn. */
export type TurnState = "idle" | "listening" | "speaking" | "committing";

/** A single conversational turn on the realtime channel. */
export interface Turn {
	readonly id: string;
	readonly speaker: TurnSpeaker;
	readonly state: TurnState;
	/** Epoch millis when the turn started. */
	readonly startedAt: number;
	/** Epoch millis when the turn ended, if it has. */
	readonly endedAt?: number;
}
