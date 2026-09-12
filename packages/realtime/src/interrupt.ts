// InterruptSignal — a request to cut the current turn short (barge-in).

/** What raised an interrupt. */
export type InterruptSource = "user-speech" | "user-key" | "host" | "vad";

/** A request to interrupt the in-flight turn. */
export interface InterruptSignal {
	readonly source: InterruptSource;
	/** Epoch millis when the interrupt was raised. */
	readonly at: number;
	/** Optional human-readable reason. */
	readonly reason?: string;
}
