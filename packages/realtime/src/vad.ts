// VAD (voice activity detection) — silence-detection state, events, thresholds.

/** Current voice-activity state. */
export type VadState = "silence" | "speech";

/** A voice-activity transition event. */
export interface VadEvent {
	readonly state: VadState;
	/** Epoch millis of the transition. */
	readonly at: number;
	/** Detector confidence in [0, 1], if the driver reports it. */
	readonly confidence?: number;
}

/** Tunable thresholds for a VAD detector. */
export interface VadThresholds {
	/** Speech-probability threshold above which a frame counts as speech. */
	readonly speechProbability: number;
	/** Trailing silence (ms) before a turn is considered ended. */
	readonly silenceHangoverMs: number;
}
