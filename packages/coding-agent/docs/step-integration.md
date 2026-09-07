# Step Integration

The Step entrypoint is intentionally an adapter around pi's coding-agent
runtime. The Step entrypoint sets product defaults and calls `main()` with the
Step extension; it does not create a second event loop or a second TUI.

## Ownership

- `InteractiveMode`, selectors, overlays, rendering, and input decoding stay in
  pi. Step selects a presentation-only `StepEditor` subclass that delegates
  `handleInput()` to pi's `CustomEditor`, plus Step welcome/footer components;
  these wrappers only format rendered lines and never own input or session
  state.
- `AgentSessionRuntime` remains the session and agent-loop authority.
- `extensions/step-provider` supplies the Step model catalog and browser OAuth
  flow through pi's provider API.
- `step-cli.ts` is a forwarding facade for hosts that need a Step-named
  boundary; it delegates prompt, queue, model, event, and disposal operations
  directly to pi. Event subscriptions follow the active session when pi handles
  `/new`, `/resume`, or `/fork`.
- `step/stdio.ts` contains the length-prefixed frame codec and the small
  transport-neutral event bridge.
- `step/feedback/` owns Step's user-initiated feedback contract: input
  validation and redaction, collector endpoint selection, optional diagnostics
  and session-bundle construction, ordered delivery, and pending retries. Pi
  supplies the active `SessionManager` and extension UI; feedback does not own
  session state or participate in the agent loop.
- `step/stdio-host.ts` is the optional `step --sdk-stdio` adapter. It owns only
  framing, request validation, reverse UI requests, and wire projections. Query
  declared SDK tools and lifecycle hooks are installed as temporary wrappers
  around Pi's public `Agent` callbacks; their actual execution, validation,
  transcript updates, and abort semantics still run in Pi's agent loop. The
  host rebinds after session replacement and serializes writes so stdout stays
  a valid byte stream. Unsupported query options are reported in the init
  message instead of being silently ignored.

  The stdio handshake advertises `streaming-input`, `sdk-tools`,
  `permission-callback`, `hooks`, and `sessions`. Partial text events are
  emitted only when `includePartialMessages` is enabled; final assistant and
  tool-result events always come from the Pi session event stream.

## Product defaults

The `step` entrypoint uses `STEP_CODING_AGENT_DIR` and
`STEP_CODING_AGENT_SESSION_DIR` when present. Without a session override, Pi's
native layout is `~/.step-cli/agent/sessions/<encoded-cwd>`. Project-local
resources use `.step-cli/`. When no explicit theme has been saved, the
built-in `step-light/step` pair follows the terminal appearance; the first name
is the light theme and the second is the dark theme. Non-interactive
`step --export` uses the same precedence as startup: explicit `--use-theme`,
saved settings, then the Step product default.
Set `STEP_PROVIDER`, `STEP_MODEL`, `STEP_API_KEY`, or the provider endpoint
variables to override the defaults. The Step launcher also disables pi release
and install checks so the product does not contact upstream services.

The Step `Working...` row measures elapsed time from `agent_start` across model
and tool turns. While a response streams, it estimates output tokens from the
normalized thinking, text, and tool-call deltas at four characters per token;
positive final `usage.output` replaces that response's estimate. Anthropic and
OpenAI-compatible providers share this normalized event path. The `thinking`
label follows thinking events and clears when text or tool output begins. Pi's
native presentation does not run this tracker or display these metrics.

The built-in Step provider uses pi's `anthropic-messages` adapter. Pi appends
`/v1/messages` to the configured base URL, so the canonical Step base is
`https://api.stepfun.com/step_plan`. For compatibility, `STEP_BASE_URL` also
accepts the older `.../v1` and `.../v1/messages` spellings; the provider
normalizes them before registering the model so the version segment is never
sent twice. Startup also repairs the same stale spellings in an existing
`.step-cli/agent/models.json`, including model-level overrides. If an older
legacy Step projection recorded a built-in Step id as an OpenAI-compatible
model, startup restores its `anthropic-messages` API and Step endpoint as well.
Upgrading from an earlier Step build therefore does not require signing
in again.

The Step tool profile also registers `search_web`, backed by the remote
`stepsearch.web_search` Streamable HTTP MCP tool. The search credential is
resolved from an explicit `step --api-key`, then `STEP_CLI_SEARCH_API_KEY`,
`STEPCLI_SEARCH_API_KEY`, then the Step login entry in `auth.json`; it is sent
	only as a Bearer header. `platform_oversea` login profiles use
	`https://api.stepfun.ai/v1/mcp/web_search/mcp`; `step_plan` and
	`platform_cn` use `https://api.stepfun.com/v1/mcp/web_search/mcp`. An
	unrecognized profile falls back to that same mainland endpoint.
	`STEP_CLI_SEARCH_WEB_MCP_URL` and `STEPCLI_SEARCH_WEB_MCP_URL` override this
	profile-based selection. This adapter does not add a separate search
	credential store or `integrations.search` settings surface. The
	`STEP_API_KEY` environment variable is deliberately excluded from that
	chain: StepCode injects it together with `STEP_BASE_URL` to reach its own
	model gateway, and because the search endpoint never follows that base URL,
	reusing the value would authenticate a gateway key against
	`api.stepfun.com` and fail.

Session storage is also selected through the Step wrapper. The wrapper keeps
Pi's `SessionManager` class, JSONL format, and tree operations unchanged, but
binds its `create`, `open`, `continueRecent`, `forkFrom`, `list`, and `listAll`
operations to the active Step agent root. Runtime replacement flows (`/new`,
`/resume`, `/fork`, and `/import`) use that same bound factory, so a later
operation cannot fall back to Pi's default `~/.pi/agent/sessions` directory.
Managed `fd` and `rg` binaries follow the same explicit `agentDir` boundary and
are installed under `<step-agent-dir>/bin`.

These presentation/runtime switches are passed to pi's composition root as
explicit options: `defaultTheme` selects the automatic Step theme pair and
`disableBackgroundServices` suppresses optional catalog, update, and install
telemetry work. It is deliberately distinct from interactive `offline` mode,
so disabling those background services does not prevent the first-run OAuth
flow. `tuiStyle: "step"` selects the Step presentation variant for the native
interactive mode. The shared `main.ts`, InteractiveMode, and theme controller
do not inspect Step-specific environment variables; the ordinary `pi` entrypoint
does not pass these options and keeps its upstream defaults.

Step also injects a settings decorator through `settingsManagerFactory`. The
decorator delegates Pi's complete `SettingsManager` API, including global and
project merging, trust, reload, and flush. Product-only permission policy is
kept in separate `step-settings.json` sidecars under the Step global agent and
workspace directories, with the same global-then-project precedence and file
locking. This keeps fields such as `permissionPreset` and `autoResume` out of
Pi's native `settings.json` schema while leaving ordinary Pi startup unchanged.

Top-level `step feedback` and interactive `/feedback` use a Step-owned gate,
configured by `feedbackEnabled` in the Step sidecar and the legacy feedback
opt-out environment variables. This gate is independent of Step telemetry:
disabling analytics does not disable user feedback, while the optional
`feedback_submitted` analytics event still follows the telemetry gate.

The Step entrypoint mirrors stderr to
`<storage-root>/logs/dev-YYYY-MM-DD.log` without changing the original stderr
stream. The mirror removes credential-shaped secrets before writing, uses
`0700` directories and `0600` files, and retains seven local calendar days.
It is still a developer log rather than an anonymized record: it may contain
user text, file paths, and other process output. Feedback reads only a bounded
diagnostic or error-context excerpt from it, and uploads that excerpt only
after the attachment consent flow has shown what will be sent.

Feedback delivery uses two requests with the same client-generated
`feedbackId`. The JSON feedback body is sent first; an optional gzip session
bundle is then sent to the bundle endpoint after attachment consent. The two
results remain independent: a bundle failure does not turn an accepted body
into a failed report. Failed body/bundle files remain pending locally, and
`step feedback --retry` can converge retryable failures. For permanent 4xx
rejections, such as an oversized bundle, the CLI states that identical bytes
cannot succeed and the report or archive must be changed before resubmission.

Embedded Step hosts can use `createStepAgentSession()` or
`createStepAgentSessionServices()` from the Step surface. These are thin
wrappers around Pi's corresponding factories: they resolve the Step global
agent directory and decorate an existing Pi manager when one is supplied.
They do not alter Pi's session file format or agent loop. Callers that supply a
custom or in-memory Pi manager should pass explicit `stepSettingsPaths` when
they need to control where the Step sidecar is stored.

`/init` submits a Codex-style repository-instructions prompt through pi's
normal user-message path. The model inspects the project and uses pi's native
write and approval flow; the prompt explicitly preserves an existing
`AGENTS.md` instead of replacing it.

## Compatibility matrix

The following is the current audit against the previous Step CLI. “Native”
means the behavior is supplied by Pi and is intentionally not duplicated in
the Step layer; “adapter” means a small wrapper in `src/step/` or the Step
extension. Entries marked “separate product” require a gateway or external
service and are not silently faked by this fork.

| Previous Step surface | Current ownership | State |
| --- | --- | --- |
| Model/provider selection, compaction, resume, fork, new session | Pi native commands and `SessionManager` | aligned |
| Step CLI OAuth login/logout and legacy credential migration | `extensions/step-provider`, `step/auth.ts`, `step/config-migration.ts` | aligned; endpoint migration is tested |
| Global/project settings and session paths | Pi managers wrapped by `step/settings-manager.ts` and `step/session.ts` | aligned; writes use `.step-cli` |
| Step permissions, `/permissions`, `/init` | Step extension/facades over Pi selectors and hooks | aligned; `/effort` is Pi's native `/thinking` alias, while `/permission` and `/mode` remain absent |
| Built-in `search_web` | Step tool profile backed by `stepsearch.web_search` over Streamable HTTP MCP | aligned; uses search-specific environment overrides and the Step login credential fallback |
| Top-level `step feedback` and TUI `/feedback` | `step/feedback/`, `step-cli.ts`, and the Step extension over Pi's current session/UI | aligned; the body and optional session bundle use separate Step collector requests |
| `/status`, self-memory/skills governance, `/refresh`, `/rewind`, `/copy` full-transcript semantics | Previous gateway/TUI product layer | not yet ported; no misleading alias is registered |
| `/multi-agent`, `/connect`, `/trace`, voice/realtime, gateway/cron | Previous gateway and external channel services | separate product; requires an explicit Step service implementation |
| Legacy top-level `models`, `serve`, `goal`, and related gateway commands | Previous command dispatcher | separate product; Pi package commands remain unchanged |

This distinction is deliberate: a missing external service is reported as a
gap instead of being represented by a command that appears to work but changes
session or approval semantics.

## Distribution

The npm package exposes both `pi` and `step` from bundled entrypoints. The
standalone archives likewise contain both executables (`pi`/`step`, or their
Windows `.exe` variants); the Step executable uses the same Bun runtime setup as
Pi before loading the Step product adapter.

## Non-goals

This layer does not reimplement editor key handling, UTF-8 buffering, render
throttling, selectors, or agent scheduling. Step's permission extension only
defines the product presets and dangerous-command policy; it invokes Pi's
native `tool_call` confirmation and `ui.select` flows. Autopilot likewise
toggles Pi's native retry setting and adds only a bounded continuation after a
settled retryable failure. Changes to the underlying interaction or scheduling
behavior belong in Pi's shared packages and should be consumed here through
their public APIs.
