/**
 * Request-time lightweight context projection.
 *
 * The canonical implementation lives in
 * `packages/agent/src/harness/compaction/` and is pure: it only depends on
 * `@step-harness/providers` message types, with no I/O and no session state.
 * Unlike `utils.ts` / `compaction.ts` -- which need package-local mirror
 * copies because they import package-specific `AgentMessage` machinery --
 * projection can therefore be re-exported directly from
 * `@step-harness/agent-core` instead of keeping a synced copy here.
 */

export {
	type ContextProjectionMode,
	cutTextWithSalientLines,
	estimateProjectionTokens,
	PROJECTION_CUT_MARKER_PREFIX,
	PROJECTION_REPEAT_MARKER_PREFIX,
	PROJECTION_SUMMARY_MARKER_PREFIX,
	type ProjectionByRuleStats,
	type ProjectionOptions,
	type ProjectionResult,
	type ProjectionStats,
	projectContextForRequest,
	shortContentHash,
	verifyProjectionInvariants,
} from "@step-harness/agent-core";
