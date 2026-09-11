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

## Interactive tool rendering

Step's projected tool titles and collapsed summaries are single physical
terminal rows. Row-control whitespace in command, path, and query previews is
normalized before width clipping: CR/LF becomes a space and tabs use the same
space expansion as the native text renderer. This prevents multiline scripts
from advancing the terminal cursor outside the differential renderer's row
accounting during spinner updates. The executed arguments, persisted messages,
and native expanded call/result bodies remain unchanged.

## Interactive tool approval

When its policy requires confirmation, Step asks for tool approval in an
overlay. The heading contains the tool name and the last eight characters of
its call ID; the body includes the full ID, the policy reason, and a bounded
input summary. Long body lines can be clipped
to the terminal width. The short ID helps distinguish consecutive prompts;
compare full call IDs when diagnosing whether calls are actually identical.
Navigation, confirm, and cancel keys come from the existing keybindings. Step
wraps their hints on narrow terminals instead of clipping the cancel hint.

A parallel tool batch prepares its approvals one at a time before executing
approved tools. For example, approving `run_command [12345678]` can immediately
show `run_command [87654321]` while the first command has not executed yet.
Two prompts with the same tool name do not establish repeated execution.
Check the distinct call IDs and their eventual tool results, not just the
number of dialogs or the duration of a tool-start event.

During a confirmation, an existing working row shows static
`Waiting for approval…`, without a running verb, token count, elapsed time, or
tip. Step tool-row animation pauses too, and its elapsed suffix excludes this
approval wait. After the dialog closes, running presentation resumes with the
saved working settings, including changes made during the wait. A hidden
working row stays hidden. Turn-wide elapsed time and runtime/telemetry durations
remain wall-clock measurements; their semantics are not changed by this UI
pause. Native result text such as `Took ...` may therefore include the approval
wait. Ordinary select/input dialogs do not enable the approval-wait state.

Approval policy and batch scheduling are unchanged. Each Yes applies to that
call; No, cancel, abort, or an explicitly configured timeout do not approve it.
There is no new default timeout and no automatic approval. Replacing a simple
select/confirm/input dialog, resetting extension UI, or stopping the TUI
cancels its pending promise. Old callbacks cannot dismiss a replacement dialog;
a mount failure cleans up and rejects the pending request. While replacement
cleanup or reset/stop is running, a simple dialog requested synchronously by an
editor refocus/disposal callback is cancelled before mounting. This prevents
an orphaned promise, overlay, or timeout. Ordinary dismissal still allows the
refocused editor to open the next dialog.

## Delegated agents

The Step `subagent` tool accepts one of three modes: a single `{agent, task}`
call, a non-empty `tasks` array for parallel work, or a non-empty `chain` array
for sequential work. Fresh installations provide the built-in agents
`general`, `explore`, `review`, and `planner`; custom definitions can be loaded
from the user or project agent directories. Agent names are matched exactly,
with `general-purpose`, `general purpose`, and `general_purpose` accepted as
aliases for the built-in `general` role so descriptive model output remains
usable. Malformed background requests are returned on the originating tool
call and do not create a detached lane or a later completion notification.

## File search

The `search_files` adapter recognizes native grep matches by their
`path:line: text` structure, not by a filename prefix. Paths beginning with
`[` (including `[slug]`, `[...slug]`, and `[[...slug]]` route directories)
or `WARNING:` remain valid results, with or without context lines.
Native limit/truncation notices are not match rows: `matches` and
`filesMatched` count accepted matches and files, while native limit metadata
still contributes to `truncated` in the tool details.

## Plans and tasks

Plans and tasks serve different purposes. A **plan** is the Markdown proposal:
approach, constraints, trade-offs, affected files, and validation. **Tasks** are
todo items in the session execution checklist: what needs doing and what is
pending, in progress, or completed. The task tools track work; they do not
execute, delegate, or schedule it. Approving a plan does not generate tasks
from Markdown.

- `enter_plan_mode`, `/plan`, and `--plan` share the same setup. Entry takes
  effect immediately; it does not request approval. An explicit `--plan`
  applies at process startup, including a continued session whose mode was off;
  later reloads and session/branch navigation do not reapply it. The plan path is
  announced, and `write_file` / `edit_file` remain available for that file.
  Other file-write targets are blocked while planning. This is **not a shell
  sandbox**: command tools retain the existing permission policy, and the model
  is instructed to keep commands read-only while planning.
- `exit_plan_mode` submits the written proposal for review, requiring a readable,
  nonempty regular plan file. In the TUI, the user can approve execution, stay in
  plan mode, or provide refinement notes. Cancel
  leaves planning active. Headless and RPC runs retain their existing automatic
  exit behavior after validation; the caller must gate approval externally
  before allowing execution. `/plan` can still explicitly toggle planning off.
- `task_create`, `task_update`, `task_get`, and `task_list` are the only task
  tools and work with or without plan mode. Tasks retain their descriptions,
  active labels, owners, metadata, and dependencies. Invalid dependency IDs,
  self-links, and dependency cycles reject the update before changing state.
  Status changes remain explicit; dependencies do not schedule or complete work.
- `task_list` reports only unfinished blockers that still exist; `task_get`
  returns the full stored dependency lists. `/todos` shows every task with its
  status, owner, and open blockers and belongs to the task extension, not the
  planning extension.
- The task widget shows completion counts and at most five open task entries,
  prioritizing in-progress tasks and their `activeForm`. Long labels are clipped;
  `/todos` shows the full list. Tool results have compact native summaries and
  expand to full details. Historical results render their own snapshots, never
  the current task map. RPC widgets use plain string arrays; headless execution
  needs no UI.

Both extensions restore state from the active session branch on startup and
branch navigation. Task snapshots are immutable, survive compaction, and use a
session-wide ID high-water mark so deleted or sibling-branch IDs are not reused.
The Markdown plan remains a workspace file; restoring mode does not version or
rewind its contents. On resume or after compaction, the model should call
`task_list` before continuing multi-step work instead of recreating tasks. The
whole task list is not injected into every turn.

Compatibility is limited to the existing six tool names and schemas, `/todos`,
and migration of legacy plan-mode todos into tasks on the active branch. Older
saved tool lists retain currently active plan/task tools on restore and exit;
ordinary custom tools still follow the saved branch selection. There is no
additional `TodoWrite` / `update_plan` alias or second checklist store.

The separation follows [Claude Code's plan and task tools](https://code.claude.com/docs/en/tools-reference)
and [permission modes](https://code.claude.com/docs/en/permission-modes). The
[Codex checklist handler](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/plan.rs)
also distinguishes its `update_plan` checklist from Plan mode. Step borrows the
separation, not model-specific restrictions on which task tools are available.

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
