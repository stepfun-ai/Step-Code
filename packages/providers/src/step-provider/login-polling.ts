import { sleep } from "../utils/sleep.ts";
import {
	isRetryableStepCliLoginError,
	pollStepCliLogin,
	type StepCliLoginInit,
	type StepCliLoginPoll,
	withStepCliLoginTimeout,
} from "./login-client.ts";

export const MIN_STEP_POLL_INTERVAL_MS = 1_000;
export type StepCliLoginReady = Extract<StepCliLoginPoll, { state: "ready" }>;
export interface WaitForStepCliLoginInput {
	readonly init: StepCliLoginInit;
	readonly authBaseUrl: string;
	readonly pollToken: string;
	readonly signal?: AbortSignal;
	readonly fetch?: typeof fetch;
}

// The outer login owns the local timeout; this loop only needs the server expiry.
export async function waitForStepCliLogin(input: WaitForStepCliLoginInput): Promise<StepCliLoginReady> {
	const remaining = input.init.expiresAt * 1_000 - Date.now();
	const timeoutError = () => new Error("Step sign-in timed out before it was approved in the browser.");
	input.signal?.throwIfAborted();
	if (remaining <= 0) throw timeoutError();
	const interval = Math.min(60_000, Math.max(MIN_STEP_POLL_INTERVAL_MS, input.init.pollIntervalSec * 1_000));
	return withStepCliLoginTimeout(remaining, input.signal, timeoutError, async (signal) => {
		for (;;) {
			try {
				const result = await pollStepCliLogin({
					authBaseUrl: input.authBaseUrl,
					pollToken: input.pollToken,
					flowId: input.init.flowId,
					signal,
					fetch: input.fetch,
				});
				signal.throwIfAborted();
				if (result.state === "ready") return result;
				if (result.state === "failed")
					throw new Error(
						result.reason === "denied"
							? "Sign-in was denied in the browser."
							: "Step sign-in failed in the browser.",
					);
			} catch (error) {
				signal.throwIfAborted();
				if (!isRetryableStepCliLoginError(error)) throw error;
			}
			await sleep(interval, signal);
		}
	});
}
