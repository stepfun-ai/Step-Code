/**
 * Public option and statistics types for `projectContextForRequest`, their
 * defaults, and the per-rule counter / tuning-knob shapes shared with the
 * rule implementations.
 */

// ============================================================================
// Modes and statistics
// ============================================================================

/** Feature-flag values for `step.compaction.contextProjection`. */
export type ContextProjectionMode = "off" | "lightweight-v1";

/** Why a projection run did not rewrite anything. */
export type ProjectionSkippedReason =
	| "empty-messages"
	| "no-context-window"
	| "below-soft-threshold"
	| "no-reducible-content";

/** Per-rule rewrite counters. Keys follow the telemetry naming. */
export interface ProjectionByRuleStats {
	/** Rule a: large toolResult / bashExecution outputs cut to head+tail+salient lines. */
	tool_result_cuts: number;
	/** Rule b: repeated search/test outputs folded into a one-liner. */
	dedup_folds: number;
	/** Rule c: historical assistant thinking blocks dropped. */
	thinking_drops: number;
	/** Rule d: repeated branch/compaction summaries deduplicated. */
	summary_dedups: number;
	/** Rule e: large code / patch / JSON payloads cut on line boundaries. */
	code_cuts: number;
}

export function createByRuleStats(): ProjectionByRuleStats {
	return { tool_result_cuts: 0, dedup_folds: 0, thinking_drops: 0, summary_dedups: 0, code_cuts: 0 };
}

/** Result statistics for one projection run. */
export interface ProjectionStats {
	/** True when at least one rewrite was applied and all invariants held. */
	applied: boolean;
	/** Context tokens before projection (usage-based when provided, else estimated). */
	originalTokens: number;
	/** Estimated context tokens after projection (originalTokens minus estimated savings). */
	projectedTokens: number;
	/** Total content characters before projection. */
	originalChars: number;
	/** Total content characters after projection. */
	projectedChars: number;
	/** Rewrite counts per projection rule. */
	byRule: ProjectionByRuleStats;
	/** True when the post-projection invariant verification passed (or nothing was rewritten). */
	invariantsPassed: boolean;
	/** Set when verification failed; the original messages were returned unchanged. */
	invariantViolation?: string;
	/** Set when projection did not run at all. */
	skippedReason?: ProjectionSkippedReason;
	/** True when the second, more aggressive pass ran because the cap target was still exceeded. */
	aggressivePass: boolean;
}

// ============================================================================
// Options and tuning knobs
// ============================================================================

/** Tuning knobs for `projectContextForRequest`. All fields optional. */
export interface ProjectionOptions {
	/** Model context window in tokens. Required for the trigger; <= 0 disables projection. */
	contextWindow?: number;
	/**
	 * Context tokens of the *unprojected* request, preferably derived from provider
	 * usage. When omitted, a chars/4 estimate over `messages` is used.
	 */
	contextTokens?: number;
	/** Projection only runs at or above `softThresholdRatio * contextWindow`. Default 0.6. */
	softThresholdRatio?: number;
	/** Target ceiling; a second aggressive pass runs while above `capRatio * contextWindow`. Default 0.75. */
	capRatio?: number;
	/** Token span at the tail that is never modified. Default 20000. */
	keepRecentTokens?: number;
	/** Number of most recent thinking-bearing assistant messages whose thinking is kept. Default 2. */
	keepThinkingBlocks?: number;
	/** Character budget for the head slice of a cut message. Default 800. */
	headChars?: number;
	/** Character budget for the tail slice of a cut message. Default 800. */
	tailChars?: number;
	/** Maximum salient lines preserved between head and tail. Default 20. */
	maxSalientLines?: number;
	/** Minimum text-block size (chars) before the large-content rules cut it. Default 4000. */
	largeMinChars?: number;
}

/** Effective per-pass tuning values (defaults or aggressive-pass overrides). */
export interface ProjectionKnobs {
	headChars: number;
	tailChars: number;
	maxSalientLines: number;
	largeMinChars: number;
	keepThinkingBlocks: number;
}

// ============================================================================
// Defaults
// ============================================================================

export const DEFAULT_SOFT_THRESHOLD_RATIO = 0.6;
export const DEFAULT_CAP_RATIO = 0.75;
export const DEFAULT_KEEP_RECENT_TOKENS = 20000;
const DEFAULT_KEEP_THINKING_BLOCKS = 2;
const DEFAULT_HEAD_CHARS = 800;
const DEFAULT_TAIL_CHARS = 800;
const DEFAULT_MAX_SALIENT_LINES = 20;
const DEFAULT_LARGE_MIN_CHARS = 4000;

/** Aggressive second-pass knobs used when the first pass stays above the cap. */
const AGGRESSIVE_HEAD_CHARS = 400;
const AGGRESSIVE_TAIL_CHARS = 400;
const AGGRESSIVE_MAX_SALIENT_LINES = 10;
const AGGRESSIVE_LARGE_MIN_CHARS = 2000;
const AGGRESSIVE_KEEP_THINKING_BLOCKS = 1;

export function resolveProjectionKnobs(options: ProjectionOptions | undefined): ProjectionKnobs {
	return {
		headChars: options?.headChars ?? DEFAULT_HEAD_CHARS,
		tailChars: options?.tailChars ?? DEFAULT_TAIL_CHARS,
		maxSalientLines: options?.maxSalientLines ?? DEFAULT_MAX_SALIENT_LINES,
		largeMinChars: options?.largeMinChars ?? DEFAULT_LARGE_MIN_CHARS,
		keepThinkingBlocks: options?.keepThinkingBlocks ?? DEFAULT_KEEP_THINKING_BLOCKS,
	};
}

export function toAggressiveKnobs(knobs: ProjectionKnobs): ProjectionKnobs {
	return {
		headChars: Math.min(knobs.headChars, AGGRESSIVE_HEAD_CHARS),
		tailChars: Math.min(knobs.tailChars, AGGRESSIVE_TAIL_CHARS),
		maxSalientLines: Math.min(knobs.maxSalientLines, AGGRESSIVE_MAX_SALIENT_LINES),
		largeMinChars: Math.min(knobs.largeMinChars, AGGRESSIVE_LARGE_MIN_CHARS),
		keepThinkingBlocks: Math.min(knobs.keepThinkingBlocks, AGGRESSIVE_KEEP_THINKING_BLOCKS),
	};
}
