# Step provider: dynamic model discovery from /v1/models

## Background

After `/login`, `/models` shows a hardcoded catalog (`STEP_MODELS`, 4 entries)
that does not reflect the account's real usable models. The list is static:
`registerStepProvider(pi)` registers `createStepProviderConfig` with
`models: STEP_MODELS`, and there is no dynamic discovery. The login profile only
changes `apiBaseUrl`, never the model set.

Empirically (`GET https://api.stepfun.com/step_plan/v1/models` with the OAuth
Bearer token) the endpoint returns only the models the account can actually use
(e.g. `step-3.5-flash-2603`, `step-3.5-flash`), which differs from the hardcoded 4.

Goal: after login, `/models` lists exactly the models returned by
`{base}/v1/models` for the current profile, and calls them via the OpenAI
Chat Completions dialect (`openai-completions`, `/v1/chat/completions`).

Decisions (confirmed with user):
- List strategy: purely dynamic replace. Drop the hardcoded catalog from the
  displayed list; rely on the dynamic fetch + persisted models.json cache.
- Protocol: all three profile URLs support all protocols; use
  `openai-completions` for every discovered model.

## URL scheme

`resolved.apiBaseUrl` is already normalized by `normalizeStepAnthropicBaseUrl`
(strips a trailing `/v1`, `/messages`, `/v1/messages`):
- `step_plan`   -> `https://api.stepfun.com/step_plan`
- `platform_cn` -> `https://api.stepfun.com`
- `platform_oversea` -> `https://api.stepfun.ai`

Derive the OpenAI base by appending `/v1`:
- `openaiBase = normalizedApiBaseUrl + "/v1"`
  - step_plan   -> `https://api.stepfun.com/step_plan/v1`
  - platform_cn -> `https://api.stepfun.com/v1`
  - oversea     -> `https://api.stepfun.ai/v1`
- models endpoint: `GET {openaiBase}/models` (verified working for step_plan)
- discovered `model.baseUrl = openaiBase`; the OpenAI SDK appends
  `/chat/completions`, giving `{openaiBase}/chat/completions`.

## Steps

### 1. providers: add dynamic fetch + switch dialect
File: `packages/providers/src/step-provider/index.ts`
- Add `stepOpenAiBaseUrl(apiBaseUrl)` helper: `normalizeStepAnthropicBaseUrl(x) + "/v1"`.
- Add `fetchStepModels(context, resolved)`:
  - Resolve Bearer token from `context.credential` (oauth `access`, or api_key `key`).
  - `GET {openaiBase}/models` with `Authorization: Bearer <token>`, `AbortSignal`.
  - Parse `data[].id`; map each id -> `StepModelConfig`/`Model` with:
    `api: "openai-completions"`, `baseUrl: openaiBase`, `reasoning: true`,
    `input: ["text","image"]`, `cost: 0`, `contextWindow: 256_000`,
    `maxTokens: 32_000`, `compat: STEP_MODEL_COMPAT` (openai-completions compat).
  - On non-200 / parse failure: return `[]` (keep previous/persisted list).
- Change `STEP_MODELS` baseline to `[]` (purely dynamic) — keep a `STEP_MODEL_DEFAULTS`
  const for the per-model metadata used when synthesizing discovered entries.
- Replace `normalizeStepModel` anthropic-forcing: discovered/step models normalize to
  `openai-completions` + `openaiBase` (not anthropic-messages). Keep tolerant repair
  of user models.json entries.

### 2. coding-agent: wire fetch + provider dialect
File: `packages/coding-agent/src/features/step-provider/index.ts`
- `createStepProviderConfigFromResolved`: set `api: "openai-completions"`,
  `baseUrl: openaiBase(resolved.apiBaseUrl)`, `models: []`,
  `refreshModels: (context) => fetchStepModels(context, resolved)`,
  and `normalizeModels` -> normalize to openai dialect.

### 3. default-model fallback
File: `packages/coding-agent/src/step/defaults.ts` (and/or model selection)
- `STEP_DEFAULT_MODEL` (`step-3.7-flash`) may be absent from the dynamic list.
  Guard: when the persisted default is not among available step models, fall back
  to the first available step model instead of injecting a missing `--model`.
  (Scope check during implementation; keep minimal.)

### 4. docs + changelog
- Update the provider/model doc under `docs/` describing dynamic discovery.
- Root `CHANGELOG.md` under `[Unreleased] > Changed`: Step model list is now
  discovered from `{base}/v1/models` and called via OpenAI Chat Completions.
  NOTE: on a feature branch, per repo rules, changelog entries are only added on
  `main`/PR — add the changelog when landing, not on this branch.

### 5. tests
- `packages/providers`: unit test `fetchStepModels` with a stub `fetch` returning
  a `data[]` payload -> asserts openai-completions models + openaiBase, and `[]`
  on error. Test `stepOpenAiBaseUrl` for all three profiles.
- Run: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run <test>`.

## Tool
- Edits to the two `step-provider/index.ts` files + defaults guard + a new test.
- `npm run check` (full), then the targeted vitest file.
- Manual smoke (optional, needs login): `pnpm step --provider step` then `/models`
  reflects `{base}/v1/models`; a one-line chat confirms `/v1/chat/completions` works.

## Expectation
- After login, `/models` lists exactly the ids from `{base}/v1/models` for the
  active profile; hardcoded 4 no longer appear unless returned by the endpoint.
- Selecting a discovered model streams via `/v1/chat/completions`.
- Offline after first login: persisted cache still lists the models.

## Rollback
- `git checkout -- <files>` on this branch, or delete branch
  `feat/step-dynamic-models`. No persisted-state migration is introduced;
  models.json cache is additive and harmless if the change is reverted.

## Risks / open items
- Switching the wire dialect from anthropic-messages to openai-completions for
  step_plan relies on the user's statement that all URLs support all protocols.
  Needs one real chat smoke test before merge.
- `/v1/models` returns no capability metadata (context/thinking); synthesized
  defaults (256K/32K/reasoning) may not match every model exactly.
- Default-model fallback touches selection logic; keep the change minimal and
  behind the "step provider" path only.

## Update (2026-09-17): runtime trigger + smoke results

Smoke testing revealed the runtime never refreshes model catalogs from the
network on a normal launch/login (`allowNetwork:false` everywhere except the
explicit `refreshModelCatalogs` command). So the `refreshModels` overlay never
ran in the interactive session and `/model` still showed the built-in baseline.

Fixes applied:
- `packages/coding-agent/src/features/step.ts`: on `session_start`, when a Step
  credential is configured, fire a best-effort background
  `ctx.modelRegistry.refresh({ allowNetwork: true, force: true, providers: ["step"] })`
  (15s timeout) so `/model` reflects `{base}/v1/models`.
- `fetchStepModels` never returns `[]` (the coding-agent composition treats the
  return value as a full replacement, so `[]` would wipe the catalog). It falls
  back to the built-in baseline on offline/unauth/error/empty; only a successful
  fetch with >=1 model replaces the list.

Verified:
- Unit: `fetchStepModels` against a stub returns openai-completions models at the
  correct `{base}/v1/models` and Bearer auth; falls back to baseline otherwise.
- End-to-end against the real endpoint (platform_cn returned 94 models; step_plan
  returned 2), correct dialect/baseUrl.
- Interactive TUI (`pnpm step`, logged in): `/model` lists only the account's
  real `{base}/v1/models` result (2 models) instead of the 4 hardcoded.

Remaining caveat: `STEP_DEFAULT_MODEL` (`step-3.7-flash`) may not be in the
discovered list; the status bar can show a model that is not selectable in the
picker. A default-model fallback guard is a separate follow-up.

```
