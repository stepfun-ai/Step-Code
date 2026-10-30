# Usage telemetry: daily active on every model request

## Problem

`device_daily_active` disagrees with `session_trace_recorded`, and third-party
users never appear in it:

- It is written on `session_start` / `model_select` (a model was merely
  selected), and from `onTraceId`, which fires only when the upstream returns
  `x-trace-id`. Third-party providers do not send that header.
- `createDailyActivity` drops `third_party` outright.
- Only `mp.z01.normandyfunc.com` is configured as internal; `i-ai-gw.stepx.com`
  is also an internal gateway.

Example: desktop 0.2.0 device `766b0e02` started on `step/step_plan` (daily row
`external/step_plan`, never used), then sent two requests on
`stepcode-anthropic` (trace rows `third_party`, no daily row).

## Decision (user)

- Daily active counts only when a model request gets an HTTP response, for all
  three user types. Dashboards de-duplicate by `device_id`.
- Internal gateways: `mp.z01.normandyfunc.com`, `i-ai-gw.stepx.com`.

## Steps

1. **Observer hook** — `packages/coding-agent/src/core/model-request-observer.ts`:
   add `ModelRequestResponse` and `ModelRequestObserver.onModelResponse`, fired
   for every response (success or error) whether or not it carries a trace id.
   `ModelRequestTrace` extends it with `traceId`.
   Expectation: capture exists when either hook is set; trace ids unchanged.
2. **Usage provider** — `packages/coding-agent/src/step/usage-telemetry.ts`:
   record daily activity from `onModelResponse`; remove the `third_party` filter;
   remove `createActivityExtension` (session start / model switch path).
3. **Hosts** — remove the activity extension wiring in `apps/cli/src/main.ts`,
   `apps/cli/src/bootstrap/extensions.ts` (and `apps/web` on the build branch).
4. **Config** — add `i-ai-gw.stepx.com` to `config/usage-telemetry.yaml`.
5. **Docs/schema** — `packages/coding-agent/docs/step-integration.md`,
   `src/step/telemetry-events.ts` comments.
6. **Tests** — `test/model-request-trace.test.ts`, `test/step-usage-telemetry.test.ts`;
   run them, `apps/cli/test/step-lifecycle-telemetry.test.ts`,
   `scripts/usage-telemetry-config.test.mjs`, and `npm run check`.
7. **Delivery** — branch `fix/usage-daily-active-on-request` from `origin/main`,
   MR to `main` (user override of the `github-opensource` rule: telemetry is
   internal-only). Cherry-pick onto `feat/stepcode-desktop-ci-pipeline-build`
   with the `apps/web` wiring folded into the same commit, and push.

## Rollback

Revert the commit on each branch. No data migration; the collector schema is
unchanged (same event, same fields).
