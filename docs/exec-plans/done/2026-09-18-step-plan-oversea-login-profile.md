# Step Plan Oversea login profile

## Context

The login page offers three profiles (`packages/coding-agent/src/step/onboarding.ts`):
`step_plan` (browser OAuth, CN), `platform_cn` and `platform_oversea` (API key).
There is no oversea Step Plan, so an oversea subscriber cannot sign in with a
browser login, and everything keyed off the stored profile (provider base URL,
`search_web` endpoint, `step login status`) has no oversea plan branch.

Oversea equivalences: `api.stepfun.com` -> `api.stepfun.ai`,
`platform.stepfun.com` -> `platform.stepfun.ai`.

## Steps

1. **Step** Add the `step_plan_oversea` profile and restructure the profile table
   so id, title, description, credential source, endpoints and env override names
   live in one record (the current nested ternaries fall through for a new id:
   `readEndpointOverride` would resolve a new base URL to the oversea *auth* var).
   **Tool** Edit `packages/coding-agent/src/step/onboarding.ts`.
   **Expectation** `resolveStepLoginProfiles()` returns
   `[step_plan, step_plan_oversea, platform_cn, platform_oversea]`;
   `step_plan_oversea` = base `https://api.stepfun.ai/step_plan`, auth
   `https://platform.stepfun.ai`, browser credential source; new overrides
   `STEP_CLI_STEP_PLAN_API_OVERSEA_URL` / `STEP_CLI_DEVCENTER_AUTH_OVERSEA_URL`.
   **Rollback** `git checkout -- packages/coding-agent/src/step/onboarding.ts`.

2. **Step** Route `search_web` for the new profile to the oversea MCP endpoint.
   **Tool** Edit `packages/coding-agent/src/step/search-web-tool.ts`.
   **Expectation** `resolveSearchWebServerUrl(undefined, {}, "step_plan_oversea")`
   is `https://api.stepfun.ai/v1/mcp/web_search/mcp`.
   **Rollback** revert that file.

3. **Step** Report the oversea plan in `step login status`: add a
   `step_plan_oversea` login method plus the resolved `profile` id, and print
   "Step Plan Oversea".
   **Tool** Edit `packages/coding-agent/src/step/login-status.ts`, `apps/cli/src/main.ts`.
   **Expectation** An auth.json with `profile: "step_plan_oversea"` validates
   against `https://api.stepfun.ai/step_plan/v1/models` and prints
   `Login method: Step Plan Oversea.`; `--json` carries `profile`.
   **Rollback** revert those two files.

4. **Step** Update tests and docs.
   **Tool** Edit `packages/coding-agent/test/step-onboarding.test.ts`,
   `step-search-web.test.ts`, `step-login-status.test.ts`,
   `packages/coding-agent/docs/step-integration.md`, root + coding-agent CHANGELOG.
   **Expectation** The three suites pass; docs list the oversea plan routing.
   **Rollback** revert those files.

5. **Step** Keep a provider-side re-login in the stored region: the registered
   Step provider resolves its OAuth authorization URL from the environment and
   only the API URL was synced, so an oversea plan would re-login against
   `platform.stepfun.com`.
   **Tool** Add `STEP_LOGIN_PROFILE_AUTH_URL` to the provider's auth-URL chain
   (`packages/providers/src/step-provider/index.ts`) and export it from
   `syncStepLoginProfileEndpoint` (`packages/coding-agent/src/step/login-flow.ts`).
   **Expectation** After an oversea login the env carries
   `STEP_LOGIN_PROFILE_API_URL=https://api.stepfun.ai/step_plan` and
   `STEP_LOGIN_PROFILE_AUTH_URL=https://platform.stepfun.ai`; both are cleared
   when no credential is stored.
   **Rollback** revert those two files.

6. **Step** Verify.
   **Tool** `./test.sh` targets for the three suites, then `npm run check`.
   **Expectation** No errors, warnings or infos.
   **Rollback** n/a.

## Out of scope (region gaps that remain CN-only)

Telemetry (`step/telemetry-runtime.ts`, `step/trace-headers.ts`), feedback
(`step/feedback/endpoints.ts`), binary updates (`step/local-update.ts`),
steppage MCP (`step/mcp.ts`, `step/plugins.ts`) all hardcode
`*.stepfun.com`. They are not selected by login profile and need oversea URLs
from the user before changing.

## Result

Landed. `./test.sh` cannot run in this environment (it isolates `HOME` and
pnpm's managed CLI path then fails to resolve), so verification ran the affected
suites directly with vitest: coding-agent `step-onboarding`, `step-login-flow`,
`step-login-status`, `step-search-web`, `step-provider`, `step-auth`,
`step-extension` (97 tests) and apps/cli `interactive-mode-step-login`,
`interactive-mode-startup-login` (14 tests), plus `npm run check` clean and a
scripted render of the login page showing the four rows.
