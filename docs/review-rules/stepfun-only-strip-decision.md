# Decision: strip packages/ai to StepFun-only (S5-9')

**Date:** 2026-09-12 · **Commit:** `5962cae` · **Branch:** `dev/step-smoke-harness`

## Decision

step-cli is a StepFun product. The `packages/ai` layer was a fork of an upstream
multi-vendor `pi-ai` that shipped ~40 builtin model providers and 10 wire dialects.
The user decided to strip it to only what StepFun needs: **keep 3 protocol dialects,
delete every other provider and adapter.**

- **Keep 3 dialects (adapters):** `anthropic-messages` (StepFun's own protocol),
  `openai-completions` (a.k.a. openai-chat), `openai-responses`.
- **Delete the other 7 dialects:** `google-generative-ai`, `google-vertex`,
  `bedrock-converse-stream`, `mistral-conversations`, `azure-openai-responses`,
  `openai-codex-responses`, `pi-messages`.
- **Delete all builtin providers except a reference pair.** The StepFun provider is NOT a
  `packages/ai` builtin — it is the coding-agent `features/step-provider` extension
  (hardcoded `STEP_MODELS`, `anthropic-messages`, `api.stepfun.com`), registered in
  `apps/cli/src/main.ts` with `allowedAuthProviders: ["step"]`. That extension is untouched.

## Sub-decisions (user-confirmed forks)

1. **Fixtures — 方案A (keep anthropic + openai builtins).** Literally deleting *all*
   builtin providers empties `MODELS`, making `BuiltinProvider = keyof typeof MODELS =
   never` and breaking `getModel`/`getBuiltinModel` generics repo-wide (~36 fixtures). So
   `anthropic.json` + `openai.json` are retained as reference implementations / catalog
   fixtures for the 3 kept dialects. They are **dormant** in the product — `allowedAuthProviders`
   gates login to `step` only, and the selector shows only configured providers — so users
   never see them.
2. **Image capability — deleted.** `openrouter-images` and the `KnownImagesApi` axis (image
   generation) are removed; StepFun does not do image generation.
3. **Session-share — removed entirely.** The "share this session as a link" feature
   (`apps/cli/src/ui/session-share.ts`, its `/share` slash command, its Radius/GitHub-gist
   paths) is deleted; `handleShareCommand` is a soft "not available" stub. It was primarily
   a Radius-gateway feature, and Radius is removed.

## What changed (232 files: 172 deleted, 60 edited)

- **Adapters:** 15 api files deleted (7 dialects ×`.ts`+`.lazy.ts` + `google-shared`). The
  3 kept dialects' shared-helper closure is preserved: `openai-responses-shared`,
  `constrained-sampling`, `simple-options`, `transform-messages`, `github-copilot-headers`,
  `openai-prompt-cache`, `lazy`.
- **Providers:** ~37 factories + their `providers/data/*.json` + `*.models.ts` deleted;
  `radius` (+ `radius-config`, model-runtime `configureRadiusProviders` special-casing →
  `resetBuiltinProviders`), `bedrock-provider`, and the image subsystem removed.
- **Core types (`packages/ai/src/types.ts`):** `KnownApi` 10 → 3; `ApiOptionsMap` → 3;
  `Model.compat` conditional narrowed (openai-responses branch drops azure/codex; bedrock
  branch + `BedrockCompat` interface deleted). `index.ts` / `compat.ts` (`BUILTIN_APIS` +
  lazy re-exports/imports → 3) / `legacy-api-aliases` pruned to 3; `all.ts`
  `builtinProviders()` = `[anthropic, openai]`; `models.generated.ts` = `{anthropic, openai}`.
- **Pipeline:** `scripts/generate-models.ts` pruned to emit only anthropic + openai
  (dropped the deleted-`cloudflare.ts` import, added a `BUILTIN_PROVIDER_IDS` filter);
  `generate-models` / `build:offline` / `build` regenerate a consistent
  `{data, models.generated.ts, .manifest.json}` triple. `build-coding-agent-bundle.mjs`
  re-anchored on the oauth loader, dropped the bedrock/github-copilot/radius bundle
  entrypoints. Root `generate:models` no longer chains `generate-image-models`. `package.json`
  dropped the stale `./bedrock-provider` export + 2 image `sideEffects` entries.
- **Tests:** 63 whole files deleted (subject entirely removed), ~42 reworked (removed-provider
  parametrizations dropped, kept-dialect coverage preserved, no weakened assertions). Block D
  `registry-coverage` now covers exactly the 3 dialects; block E flatten round-trips
  `{anthropic, openai}`. The old coding-agent `model-runtime-cloudflare-compat` baseline-red
  is gone with its tests.

## Verification (independently re-run by main, not the delegated agents)

Two omissions the delegated agents left were caught and fixed here: `apps/cli/src/bun/
register-bedrock.ts` (imported deleted bedrock) and the bundle script's hardcoded
bedrock/radius entrypoints.

- `pnpm run check` green (biome + all guards + `tsgo --noEmit` over every test dir +
  browser-smoke).
- `pi-ai` 498 pass / 0 fail; `apps/cli` 405 pass + the 2 known baseline-red (6999 / 7209);
  `coding-agent` 2548 pass / 0 fail (single-threaded).
- `pnpm -r build` green (coding-agent bundle 19 files / 5.9 MiB + apps/cli).
- **End-to-end binary:** `build-binaries.sh --product step --offline-model-data --platform
  darwin-arm64` → 29M tarball, `step --version` = 0.3.1, `step --help` works.
- 3-way read-only adversarial review: green, 0 critical/major, zero dangling references,
  helper closure intact, StepFun chain untouched, all deviations confirmed safe.

## Deferred to S7 (non-breaking dead residue)

All flagged by review as unreachable / dead, none breaking build/runtime:

- Remove now-unused deps: `@aws-sdk/client-bedrock-runtime`, `@google/genai`,
  `@smithy/node-http-handler` (+ lockfile surgery under `PI_ALLOW_LOCKFILE_CHANGE=1`).
- Delete the 4 unreachable oauth loaders (`openai-codex`/`openrouter`/`kimi-coding`/`xai`)
  and their `load.ts` / `bun-oauth.ts` wiring (their providers are gone; only `anthropic` is
  needed by step).
- Delete the orphan `generate-image-models.ts`; rebuild a slim `--strict`-guard test.
- Clear dead deleted-provider string literals: `env-api-keys`, `model-resolver` defaults,
  `model-config`/`config-migration` `"radius"`, the `KnownProvider` union, the
  `ImagesModel`/`ImagesApi` type axis.
