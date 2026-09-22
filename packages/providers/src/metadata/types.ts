import type { Api, Model } from "../types.ts";

// —— S5-6: model metadata, DEGRADED to pure metadata ——
//
// The design (§5.7) sketches abstract pi-names `Pricing` / `ThinkingTiers` /
// `CompatFlags` / `ModelMetadata`. We deliberately do NOT invent those parallel
// shapes: the real, already-shipped fields are `ModelCost` (input/output/
// cacheRead/cacheWrite + tiered `tiers`), `ThinkingLevelMap`, and the per-api
// `Model.compat` conditional. Reusing them keeps `flattenProviders` output a
// byte-identical `Model<Api>` (MAJ-9) with NO lossy metadata->Model mapping.
//
// Metadata answers "how much does it cost, how long is the context, which
// thinking levels, which compat flags" — and NOTHING about dispatch. The
// dispatch key is always `model.api`. scripts/check-metadata-not-in-dispatch.mjs
// enforces that no dispatch point imports this module.

/**
 * The pure-metadata half of a model: every `Model<Api>` field EXCEPT the
 * identity axis (`api` / `provider` / `baseUrl`), keyed by model `id`.
 *
 * `cost` carries the tiered pricing (`ModelCost.tiers`) that openai / openai-codex
 * / github-copilot / cloudflare-ai-gateway rely on — dropping it would regress
 * cost accounting (acceptance condition 10). `pricing` (§5.7) maps to `cost`,
 * `thinking` to `thinkingLevelMap`, `compat` to `compat`.
 */
export type ModelMetadata = Omit<Model<Api>, "api" | "provider" | "baseUrl">;

/** The metadata fields alone (no `id`), used when assembling a model. */
export type ModelMetadataFields = Omit<ModelMetadata, "id">;
