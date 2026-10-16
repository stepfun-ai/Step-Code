import type { AssistantMessage } from "@step-harness/providers";

/**
 * Temporary throttling, as classified by the provider from the HTTP status or
 * error code. Exhausted billing or plan quotas are a different kind and never
 * count as throttling.
 */
export function isRateLimitError(message: Pick<AssistantMessage, "stopReason" | "errorKind">): boolean {
	return message.stopReason === "error" && message.errorKind === "rate_limit";
}

export function rateLimitDelay(attempt: number, retryAfterMs?: number): number {
	if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return retryAfterMs;
	return Math.round(Math.min(30_000, 1000 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.25));
}

export type ModelRequestProgress =
	| { type: "started" }
	| { type: "succeeded" }
	| { type: "rate_limit"; attempt: number; maxRetries: number; delayMs: number; message: string };
