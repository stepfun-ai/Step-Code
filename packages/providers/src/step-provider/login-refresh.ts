/**
 * Refresh the account session that `step login` delivered beside the API key.
 *
 * Passport's `RefreshToken` takes no request body: the refresh credential
 * travels in the `Oasis-Token` cookie, which is the access and refresh JWTs
 * joined by `...`. A CLI has no cookie jar, so it rebuilds that cookie value
 * from the two tokens it stored and reads the new pair from the response body.
 *
 * Two behaviours are load-bearing and easy to get wrong:
 *   - A refresh that cannot be redeemed does not fail. Passport answers 200
 *     with `mode: ANONYMOUS` and a different account id, so callers must check
 *     the mode instead of trusting the status code.
 *   - The refresh token is not rotated. Persisting the returned one is still
 *     correct and keeps working if that ever changes.
 */

import { parseAuthBaseUrl, type StepCliLoginState } from "./login-client.ts";

/** Route prefix the gateway serves passport under, for both regions. */
const PASSPORT_PATH_PREFIX = "/passport";

/** Connect-RPC procedure the developer center's login page calls. */
const PASSPORT_REFRESH_PATH = `${PASSPORT_PATH_PREFIX}/proto.api.passport.v1.PassportService/RefreshToken`;

/** Access-token lifetime the server reports when it omits `expires_in`. */
const DEFAULT_ACCESS_TOKEN_TTL_SEC = 30 * 60;

/** A stuck refresh must not hold the credential lock or block a request. */
const REFRESH_TIMEOUT_MS = 15_000;

/** Passport's `Mode` enum; only a signed-in session is usable. */
const MODE_SIGN_IN = 2;

export type StepLoginRefreshFailure =
	/** The session can no longer be redeemed; only a new sign-in recovers. */
	| "unredeemable"
	/** Transport or server-side problem; the session may still refresh later. */
	| "transient";

/**
 * Thrown when a refresh cannot be completed.
 *
 * `unredeemable` is reserved for the one answer that positively proves the
 * session is dead: an anonymous mode. Everything else — any HTTP failure, an
 * unexpected body, a missing refresh token — is `transient`, because deleting a
 * long-lived credential on a guess costs the user a full re-login while keeping
 * it costs at most one retried request.
 */
export class StepLoginRefreshError extends Error {
	readonly failure: StepLoginRefreshFailure;
	readonly httpStatus?: number;

	constructor(
		failure: StepLoginRefreshFailure,
		message: string,
		options: { httpStatus?: number; cause?: unknown } = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "StepLoginRefreshError";
		this.failure = failure;
		if (options.httpStatus !== undefined) this.httpStatus = options.httpStatus;
	}
}

export interface RefreshStepLoginStateInput {
	readonly authBaseUrl: string;
	readonly state: StepCliLoginState;
	readonly signal?: AbortSignal;
	readonly fetch?: typeof fetch;
}

/**
 * Exchange the stored session for a fresh one.
 *
 * Throws when the session can no longer be redeemed, which is the caller's
 * signal to drop the local login state and ask the user to sign in again.
 */
export async function refreshStepLoginState(input: RefreshStepLoginStateInput): Promise<StepCliLoginState> {
	const base = parseAuthBaseUrl(input.authBaseUrl);
	const controller = new AbortController();
	// A caller that already gave up must not leave the request running: the
	// abort event has fired before the listener exists, so it is checked here.
	if (input.signal?.aborted) controller.abort(input.signal.reason);
	const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	input.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await (input.fetch ?? globalThis.fetch.bind(globalThis))(
			`${base.origin}${PASSPORT_REFRESH_PATH}`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"connect-protocol-version": "1",
					// The cookie carries both halves; header casing follows the
					// gateway's own expectations.
					cookie: `Oasis-Token=${input.state.accessToken}...${input.state.refreshToken}`,
					"Oasis-appID": input.state.appId,
					"Oasis-Platform": "web",
					"Oasis-Webid": input.state.deviceId,
				},
				body: "{}",
				signal: controller.signal,
			},
		);
		if (!response.ok) {
			// Every HTTP failure is treated as transient. The only signal that a
			// session is truly dead is a 200 carrying an anonymous mode, which was
			// verified against the live service; a 4xx here is far more likely to
			// be a gateway, region or WAF rejection, and dropping a long-lived
			// refresh token on that guess would sign the user out for no reason.
			throw new StepLoginRefreshError("transient", `Step login state refresh failed (HTTP ${response.status})`, {
				httpStatus: response.status,
			});
		}
		const payload: unknown = await response.json().catch((cause: unknown) => {
			throw new StepLoginRefreshError("transient", "Step login state refresh returned an unreadable body", {
				cause,
			});
		});
		return parseRefreshResponse(payload, input.state);
	} finally {
		clearTimeout(timer);
		input.signal?.removeEventListener("abort", onAbort);
	}
}

function parseRefreshResponse(payload: unknown, previous: StepCliLoginState): StepCliLoginState {
	const record =
		payload && typeof payload === "object" && !Array.isArray(payload)
			? (payload as Record<string, unknown>)
			: undefined;
	const access = record ? readToken(record.accessToken) : undefined;
	// Only an answer that positively says "not signed in" proves the session is
	// dead — that is the one signal verified against the live service. A body of
	// any other shape is contract drift or an infrastructure answer, and deleting
	// a long-lived credential on that guess would sign the user out for nothing.
	if (access?.mode !== undefined && access.mode !== MODE_SIGN_IN) {
		throw new StepLoginRefreshError("unredeemable", "Step login state is no longer signed in");
	}
	if (!access || access.mode === undefined) {
		throw new StepLoginRefreshError("transient", "Step login state refresh returned an unexpected response");
	}
	// The refresh token is not rotated today, so a response without one is not a
	// failure: keep the stored one rather than dropping a still-valid session.
	const refresh = record ? readToken(record.refreshToken) : undefined;
	return {
		accessToken: access.raw,
		refreshToken: refresh?.raw ?? previous.refreshToken,
		deviceId: previous.deviceId,
		appId: previous.appId,
		expiresIn: access.duration && access.duration > 0 ? access.duration : DEFAULT_ACCESS_TOKEN_TTL_SEC,
	};
}

function readToken(value: unknown): { raw: string; mode?: number; duration?: number } | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const raw = record.raw;
	if (typeof raw !== "string" || !raw.trim()) return undefined;
	const mode = record.mode;
	const duration = record.duration;
	return {
		raw: raw.trim(),
		...(typeof mode === "number" && Number.isFinite(mode) ? { mode } : {}),
		...(typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? { duration } : {}),
	};
}
