import type { Api, Model } from "@step-harness/providers/compat";

/** The HTTP fetch a provider adapter uses for one model request. */
export type ModelFetch = typeof globalThis.fetch;

/** What a place in a server-side line is doing: waiting for its turn, or admitted and about to run. */
export type ModelQueuePhase = "waiting" | "ready";

/** A model request in a server-side line before it runs. */
export interface ModelQueueState {
	/** `waiting` for its turn in line, or `ready`: the server admitted the place and the request is about to run. */
	readonly state: ModelQueuePhase;
	/** Place in line, when the server reported one. A place that is `ready` has none left. */
	readonly position?: number;
}

/** How a request left a server-side line, when the server ended its place. */
export interface ModelQueueExit {
	/** The server's stable code for closing the place (for example `queue_full`). */
	readonly closedReason?: string;
}

/** Receives a session's queue reports; see {@link ModelFetchRequest.reportQueue}. */
export type ModelQueueListener = (queueId: string, state: ModelQueueState | null, exit?: ModelQueueExit) => void;

/** What a {@link ModelFetchFactory} learns about the model request it wraps. */
export interface ModelFetchRequest {
	readonly model: Model<Api>;
	/**
	 * Cancellation of the logical request (user stop, stream watchdog). The SDK
	 * passes its own per-attempt signal on `init.signal`, which also carries the
	 * SDK's request timeout; a wrapper that holds a request must tell the two apart.
	 */
	readonly signal: AbortSignal;
	/** The fetch the request would use without the wrapper. */
	readonly fetch: ModelFetch;
	/**
	 * Suspend the stream idle watchdog while the request is deliberately held
	 * before the provider answers. Returns the release function.
	 */
	readonly holdIdleWatchdog: () => () => void;
	/**
	 * Report that the request waits in a server-side line (`state`: waiting, with
	 * its place; or ready, once admitted and about to run), or left it (`null`,
	 * with `exit.closedReason` when the server closed the place). The session
	 * publishes each report as a `model_queue` event. `queueId` is the wrapper's
	 * id for one place in line (an HTTP call it wraps); one model request may
	 * make several.
	 */
	readonly reportQueue: ModelQueueListener;
	/**
	 * Register work the request still owes after its caller stopped waiting (see
	 * `request-teardowns.ts`); disposing the session awaits it, with a bound.
	 */
	readonly registerTeardown: (task: Promise<unknown>) => void;
}

/**
 * Host hook that wraps the HTTP fetch of each model request. Returning
 * `undefined` leaves the request unchanged. Not installed by default.
 */
export type ModelFetchFactory = (request: ModelFetchRequest) => ModelFetch | undefined;

/**
 * Connects the wrappers of a session's model requests to the session that
 * publishes their queue reports. The session connects once it exists; reports
 * made before that (or after the session was disposed) are dropped.
 */
export class ModelQueueChannel {
	private listener: ModelQueueListener | undefined;

	connect(listener: ModelQueueListener | undefined): void {
		this.listener = listener;
	}

	report(queueId: string, state: ModelQueueState | null, exit?: ModelQueueExit): void {
		this.listener?.(queueId, state, exit);
	}
}
