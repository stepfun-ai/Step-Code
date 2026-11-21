import { SEARCH_ATTEMPT_TIMEOUT_MS, SEARCH_TOTAL_BUDGET_MS } from "./transport.ts";
import type { SearchAttempt, SearchCandidate, SearchChain, SearchOutcome, SearchTier } from "./types.ts";
import { advancesChain } from "./types.ts";

/** Skip an unavailable candidate long enough for a transient allowance or outage to pass. */
export const SEARCH_COOLDOWN_MS = 60_000;

/** A rejected credential is not transient; stop retrying it for longer. */
export const SEARCH_AUTH_COOLDOWN_MS = 5 * 60_000;

/**
 * A free provider that rejects an unauthenticated request is not having a bad
 * five minutes: its keyless mode is gone. Retrying it every few minutes wastes a
 * round trip forever, so it stays out for the life of the process. Only a restart
 * (or removing the provider) changes the outcome.
 */
const disabledKeyless = new Map<string, string>();

/** Below this remaining budget one more attempt could not finish a fast failure. */
export const MIN_ATTEMPT_MS = 3_000;

/**
 * Cooldowns live at module scope rather than per tool instance: the tool is
 * rebuilt for every session, so a per-instance map would forget which endpoint
 * is exhausted and every new session would pay the failed call again.
 */
const cooldowns = new Map<string, number>();

/** Cooldown identity: a candidate is (provider, endpoint), not just provider id. */
function cooldownKey(candidate: SearchCandidate): string {
	return `${candidate.id}\u0000${candidate.endpoint}`;
}

/** Clear recorded cooldowns. Test-only. */
export function resetSearchCooldowns(): void {
	cooldowns.clear();
	disabledKeyless.clear();
}

function isCooling(key: string, now: number): boolean {
	const until = cooldowns.get(key);
	if (until === undefined) return false;
	if (until <= now) {
		cooldowns.delete(key);
		return false;
	}
	return true;
}

export interface SearchAttemptRecord {
	candidate: string;
	kind: string;
	detail: string;
	endpoint: string;
}

export interface SearchChainResult {
	outcome: SearchOutcome;
	/** Candidate that produced the answer. */
	provider: string;
	tier: SearchTier;
	/** True when the answer did not come from the paid tier. */
	degraded: boolean;
	attempts: SearchAttemptRecord[];
	/** Candidates skipped because they were cooling down. */
	skipped: string[];
}

export type SearchCandidateInvoker = (
	candidate: SearchCandidate,
	query: string,
	options: { signal?: AbortSignal; timeoutMs: number },
) => Promise<SearchAttempt>;

export interface RunSearchChainInput {
	chain: SearchChain;
	query: string;
	invoke: SearchCandidateInvoker;
	signal?: AbortSignal;
	now?: () => number;
	budgetMs?: number;
}

/**
 * Walk the candidate list until one answers.
 *
 * Each attempt gets a slice of one shared budget, so a slow candidate cannot
 * starve the rest of the chain. A user cancellation ends the walk immediately:
 * no further provider may be contacted after the caller asked to stop.
 */
export async function runSearchChain(input: RunSearchChainInput): Promise<SearchChainResult> {
	if (input.chain.disabled)
		throw new Error("search_web is disabled; set [search] provider in config.toml to enable it");
	if (input.chain.candidates.length === 0) {
		throw new Error("search_web has no available provider; run `/login` or configure [search] provider");
	}

	const now = input.now ?? Date.now;
	const budget = input.budgetMs ?? SEARCH_TOTAL_BUDGET_MS;
	const started = now();
	const deadline = started + budget;
	const attempts: SearchAttemptRecord[] = [];
	const skipped: string[] = [];

	for (const candidate of input.chain.candidates) {
		if (input.signal?.aborted) break;
		const at = now();
		const key = cooldownKey(candidate);
		if (disabledKeyless.has(key)) {
			skipped.push(candidate.id);
			continue;
		}
		if (isCooling(key, at)) {
			skipped.push(candidate.id);
			continue;
		}
		const remaining = deadline - at;
		if (remaining < MIN_ATTEMPT_MS) {
			attempts.push({
				candidate: candidate.id,
				kind: "budget",
				detail: "skipped: search budget exhausted",
				endpoint: candidate.endpoint,
			});
			break;
		}

		const attempt = await input.invoke(candidate, input.query, {
			signal: input.signal,
			timeoutMs: Math.min(SEARCH_ATTEMPT_TIMEOUT_MS, remaining),
		});

		if (attempt.ok) {
			return {
				outcome: attempt.outcome,
				provider: candidate.id,
				tier: candidate.tier,
				degraded: candidate.tier !== "stepfun",
				attempts,
				skipped,
			};
		}

		attempts.push({
			candidate: candidate.id,
			kind: attempt.failure.kind,
			detail: attempt.failure.detail,
			endpoint: candidate.endpoint,
		});

		if (!advancesChain(attempt.failure.kind)) break;
		if (attempt.failure.kind === "auth" && candidate.tier === "keyless") {
			// A free endpoint that rejects an unauthenticated call has lost its
			// keyless mode; that is permanent for this process, not a transient fault.
			disabledKeyless.set(key, attempt.failure.detail);
			continue;
		}
		cooldowns.set(
			key,
			now() +
				(attempt.failure.kind === "auth"
					? SEARCH_AUTH_COOLDOWN_MS
					: (attempt.failure.retryAfterMs ?? SEARCH_COOLDOWN_MS)),
		);
	}

	if (input.signal?.aborted) throw new Error("search_web cancelled");
	if (attempts.length === 0 && skipped.length > 0) {
		// Every candidate is deliberately skipped. Say so instead of reporting a
		// failure with no attempts, which reads like a bug. A permanently disabled
		// provider is named separately: waiting will not bring it back.
		const disabled = skipped.filter((id) => {
			const candidate = input.chain.candidates.find((entry) => entry.id === id);
			return candidate ? disabledKeyless.has(cooldownKey(candidate)) : false;
		});
		const cooling = skipped.filter((id) => !disabled.includes(id));
		const parts: string[] = [];
		if (cooling.length) {
			const soonest = Math.min(
				...cooling.map((id) => {
					const candidate = input.chain.candidates.find((entry) => entry.id === id);
					return candidate ? (cooldowns.get(cooldownKey(candidate)) ?? now()) : now();
				}),
			);
			const seconds = Math.max(1, Math.ceil((soonest - now()) / 1000));
			parts.push(`${cooling.join(", ")} cooling down, retry in about ${seconds}s`);
		}
		if (disabled.length) {
			parts.push(`${disabled.join(", ")} no longer accepts credential-free requests`);
		}
		throw new Error(`search_web has no usable provider: ${parts.join("; ")}`);
	}
	throw new Error(formatFailure(attempts, skipped));
}

function formatFailure(attempts: SearchAttemptRecord[], skipped: string[]): string {
	const lines = attempts.map(
		(attempt) => `${attempt.candidate}: ${attempt.kind} (${attempt.detail}) [endpoint ${attempt.endpoint}]`,
	);
	if (skipped.length) lines.push(`skipped while cooling down: ${skipped.join(", ")}`);
	return `search_web failed after ${attempts.length} attempt(s): ${lines.join("; ")}`;
}
