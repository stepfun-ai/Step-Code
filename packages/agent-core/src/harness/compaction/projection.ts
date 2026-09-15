/**
 * Lightweight request-time context projection.
 *
 * `projectContextForRequest` deterministically rewrites the LLM-facing message
 * array right before a model request to reclaim context window from redundant
 * content. It is a pure function: no I/O, no model calls, and no session
 * mutation. The session transcript and compaction entries are never touched --
 * only the projected copy handed to the provider changes.
 *
 * Structural guarantee: projection only rewrites message *content* in place.
 * It never removes, inserts, or reorders messages, never changes roles, and
 * never touches tool-call blocks, so assistant `toolCall` / `toolResult`
 * pairing is preserved by construction and re-verified afterwards.
 *
 * Invariants (any violation returns the original messages unchanged):
 *   1. The current user turn (last user message) is never modified.
 *   2. The active tool-call group (last assistant message and everything
 *      after it) is never modified.
 *   3. The most recent `keepRecentTokens` worth of tail messages are never
 *      modified.
 *
 * Module layout: this file is the composition entry point and public API
 * surface. The mechanics live in `projection-options.ts` (option/stats types
 * and defaults), `projection-rules.ts` (the five rewrite rules),
 * `projection-invariants.ts` (protected zones + verification),
 * `projection-salient.ts` (head+tail+salient-line cutting), and
 * `projection-content.ts` (content sizing, hashing, classification).
 *
 * NOTE: This is the canonical, single implementation.
 * `packages/coding-agent/src/core/compaction/projection.ts` re-exports it via
 * `@step-harness/agent-core`, so keep it pure and import only from
 * `@step-harness/providers`.
 */

import type { Message } from "@step-harness/providers";
import { estimateProjectionTokens, totalContentChars } from "./projection-content.ts";
import { computeProtection, type ProtectionZones, verifyProjectionInvariants } from "./projection-invariants.ts";
import {
	createByRuleStats,
	DEFAULT_CAP_RATIO,
	DEFAULT_KEEP_RECENT_TOKENS,
	DEFAULT_SOFT_THRESHOLD_RATIO,
	type ProjectionByRuleStats,
	type ProjectionKnobs,
	type ProjectionOptions,
	type ProjectionSkippedReason,
	type ProjectionStats,
	resolveProjectionKnobs,
	toAggressiveKnobs,
} from "./projection-options.ts";
import { applyProjectionRules } from "./projection-rules.ts";

export {
	estimateProjectionTokens,
	PROJECTION_CUT_MARKER_PREFIX,
	PROJECTION_REPEAT_MARKER_PREFIX,
	PROJECTION_SUMMARY_MARKER_PREFIX,
	shortContentHash,
} from "./projection-content.ts";
export { verifyProjectionInvariants } from "./projection-invariants.ts";
export type {
	ContextProjectionMode,
	ProjectionByRuleStats,
	ProjectionOptions,
	ProjectionSkippedReason,
	ProjectionStats,
} from "./projection-options.ts";
export { type CutResult, cutTextWithSalientLines } from "./projection-salient.ts";

/** Result of `projectContextForRequest`. */
export interface ProjectionResult {
	messages: Message[];
	stats: ProjectionStats;
}

// ============================================================================
// Stats accumulation and trigger checks
// ============================================================================

type ProjectionStatsBuilder = (partial: Partial<ProjectionStats>) => ProjectionStats;

function createStatsBuilder(
	originalTokens: number,
	originalChars: number,
	byRule: ProjectionByRuleStats,
): ProjectionStatsBuilder {
	return (partial) => ({
		applied: false,
		originalTokens,
		projectedTokens: originalTokens,
		originalChars,
		projectedChars: originalChars,
		byRule,
		invariantsPassed: true,
		aggressivePass: false,
		...partial,
	});
}

function findSkipReason(
	messages: readonly Message[],
	contextWindow: number,
	originalTokens: number,
	softThresholdTokens: number,
): ProjectionSkippedReason | undefined {
	if (messages.length === 0) return "empty-messages";
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return "no-context-window";
	if (originalTokens < softThresholdTokens) return "below-soft-threshold";
	return undefined;
}

// ============================================================================
// Rewrite passes
// ============================================================================

/** Budgets resolved once per run for the rewrite passes. */
interface ProjectionRunBudgets {
	originalTokens: number;
	capTokens: number;
	keepRecentTokens: number;
	knobs: ProjectionKnobs;
}

interface ProjectionPassOutcome {
	projectedMessages: Message[];
	protection: ProtectionZones;
	rewrites: number;
	projectedTokens: number;
	aggressivePass: boolean;
}

/** Run the default-knob pass, then the aggressive pass while still above the cap. */
function runProjectionPasses(
	messages: Message[],
	byRule: ProjectionByRuleStats,
	budgets: ProjectionRunBudgets,
): ProjectionPassOutcome {
	const protection = computeProtection(messages, budgets.keepRecentTokens);
	const estimatedOriginalTokens = estimateProjectionTokens(messages);
	const projectedMessages = messages.slice();
	// Savings are estimated (chars/4) and subtracted from the possibly
	// usage-derived original token count.
	const estimateProjected = (): number =>
		Math.max(0, budgets.originalTokens - (estimatedOriginalTokens - estimateProjectionTokens(projectedMessages)));

	let rewrites = applyProjectionRules(projectedMessages, protection, budgets.knobs, byRule);
	let projectedTokens = estimateProjected();

	let aggressivePass = false;
	if (projectedTokens > budgets.capTokens) {
		aggressivePass = true;
		rewrites += applyProjectionRules(projectedMessages, protection, toAggressiveKnobs(budgets.knobs), byRule);
		projectedTokens = estimateProjected();
	}

	return { projectedMessages, protection, rewrites, projectedTokens, aggressivePass };
}

// ============================================================================
// Entry point
// ============================================================================

/** Verify invariants over a finished pass outcome and assemble the result. */
function finalizeProjectionResult(
	messages: Message[],
	outcome: ProjectionPassOutcome,
	buildStats: ProjectionStatsBuilder,
): ProjectionResult {
	if (outcome.rewrites === 0) {
		return {
			messages,
			stats: buildStats({ skippedReason: "no-reducible-content", aggressivePass: outcome.aggressivePass }),
		};
	}

	const violation = verifyProjectionInvariants(
		messages,
		outcome.projectedMessages,
		outcome.protection.protectedIndexes,
		outcome.protection.lastUserIndex,
	);
	if (violation) {
		return {
			messages,
			stats: buildStats({
				invariantsPassed: false,
				invariantViolation: violation,
				aggressivePass: outcome.aggressivePass,
			}),
		};
	}

	return {
		messages: outcome.projectedMessages,
		stats: buildStats({
			applied: true,
			projectedTokens: outcome.projectedTokens,
			projectedChars: totalContentChars(outcome.projectedMessages),
			aggressivePass: outcome.aggressivePass,
		}),
	};
}

/**
 * Project the LLM-facing message array for the next model request.
 *
 * Pure and deterministic: same inputs produce the same output, nothing is
 * persisted, and the input array/messages are never mutated. When projection
 * does not run (below threshold, missing context window, nothing reducible)
 * or any invariant fails, the *original* `messages` reference is returned so
 * callers can rely on byte-identical passthrough behavior.
 */
export function projectContextForRequest(messages: Message[], options?: ProjectionOptions): ProjectionResult {
	const byRule = createByRuleStats();
	const originalChars = totalContentChars(messages);
	const contextWindow = options?.contextWindow ?? 0;
	const originalTokens = options?.contextTokens ?? estimateProjectionTokens(messages);
	const buildStats = createStatsBuilder(originalTokens, originalChars, byRule);

	const softThresholdRatio = options?.softThresholdRatio ?? DEFAULT_SOFT_THRESHOLD_RATIO;
	const skippedReason = findSkipReason(messages, contextWindow, originalTokens, softThresholdRatio * contextWindow);
	if (skippedReason) {
		return { messages, stats: buildStats({ skippedReason }) };
	}

	try {
		const outcome = runProjectionPasses(messages, byRule, {
			originalTokens,
			capTokens: (options?.capRatio ?? DEFAULT_CAP_RATIO) * contextWindow,
			keepRecentTokens: options?.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
			knobs: resolveProjectionKnobs(options),
		});
		return finalizeProjectionResult(messages, outcome, buildStats);
	} catch (error) {
		return {
			messages,
			stats: buildStats({
				invariantsPassed: false,
				invariantViolation: `projection-error: ${error instanceof Error ? error.message : String(error)}`,
			}),
		};
	}
}
