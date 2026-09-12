import type { ProviderProfile, ProviderProfileId } from "../provider/types.ts";
import type { ModelApiDialect, ResolvedDialect } from "./types.ts";

/**
 * The SINGLE sanctioned home for any legacy `provider name -> dialect` mapping
 * (design §5.5: "派生逻辑集中在一处").
 *
 * It intentionally derives nothing today and returns `undefined` for every
 * provider. In this codebase the protocol is per-*model* (`model.api`), not
 * per-provider: a provider may serve multiple dialects — `createProvider`'s
 * `api` is `ProviderStreams | Partial<Record<Api, ProviderStreams>>`, dispatched
 * by `model.api` in models.ts. There is therefore no faithful
 * name -> single-dialect derivation. When a model config omits `api`, the api
 * comes from an explicit model/provider field or a provider default, and
 * provider-composer.ts (`definition.api ?? config.api ?? defaults?.api`) *throws*
 * when none is present rather than guessing from the provider name.
 *
 * This function exists so that, if such a compatibility mapping is ever
 * genuinely needed, it lives in exactly ONE place — never scattered as ad-hoc
 * `provider === "..."` derivations. It is deliberately NOT exported from the
 * package entry point.
 */
export function deriveFromLegacyProvider(_provider: ProviderProfileId): ModelApiDialect | undefined {
	return undefined;
}

/**
 * Resolve a model's wire dialect, recording whether it was declared explicitly
 * or derived from legacy identity.
 *
 * Precedence:
 *   1. explicit `model.api`            -> `declared`
 *   2. the profile's `defaultApi`      -> `derived-from-provider`
 *   3. the (currently empty) legacy derivation -> `derived-from-provider`
 * Slots 1-2 mirror provider-composer.ts's `definition.api ?? config.api` (explicit
 * model / provider api). Note provider-composer's *third* slot, `defaults?.api`, is
 * a different mechanism — inheriting the api of a same-id baseline model — which
 * this resolver does NOT reproduce; that baseline inheritance must be preserved
 * where declarations are flattened (block E / S5-4), not here.
 * Returns `undefined` when nothing supplies a dialect — the caller raises the
 * same configuration error as today (provider-composer throws on a missing api).
 *
 * `source` is telemetry/diagnostics only and MUST NEVER select an adapter: the
 * dispatch key is always `.api`. Enforced by scripts/check-derived-compat-only.mjs.
 */
export function resolveModelApiDialect(
	model: { api?: ModelApiDialect; provider: ProviderProfileId },
	profile: ProviderProfile,
): ResolvedDialect | undefined {
	// 1) Explicit api wins — this is the target state.
	if (model.api) {
		return { api: model.api, source: "declared" };
	}
	// 2) Compatibility path: profile default, then the (empty) legacy derivation.
	const derived = profile.defaultApi ?? deriveFromLegacyProvider(model.provider);
	if (derived) {
		return { api: derived, source: "derived-from-provider" };
	}
	return undefined;
}
