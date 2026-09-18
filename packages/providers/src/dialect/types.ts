import type { KnownApi } from "../types.ts";

/**
 * The wire dialect — the ONLY dispatch key for a model request.
 *
 * This is a semantic alias of the real {@link KnownApi} (the 10 concrete
 * protocol values in ../types.ts), not a new parallel type. The detailed design
 * (§5.2) writes abstract pennames (`openai-chat-completions`, `google-generative`);
 * those map to the real values `openai-completions` and `google-generative-ai`.
 * Code and conformance fixtures always use the real KnownApi values, never the
 * pennames.
 *
 * A provider's identity (`provider` / profile id) is a separate axis and MUST
 * NOT select the protocol implementation — only `model.api` (this type) does.
 * Dispatch already keys on it (see `byApi?.[model.api]` in models.ts).
 */
export type ModelApiDialect = KnownApi;

/**
 * Where a model's resolved dialect came from. Telemetry/diagnostics only —
 * never a dispatch input (enforced by scripts/check-derived-compat-only.mjs).
 */
export type DialectSource = "declared" | "derived-from-provider";

export interface ResolvedDialect {
	api: ModelApiDialect;
	source: DialectSource;
}
