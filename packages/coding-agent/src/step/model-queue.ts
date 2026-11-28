import { randomUUID } from "node:crypto";
import type { ModelFetch, ModelFetchFactory, ModelFetchRequest, ModelQueueState } from "../core/model-fetch.ts";

/**
 * Client side of the Step model request queue.
 *
 * Every model request sent to Step's mainland or overseas API host carries a
 * fresh `X-StepCode-Queue-ID`, whichever provider
 * (the official one or a user's own) sent it: the host, not the provider id,
 * makes it a StepCode request. There is no client switch: whether a request
 * waits is the server's decision alone. When the pool is busy it answers HTTP 429 with
 * `X-StepCode-Queue-State: waiting` instead of running the request. That answer
 * is not a rate-limit failure: the request holds a place in line. The wrapper
 * then polls the queue of the request's region
 * (`GET https://api.stepfun.com/stepcode/v1/queue`, or `api.stepfun.ai`
 * overseas, naming the place in `X-StepCode-Queue-ID`), and once the place is
 * `ready` sends the original bytes again under the same id. The poll interval is
 * the server's `retry_after_ms` (5 s when it names none). A `closed` place (a
 * poll, or a 429 with `X-StepCode-Queue-State: closed` on the first send or a
 * resend) ends the call with an error naming the reason. A call waits in line at most 20 minutes in all; when it
 * stops waiting on its own side (the caller's stop, that bound, or a status
 * endpoint that keeps failing) it releases the place with `POST <queue>/cancel`
 * (the id in `X-StepCode-Queue-ID`, no body). A stop before any queued answer
 * sends nothing more: the server's lease ends a place nobody saw.
 *
 *   POST .../chat/completions          -> 429 queued (position 3)
 *   GET  <queue>   (X-StepCode-Queue-ID) -> waiting (position 1)
 *   GET  <queue>   (X-StepCode-Queue-ID) -> ready     (reported as `ready`: admitted)
 *   POST .../chat/completions          -> 200 stream (same id, same body)
 *
 * A request to any other host (an endpoint override) is sent as it is, without
 * the header. Any other response, including an ordinary 429, keeps its status,
 * codes and headers so the existing retry policy handles it; a 429 carrying
 * `X-StepCode-Limit-Scope` only gains a leading sentence on whose limit it hit
 * (the user's own quota, or Step's capacity).
 */

const QUEUE_ID_HEADER = "x-stepcode-queue-id";
const STATE_HEADER = "x-stepcode-queue-state";
const POSITION_HEADER = "x-stepcode-queue-position";
const REASON_HEADER = "x-stepcode-queue-reason";
const LIMIT_SCOPE_HEADER = "x-stepcode-limit-scope";
const RETRY_AFTER_HEADER = "retry-after-ms";
/** Request headers that describe the model request's body; the control requests carry their own. */
const BODY_HEADERS = new Set(["content-length", "content-type", "content-encoding", "transfer-encoding", "accept"]);
/**
 * The queue endpoint of each Step API host, by the model request's host name.
 * Fixed on purpose: the queue exists only on these public hosts, so it is keyed
 * by them and never by configuration. Telemetry's endpoint classification
 * (`isStepPlatformUrl`) also follows configured proxies; the two are kept apart
 * deliberately, and a request to any other host is never queued.
 */
const QUEUE_ENDPOINTS: Readonly<Record<string, string>> = {
	"api.stepfun.com": "https://api.stepfun.com/stepcode/v1/queue",
	"api.stepfun.ai": "https://api.stepfun.ai/stepcode/v1/queue",
};
/** Poll interval when the server names none. */
const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** Upper bound of a server-named poll interval, so one bad value cannot stall a waiting call. */
const MAX_POLL_INTERVAL_MS = 30_000;
/** How long one call may wait in line in all, from the server's first queued answer. */
const DEFAULT_MAX_WAIT_MS = 20 * 60_000;
const POLL_TIMEOUT_MS = 10_000;
const FIRST_POLL_BACKOFF_MS = 1_000;
const MAX_POLL_BACKOFF_MS = 8_000;
const DEFAULT_POLL_FAILURE_BUDGET_MS = 30_000;
/** Upper bound of releasing a place on a stop; the stopped call (and a disposing session) waits this long at most. */
const CANCEL_TIMEOUT_MS = 1_000;
/** Status of the synthesized response that ends a queued call: no SDK or session retry re-enters the queue. */
const QUEUE_ENDED_STATUS = 410;

/**
 * Why a place in line ended, as Step names it (`X-StepCode-Queue-Reason` on a generation answer, `reason` in a
 * status answer). A fixed list shared with the server: only reasons a user can act on are named; any other
 * closed place carries no reason and reads as the generic text. A wait this side gives up after 20 minutes is
 * `max_wait_exceeded` as well.
 */
export type StepQueueClosedReason = "queue_full" | "user_limit" | "max_wait_exceeded";

/** Whose limit a throttled Step request hit (`X-StepCode-Limit-Scope`). A fixed list shared with the server. */
export type StepLimitScope = "user_quota" | "upstream_capacity";

/** Readable text for every reason the server names; a new reason fails to compile until it has its text. */
const CLOSED_REASON_TEXT: Readonly<Record<StepQueueClosedReason, string>> = {
	queue_full: "The request queue is full. Try again later.",
	user_limit: "You have too many requests waiting in line. Wait for them to finish and try again.",
	max_wait_exceeded: "The request waited in line too long. Try again later.",
};
/** What a throttled Step request ran into, by the server's limit scope; leads the server's own message. */
const LIMIT_SCOPE_TEXT: Readonly<Record<StepLimitScope, string>> = {
	user_quota: "Your Step usage limit was reached.",
	upstream_capacity: "Step is at capacity right now.",
};
const CLOSED_GENERIC_TEXT = "The request left the queue. Send it again.";

/** A reason off the wire, or undefined for an absent or unknown one (read as the generic text). */
function closedReasonFrom(value: unknown): StepQueueClosedReason | undefined {
	const code = typeof value === "string" ? value.trim().toLowerCase() : "";
	return Object.hasOwn(CLOSED_REASON_TEXT, code) ? (code as StepQueueClosedReason) : undefined;
}

function limitScopeFrom(value: unknown): StepLimitScope | undefined {
	const scope = typeof value === "string" ? value.trim().toLowerCase() : "";
	return Object.hasOwn(LIMIT_SCOPE_TEXT, scope) ? (scope as StepLimitScope) : undefined;
}

/** The message for a closed place, keeping the reason code itself for diagnosis. */
export function stepModelQueueClosedMessage(reason?: StepQueueClosedReason): string {
	return reason ? `${CLOSED_REASON_TEXT[reason]} (${reason})` : CLOSED_GENERIC_TEXT;
}

/** The status line for a request in line: its place while it waits, never a wait estimate; a request the server admitted is starting. */
export function stepModelQueueStatusText(state: ModelQueueState): string {
	if (state.state === "ready") return "Starting...";
	return state.position !== undefined && state.position > 0 ? `Queued: position ${state.position}` : "Queued";
}

/** Hooks for tests; not configuration. */
export interface StepModelQueueOptions {
	/** Replaces the fixed queue endpoints, by request host name. */
	readonly queueEndpoints?: Readonly<Record<string, string>>;
	/** How long polling may fail in a row before the call ends with an error. Default 30s. */
	readonly pollFailureBudgetMs?: number;
	/** How long one call may wait in line in all. Default 20 minutes. */
	readonly maxWaitMs?: number;
	readonly queueId?: () => string;
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	readonly now?: () => number;
}

/**
 * The model-fetch factory every Step entry point installs. The wrapper tags and
 * queues only requests to Step's API hosts and passes every other one on as it is.
 */
export function createStepModelQueueFactory(
	/** Test hooks; see {@link StepModelQueueOptions}. */
	testing: StepModelQueueOptions = {},
): ModelFetchFactory {
	return (request) => createStepModelQueueFetch(request, testing);
}

/**
 * Whether a URL is one of the queue's own control endpoints. A control request
 * passed to the wrapper goes out as it is: never given a new queue id, held or
 * queued (the wrapper's own control requests carry the id of the place they ask about).
 */
function isQueueControl(url: URL, queue: string): boolean {
	const path = new URL(queue).pathname;
	return url.pathname === path || url.pathname.startsWith(`${path}/`);
}

function requestUrl(input: Parameters<ModelFetch>[0]): URL | undefined {
	try {
		return new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input);
	} catch {
		return undefined;
	}
}

function nonNegativeInteger(value: unknown): number | undefined {
	const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function pollInterval(value: unknown): number {
	const ms = nonNegativeInteger(value);
	return ms === undefined || ms === 0 ? DEFAULT_POLL_INTERVAL_MS : Math.min(ms, MAX_POLL_INTERVAL_MS);
}

function queueState(response: Response): string | undefined {
	return response.status === 429 ? response.headers.get(STATE_HEADER)?.trim().toLowerCase() : undefined;
}

function isQueued(response: Response): boolean {
	return queueState(response) === "waiting";
}

function isClosed(response: Response): boolean {
	return queueState(response) === "closed";
}

/**
 * A Step answer that is not a queued one. A place the server closed ends the call like a closed poll; any
 * other throttled answer keeps its status, codes and headers (so the retry policy sees what it always saw)
 * and only gains a leading sentence on whose limit it hit.
 */
async function settle(response: Response): Promise<Response> {
	if (isClosed(response)) {
		await response.body?.cancel().catch(() => {});
		return queueEnded(closedReasonFrom(response.headers.get(REASON_HEADER)));
	}
	return await withLimitScope(response);
}

async function withLimitScope(response: Response): Promise<Response> {
	const scope = response.status === 429 ? limitScopeFrom(response.headers.get(LIMIT_SCOPE_HEADER)) : undefined;
	if (!scope) return response;
	const text = await response.text();
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		body = undefined;
	}
	const error = body && typeof body === "object" ? Reflect.get(body, "error") : undefined;
	const message = error && typeof error === "object" ? Reflect.get(error, "message") : undefined;
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	headers.delete("content-encoding");
	if (typeof message !== "string")
		return new Response(text, { status: response.status, statusText: response.statusText, headers });
	Reflect.set(error as object, "message", `${LIMIT_SCOPE_TEXT[scope]} ${message}`);
	return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers });
}

/** The cancellation to throw: always an Error, as callers and SDKs test `instanceof Error`. */
function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	if (reason instanceof Error) return reason;
	return new DOMException(reason === undefined ? "This operation was aborted" : String(reason), "AbortError");
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(abortError(signal));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError(signal));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** The 410 that ends a call; the message is the closed text unless this side names its own failure. */
function queueEnded(reason?: StepQueueClosedReason, message = stepModelQueueClosedMessage(reason)): Response {
	return new Response(
		JSON.stringify({ error: { message, type: "queue_closed", code: "queue_closed", ...(reason ? { reason } : {}) } }),
		{
			status: QUEUE_ENDED_STATUS,
			headers: { "content-type": "application/json", "x-should-retry": "false" },
		},
	);
}

interface QueueStatus {
	readonly state: "waiting" | "ready" | "closed";
	readonly position?: number;
	readonly retryAfterMs: number;
	readonly reason?: StepQueueClosedReason;
}

function readQueueStatus(value: unknown): QueueStatus | undefined {
	if (!value || typeof value !== "object") return undefined;
	const state = Reflect.get(value, "state");
	if (state !== "waiting" && state !== "ready" && state !== "closed") return undefined;
	const reason = Reflect.get(value, "reason");
	return {
		state,
		position: nonNegativeInteger(Reflect.get(value, "position")),
		retryAfterMs: pollInterval(Reflect.get(value, "retry_after_ms")),
		reason: closedReasonFrom(reason),
	};
}

/**
 * Wrap one Step model request's fetch with the queue protocol. The control
 * requests are sent on the unwrapped fetch and are never tagged or held.
 */
export function createStepModelQueueFetch(
	request: Pick<ModelFetchRequest, "signal" | "fetch" | "holdIdleWatchdog" | "reportQueue" | "registerTeardown">,
	options: StepModelQueueOptions = {},
): ModelFetch {
	const base = request.fetch;
	const caller = request.signal;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;
	const failureBudgetMs = options.pollFailureBudgetMs ?? DEFAULT_POLL_FAILURE_BUDGET_MS;
	const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
	return async (input, init) => {
		// Decided from the URL alone, so a request that is not queued is passed on
		// without copying its body.
		const url = requestUrl(input);
		const endpoints = options.queueEndpoints ?? QUEUE_ENDPOINTS;
		const queueBase = url && Object.hasOwn(endpoints, url.hostname) ? endpoints[url.hostname] : undefined;
		if (!url || !queueBase || isQueueControl(url, queueBase)) return base(input, init);
		return queuedFetch(input, init, queueBase);
	};

	async function queuedFetch(
		input: Parameters<ModelFetch>[0],
		init: Parameters<ModelFetch>[1],
		queueBase: string,
	): Promise<Response> {
		const original = new Request(input, init);
		const queueId = (options.queueId ?? randomUUID)();
		const headers = new Headers(original.headers);
		headers.set(QUEUE_ID_HEADER, queueId);
		// Captured once: every resend carries exactly these bytes.
		const body = original.body ? new Uint8Array(await original.arrayBuffer()) : undefined;
		// A `Request` input carries its own signal; `original` follows it as well as `init.signal`.
		const attempt = init?.signal ?? original.signal;
		const send = (signal: AbortSignal | undefined) =>
			base(original.url, {
				...init,
				method: original.method,
				headers,
				...(body ? { body: body.slice() } : {}),
				...(signal ? { signal } : {}),
			});
		// The model request's own credentials and routing headers authorize the
		// control requests; what describes its body does not apply to them. Both
		// name the place by its queue id header (no query, no body); they go out on
		// the unwrapped fetch, so they are never queued themselves.
		const controlHeaders = new Headers({ accept: "application/json" });
		for (const [name, value] of original.headers) {
			if (!BODY_HEADERS.has(name)) controlHeaders.set(name, value);
		}
		controlHeaders.set(QUEUE_ID_HEADER, queueId);
		// Leave the line so the place is not held until its lease expires. Sent only
		// once the server has queued this call, so a host without the queue never
		// sees it, and only when this side stops waiting (a stop, the wait bound, or
		// a status endpoint that keeps failing); a place the server closed is gone
		// already. Awaited (within CANCEL_TIMEOUT_MS) so a process exiting on the
		// stop sends it; its outcome changes nothing for the call, so failures are
		// dropped.
		const leave = async (): Promise<void> => {
			try {
				const response = await base(`${queueBase}/cancel`, {
					method: "POST",
					headers: controlHeaders,
					signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
				});
				await response.body?.cancel().catch(() => {});
			} catch {
				// Unreachable or too slow: the server's lease ends the place instead.
			}
		};

		// A stop during the first send is the caller's alone: nothing says the server
		// queued the call, and if it did, its lease ends the place.
		const first = await send(attempt);
		if (!isQueued(first)) return await settle(first);
		// From here the call holds a place in line until it settles, and a stop must
		// release it: the settlement is a teardown the disposing session awaits.
		let settled = () => {};
		request.registerTeardown(
			new Promise<void>((resolve) => {
				settled = resolve;
			}),
		);
		// The idle watchdog is held only while the call waits in line; a resend is
		// an ordinary request again and stays under the idle bound.
		let release: (() => void) | undefined;
		const hold = () => {
			release ??= request.holdIdleWatchdog();
		};
		const unhold = () => {
			const current = release;
			release = undefined;
			current?.();
		};
		hold();
		let position = nonNegativeInteger(first.headers.get(POSITION_HEADER));
		let delay = pollInterval(first.headers.get(RETRY_AFTER_HEADER));
		await first.body?.cancel().catch(() => {});
		// Reports go out only when what a reader sees changes: being in line, the
		// phase (waiting or admitted), and the place in line.
		let reported: ModelQueueState | null = null;
		const publish = (next: ModelQueueState | null, closedReason?: StepQueueClosedReason) => {
			if (next?.state === reported?.state && next?.position === reported?.position) return;
			reported = next;
			try {
				request.reportQueue(queueId, next, ...(closedReason === undefined ? [] : [{ closedReason }]));
			} catch {
				// Presentation must not change the request.
			}
		};
		// Still in line: its place, when the server named one.
		const publishWaiting = () =>
			publish(position === undefined ? { state: "waiting" } : { state: "waiting", position });
		// Admitted: the place in line is gone and the request is about to run.
		const publishReady = () => {
			position = undefined;
			publish({ state: "ready" });
		};
		publishWaiting();
		let closedReason: StepQueueClosedReason | undefined;
		// This side stops waiting: release the place, then end the call like a closed one.
		const giveUp = async (reason?: StepQueueClosedReason, message?: string): Promise<Response> => {
			closedReason = reason;
			await leave();
			return queueEnded(reason, message);
		};
		// One bound for the whole wait, across every resend that is queued again.
		const deadline = now() + maxWaitMs;
		try {
			let lastSuccess = now();
			let failures = 0;
			let lastFailure = "";
			for (;;) {
				const remaining = deadline - now();
				if (remaining <= 0) return await giveUp("max_wait_exceeded");
				// The SDK's per-attempt signal also carries its request timeout, which
				// must not end a wait in line: only the caller's cancellation does.
				await sleep(Math.min(delay, remaining), caller);
				if (deadline - now() <= 0) continue;
				let status: QueueStatus | undefined;
				try {
					const response = await base(queueBase, {
						method: "GET",
						headers: controlHeaders,
						signal: AbortSignal.any([caller, AbortSignal.timeout(POLL_TIMEOUT_MS)]),
					});
					if (response.ok) {
						status = readQueueStatus(await response.json().catch(() => undefined));
						if (!status) lastFailure = "invalid queue status";
					} else if (response.status === 401 || response.status === 403) {
						// A credential problem is the caller's to see, as it would be on the model route.
						return response;
					} else {
						await response.body?.cancel().catch(() => {});
						// The place is gone: the same as a closed place.
						if (response.status === 404) status = { state: "closed", retryAfterMs: delay };
						// A throttled or failing status endpoint is retried; other answers
						// cannot improve by asking again.
						else if (response.status !== 429 && response.status < 500)
							return await giveUp(undefined, `Queue status request failed with HTTP ${response.status}`);
						else lastFailure = `HTTP ${response.status}`;
					}
				} catch (error) {
					if (caller.aborted) throw abortError(caller);
					lastFailure = error instanceof Error ? error.message : String(error);
				}
				if (!status) {
					if (now() - lastSuccess >= failureBudgetMs)
						return await giveUp(undefined, `Queue status unavailable: ${lastFailure}`);
					delay = Math.min(FIRST_POLL_BACKOFF_MS * 2 ** failures, MAX_POLL_BACKOFF_MS);
					failures++;
					continue;
				}
				lastSuccess = now();
				failures = 0;
				delay = status.retryAfterMs;
				if (status.state === "closed") {
					closedReason = status.reason;
					return queueEnded(status.reason);
				}
				if (status.state === "waiting") {
					position = status.position ?? position;
					publishWaiting();
					continue;
				}
				// Admitted: say so before the resend goes out, so a reader sees the
				// place turn into a starting request instead of vanishing.
				publishReady();
				// The SDK's per-attempt signal joins the resend only while it is live: an
				// abort it already carries is its request timeout expiring in line.
				unhold();
				const response = await send(attempt && !attempt.aborted ? AbortSignal.any([caller, attempt]) : caller);
				if (!isQueued(response)) {
					// The server closed the place on the resend (the wait bound, say): end the call, never re-enter
					// the line under a new id through a retry.
					if (isClosed(response)) closedReason = closedReasonFrom(response.headers.get(REASON_HEADER));
					return await settle(response);
				}
				hold();
				position = nonNegativeInteger(response.headers.get(POSITION_HEADER)) ?? position;
				delay = pollInterval(response.headers.get(RETRY_AFTER_HEADER));
				void response.body?.cancel().catch(() => {});
				publishWaiting();
			}
		} catch (error) {
			if (caller.aborted) {
				await leave();
				throw abortError(caller);
			}
			throw error;
		} finally {
			publish(null, closedReason);
			unhold();
			settled();
		}
	}
}
