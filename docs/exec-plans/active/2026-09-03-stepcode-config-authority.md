# StepCode config authority

## Step

Make `STEPCLI_CONFIG_PATH` the read/write authority for model and permission
preferences during StepCode launches. Keep ordinary Step launches on the
existing `.step-cli` settings files. Reproduce the complete StepCode launch
contract: consume the injected config path, API credentials, endpoint, provider
catalog, model limits, and session selector before the normal argument parser
runs.

The StepCode environment/config inputs are:

- `STEPCLI_CONFIG_PATH` (with `STEP_CLI_CONFIG_PATH` as an alias), pointing to
  the managed JSON config, normally `~/.stepcode/stepcli/config.json`;
- `STEP_API_KEY` and `STEP_BASE_URL`, which provide the request credential and
  endpoint without requiring a Step login;
- `STEP_MODEL_PROVIDER`, `STEP_MODEL`, `STEP_MAX_CONTEXT_TOKENS`, and
  `STEP_MAX_OUTPUT_TOKENS` as the fallback selection/limit variables when a
  managed config is not available;
- `providers`, `activeModel`, model `tokens`/capability fields, and
  `tools.approval` in the managed JSON config;
- `--session-file <path>`, whose basename (without extension) is normalized to
  the Step/Pi session id. The default `session` selector creates a fresh
  session, and arguments after `--` remain prompt data.

When `STEP_API_KEY` or a usable credential from the managed config is present,
an empty or missing Step `auth.json` must not trigger the Step login screen.

## Tool

Add a StepCode config loader that normalizes provider API aliases, base URLs,
model ids, token limits, input/reasoning capabilities, and the shared
`$STEP_API_KEY` credential into Pi provider registrations. Wire the loader only
when the environment selects an external StepCode config, and register those
providers for both normal runtime and auth checks.

Add a StepCode-specific settings-manager decorator that reads and writes
`activeModel` and `tools.approval` in the injected config file. Model selection
and permission persistence must use that same file; the regular Step settings
files remain untouched in this mode. Keep explicit CLI/environment selections
ahead of managed defaults, and keep ordinary Step launches on the existing
`.step-cli` settings paths.

Add isolation/restart regression tests for config path aliases, provider/model
flattening, credentials, endpoint and token overrides, no-login startup,
model/permission persistence, and `--session-file` compatibility. Rebuild the
local Step bundle and run repository checks.

## Expectation

With `STEPCLI_CONFIG_PATH` set, Step can start and make model requests using
the injected `STEP_API_KEY`/`STEP_BASE_URL` without a local Step login. All
models declared by the managed `providers` catalog are selectable, including
their API dialects and token limits, and `activeModel` determines the initial
selection.

Ctrl+S model persistence updates `activeModel` in the injected config file and
survives the next StepCode launch. Permission changes update
`tools.approval` in the same file and also survive restart. These operations do
not read or write `.step-cli/agent/settings.json` or
`.step-cli/agent/step-settings.json` while StepCode mode is active.

An injected `--session-file <uuid>` is accepted and maps to that session id;
arguments after `--` remain untouched. Without `STEPCLI_CONFIG_PATH`, normal
`step` continues to use the `.step-cli` settings and auth paths, so StepCode
only models do not leak into ordinary Step sessions.

## Rollback

Remove the StepCode config loader/settings decorator, credential and provider
compatibility wiring, session-file normalization, and their conditional
entrypoint wiring; the existing Step settings manager, auth flow, provider
catalog, and argument parser then resume sole ownership of normal Step launches.
