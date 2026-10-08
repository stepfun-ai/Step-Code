import process from "node:process";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";

/**
 * Cloud-polled CLI login: the terminal asks the developer center to start a
 * login flow, shows the user a URL, and then polls for the result.
 *
 * Nothing is pushed to the terminal: the CLI only makes outbound HTTPS requests and never listens on a
 * port, so the flow survives SSH, containers and hosts without a browser.
 *
 * Two values with two different roles, which must never be conflated:
 *   - `flow_id`    public identifier. It travels in the browser URL, so it ends
 *                  up in history, screenshots and possibly Referer headers. It
 *                  can never be redeemed for a credential on its own.
 *   - `poll_token` the only credential on the CLI side. It appears exclusively
 *                  in the `Authorization` header and never in a URL, a log or
 *                  on disk.
 */

/** Route prefix served by the developer center (`authBaseUrl`). */
export const STEP_CLI_LOGIN_PATH_PREFIX = "/api/stdhttp/v1/cli-login";
const STEP_CLI_LOGIN_AUTHORIZE_PATH = "/cli-login-remote";

/** A stuck request must leave time for retries within the login deadline. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Both responses are small JSON documents. Cap the body so a malicious or
 * broken endpoint cannot exhaust the CLI's memory.
 */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** `flow_id` is interpolated into a request path; keep it to an opaque token. */
const FLOW_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

/** A server may slow the CLI down, but not park it for minutes at a time. */
const MAX_POLL_INTERVAL_SEC = 60;

const MAX_ERROR_DETAIL_LENGTH = 240;

/** Terminal metadata for server audit logs. Never used for authentication. */
export interface StepCliClientInfo {
	readonly name: string;
	readonly version: string;
	readonly platform: string;
}

export interface StepCliLoginInit {
	/** Public identifier; safe to print. */
	readonly flowId: string;
	/** Always `https:`, always on the developer-center origin. */
	readonly authorizeUrl: string;
	readonly pollIntervalSec: number;
	/** Unix seconds; bounds the polling deadline. */
	readonly expiresAt: number;
}

export type StepCliLoginFailureReason = "denied" | "unknown";

export type StepCliLoginPoll =
	| { readonly state: "pending" }
	| {
			readonly state: "ready";
			readonly apiKey: string;
			readonly uid?: string;
	  }
	| { readonly state: "failed"; readonly reason: StepCliLoginFailureReason };

export type StepCliLoginErrorKind =
	/** Non-2xx HTTP response, or a non-zero `status` field in a 2xx envelope. */
	| "http"
	/** 2xx response whose shape or field values do not match the protocol. */
	| "protocol"
	/** The request never produced a response. */
	| "transport";

export class StepCliLoginRequestError extends Error {
	readonly kind: StepCliLoginErrorKind;
	readonly httpStatus?: number;

	constructor(
		kind: StepCliLoginErrorKind,
		message: string,
		options: { readonly httpStatus?: number; readonly cause?: unknown } = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "StepCliLoginRequestError";
		this.kind = kind;
		if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
	}
}

/** Retry only on the statuses the protocol defines as transient. */
export function isRetryableStepCliLoginError(error: unknown): boolean {
	if (!(error instanceof StepCliLoginRequestError) || error.kind === "protocol") return false;
	const status = error.httpStatus;
	if (status === undefined) return error.kind === "transport";
	return status === 408 || status === 429 || status >= 500;
}

/** Audit metadata derived from the running process. */
export function defaultStepCliClientInfo(version: string): StepCliClientInfo {
	return {
		name: "stepcode",
		version,
		platform: `${process.platform}-${process.arch}`,
	};
}

export interface InitStepCliLoginInput {
	readonly authBaseUrl: string;
	readonly pollToken: string;
	readonly profile: string;
	readonly client: StepCliClientInfo;
	readonly signal?: AbortSignal;
	readonly fetch?: typeof fetch;
}

/** Start a login flow and obtain the URL to show the user. */
export async function initStepCliLogin(input: InitStepCliLoginInput): Promise<StepCliLoginInit> {
	const base = parseAuthBaseUrl(input.authBaseUrl);
	const payload = await request({
		phase: "init",
		url: `${base.origin}${STEP_CLI_LOGIN_PATH_PREFIX}/init`,
		method: "POST",
		pollToken: input.pollToken,
		body: {
			profile: input.profile,
			origin: base.origin,
			client: input.client,
		},
		signal: input.signal,
		fetch: input.fetch,
	});

	const flowId = readString(payload, "flow_id");
	if (!flowId || !FLOW_ID_PATTERN.test(flowId)) {
		throw protocolError("init", "response did not contain a usable flow_id");
	}
	const authorizeUrl = new URL(STEP_CLI_LOGIN_AUTHORIZE_PATH, `${base.origin}/`);
	authorizeUrl.searchParams.set("flow_id", flowId);
	const pollIntervalSec = readNumber(payload, "poll_interval_sec");
	if (pollIntervalSec === undefined || pollIntervalSec < 1) {
		throw protocolError("init", "response did not contain a poll_interval_sec of at least 1 second");
	}
	const expiresAt = readNumber(payload, "expires_at");
	if (expiresAt === undefined || expiresAt <= 0) {
		throw protocolError("init", "response did not contain an expires_at timestamp");
	}

	return {
		flowId,
		authorizeUrl: authorizeUrl.toString(),
		pollIntervalSec: Math.min(pollIntervalSec, MAX_POLL_INTERVAL_SEC),
		expiresAt,
	};
}

export interface PollStepCliLoginInput {
	readonly authBaseUrl: string;
	readonly pollToken: string;
	readonly flowId: string;
	readonly signal?: AbortSignal;
	readonly fetch?: typeof fetch;
}

/**
 * Read the current state of a flow.
 *
 * A successful poll normally deletes the flow. Persist the returned key and
 * stop polling; the protocol does not promise at-most-once concurrent delivery.
 */
export async function pollStepCliLogin(input: PollStepCliLoginInput): Promise<StepCliLoginPoll> {
	const base = parseAuthBaseUrl(input.authBaseUrl);
	if (!FLOW_ID_PATTERN.test(input.flowId)) throw protocolError("poll", "flow id has an unexpected format");
	const payload = await request({
		phase: "poll",
		url: `${base.origin}${STEP_CLI_LOGIN_PATH_PREFIX}/poll/${encodeURIComponent(input.flowId)}`,
		method: "GET",
		pollToken: input.pollToken,
		signal: input.signal,
		fetch: input.fetch,
	});

	const state = readString(payload, "state");
	if (state === "pending") return { state: "pending" };
	if (state === "failed") {
		const reason = readString(payload, "reason");
		return {
			state: "failed",
			reason: reason === "denied" ? "denied" : "unknown",
		};
	}
	if (state !== "ready") throw protocolError("poll", "response contained an unknown state");

	const credential = payload.credential;
	if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
		throw protocolError("poll", "ready response did not contain a credential object");
	}
	const apiKey = readString(credential as Record<string, unknown>, "api_key");
	if (!apiKey) throw protocolError("poll", "ready response did not contain an api_key");
	const uid = readBoundedUid(readString(payload, "uid"));
	return {
		state: "ready",
		apiKey,
		...(uid ? { uid } : {}),
	};
}

interface RequestInput {
	readonly phase: "init" | "poll";
	readonly url: string;
	readonly method: "GET" | "POST";
	readonly pollToken: string;
	readonly body?: unknown;
	readonly signal?: AbortSignal;
	readonly fetch?: typeof fetch;
}

async function request(input: RequestInput): Promise<Record<string, unknown>> {
	return withStepCliLoginTimeout(
		REQUEST_TIMEOUT_MS,
		input.signal,
		() => new StepCliLoginRequestError("transport", "Step CLI login request timed out"),
		async (signal) => {
			const pollToken = input.pollToken.trim();
			if (!pollToken) throw new Error("Step CLI login poll token must not be empty");
			const fetchFn = input.fetch ?? globalThis.fetch.bind(globalThis);
			let response: Response;
			try {
				response = await fetchFn(input.url, {
					method: input.method,
					redirect: "error",
					credentials: "omit",
					signal,
					headers: {
						accept: "application/json",
						authorization: `Bearer ${pollToken}`,
						...(input.body === undefined ? {} : { "content-type": "application/json" }),
					},
					...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
				});
			} catch (error) {
				signal.throwIfAborted();
				throw new StepCliLoginRequestError(
					"transport",
					`Step CLI login ${input.phase} request failed: ${error instanceof Error ? error.message : String(error)}`,
					{ cause: error },
				);
			}
			let text = "";
			try {
				text = await readBoundedText(response, input.phase);
			} catch (error) {
				signal.throwIfAborted();
				// An error response's body is optional; HTTP status must still decide retries.
				if (response.ok) {
					if (error instanceof StepCliLoginRequestError) throw error;
					throw new StepCliLoginRequestError("transport", "Step CLI login response was interrupted", {
						cause: error,
					});
				}
			}
			let parsed: unknown;
			try {
				parsed = text.trim() ? JSON.parse(text) : undefined;
			} catch (error) {
				if (response.ok) throw protocolError(input.phase, "response was not valid JSON", error);
			}
			if (!response.ok) {
				throw new StepCliLoginRequestError(
					"http",
					`Step CLI login request failed (HTTP ${response.status})${envelopeDetail(parsed)}`,
					{ httpStatus: response.status },
				);
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
				throw protocolError(input.phase, "response was not a JSON object");
			const payload = parsed as Record<string, unknown>;
			if (payload.status !== undefined && payload.status !== 0) {
				throw new StepCliLoginRequestError("http", `Step CLI login was rejected${envelopeDetail(payload)}`, {
					httpStatus: response.status,
				});
			}
			return payload;
		},
	);
}

/** Read at most {@link MAX_RESPONSE_BYTES}, refusing anything larger. */
async function readBoundedText(response: Response, phase: "init" | "poll"): Promise<string> {
	const declared = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
		void response.body?.cancel().catch(() => {});
		throw protocolError(phase, "response exceeded the maximum size");
	}
	const body = response.body;
	if (!body) return "";
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) {
				throw protocolError(phase, "response exceeded the maximum size");
			}
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return Buffer.concat(chunks).toString("utf8");
}

function parseAuthBaseUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Step OAuth authorization endpoint must be a valid URL");
	}
	if (url.protocol !== "https:") {
		throw new Error("Step CLI login authorization endpoint must use https");
	}
	if (url.username || url.password) {
		throw new Error("Step OAuth authorization endpoint must not contain credentials");
	}
	return url;
}

function protocolError(phase: "init" | "poll", detail: string, cause?: unknown): StepCliLoginRequestError {
	return new StepCliLoginRequestError("protocol", `Step CLI login ${phase} ${detail}`, {
		...(cause === undefined ? {} : { cause }),
	});
}

function envelopeDetail(payload: unknown): string {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
	const desc = readString(payload as Record<string, unknown>, "desc");
	return desc ? `: ${desc.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, MAX_ERROR_DETAIL_LENGTH)}` : "";
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
	const result = value[key];
	return typeof result === "string" && result.trim() ? result.trim() : undefined;
}

function readNumber(value: Record<string, unknown>, key: string): number | undefined {
	const result = value[key];
	return typeof result === "number" && Number.isFinite(result) ? result : undefined;
}

/** Bound the account identifier before it reaches local credential storage. */
function readBoundedUid(value: string | undefined): string | undefined {
	if (!value || value.length > 64 || !/^[\w.@:-]+$/u.test(value)) return undefined;
	return value;
}

/** Bound both fetch and body reads, and clean up timers/listeners on every exit. */
export async function withStepCliLoginTimeout<T>(
	timeoutMs: number,
	signal: AbortSignal | undefined,
	timeoutError: () => Error,
	run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const timeout = new AbortController();
	const combined = combineAbortSignals([signal, timeout.signal]);
	const active = combined.signal!; // timeout.signal is always present
	const timer = setTimeout(() => timeout.abort(timeoutError()), Math.max(0, timeoutMs));
	try {
		active.throwIfAborted();
		return await raceWithAbortSignal(run(active), active);
	} finally {
		clearTimeout(timer);
		combined.cleanup();
	}
}
