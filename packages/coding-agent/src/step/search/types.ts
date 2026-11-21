/** One normalized search result, independent of which provider produced it. */
export interface SearchHit {
	/**
	 * Result URL. Optional because the paid endpoint can return an entry without
	 * one; those entries are still shown, under their position and title.
	 */
	url?: string;
	title?: string;
	snippet?: string;
	/**
	 * Provider-assigned position, when it supplies one. Rendering falls back to
	 * the array index so a provider ordering gap is not renumbered.
	 */
	position?: number;
	/** Publication time in milliseconds since the Unix epoch, when the provider reports one. */
	publishedAtMs?: number;
}

/**
 * A successful search. `text` keeps a provider's plain-text answer for the case
 * where it replies without a result list, so the tool can pass it through
 * instead of reporting "no results".
 */
export interface SearchOutcome {
	hits: SearchHit[];
	text?: string;
}

/**
 * Why one candidate failed. The kind drives two separate decisions: whether the
 * chain advances (`advanceable`) and how long the candidate is skipped for.
 */
export type SearchFailureKind =
	| "auth"
	| "rate_limit"
	| "quota"
	| "server"
	| "network"
	| "parse"
	| "cancelled"
	| "unsupported"
	| "unknown";

export interface SearchFailure {
	kind: SearchFailureKind;
	/** HTTP status when a response was received. */
	status?: number;
	/** Provider-facing reason. Never contains a credential. */
	detail: string;
	/** Server-provided backoff for rate limiting, in milliseconds. */
	retryAfterMs?: number;
	/**
	 * The endpoint did not accept a stateless `tools/call`. The caller may retry
	 * the same candidate once through a full MCP handshake.
	 */
	handshakeFallback?: boolean;
}

export type SearchAttempt = { ok: true; outcome: SearchOutcome } | { ok: false; failure: SearchFailure };

/**
 * Kinds that keep the chain moving. `cancelled` never advances: the user asked
 * to stop, so no further request may be made. `auth` does advance, because a
 * StepFun-only failure must still fall back to the free tier.
 */
export function advancesChain(kind: SearchFailureKind): boolean {
	return kind !== "cancelled";
}

/** Attribute of a candidate used to decide whether the answer came from the paid tier. */
export type SearchTier = "stepfun" | "keyless";

export interface SearchCandidate {
	/** Stable identity used for cooldowns and diagnostics. */
	id: string;
	tier: SearchTier;
	endpoint: string;
	toolName: string;
	transport: "mcp" | "http";
	/** Stateless MCP candidates may need one full handshake before a real call. */
	allowHandshake: boolean;
	headers?: Record<string, string>;
}

export interface SearchChain {
	/** Candidates in the order they will be attempted. Empty means search is disabled. */
	candidates: SearchCandidate[];
	/** Why the paid tier is absent, for diagnostics. */
	skippedPaidTier?: "no-step-credential" | "disabled";
	disabled?: boolean;
	/**
	 * The user pinned `step` but no credential resolves. This is a real
	 * configuration error: falling back to a free provider would silently use a
	 * different backend than the one that was asked for.
	 */
	requiresCredential?: boolean;
}

export type SearchChainMode = "auto" | "off" | "step" | "exa" | "firecrawl" | "parallel" | "tavily" | "tinyfish";

export const SEARCH_CHAIN_MODES: readonly SearchChainMode[] = [
	"auto",
	"off",
	"step",
	"exa",
	"firecrawl",
	"parallel",
	"tavily",
	"tinyfish",
];

/** A stateless `tools/call` response, reduced to the parts every adapter reads. */
export interface McpToolPayload {
	content?: { type?: string; text?: string }[];
	structuredContent?: unknown;
	isError?: boolean;
}

/** One provider call, fully resolved by an adapter. */
export interface SearchRequest {
	endpoint: string;
	toolName: string;
	transport: "mcp" | "http";
	args: Record<string, unknown>;
	headers?: Record<string, string>;
}
