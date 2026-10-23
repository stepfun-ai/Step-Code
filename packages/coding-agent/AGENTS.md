# packages/coding-agent

Inherits the [root rules](../../AGENTS.md). This package is `@step-harness/coding-agent`; it composes the generic runtime into the coding product. Keep package guidance in this file, with subdirectory responsibilities and constraints described below.

## Responsibilities and entry points

- `src/index.ts`, `src/core/sdk.ts`, and `src/step/sdk.ts`: library and SDK capabilities.
- `apps/cli` composes process startup, argv handling, and mode routing; this package provides reusable product capabilities.

## Directory responsibilities and contents

| Directory | Responsibility | Contents |
| --- | --- | --- |
| `src/core/` | Coding-session execution mechanisms and product adapters for the generic harness | AgentSession, SessionManager, model and credential composition, resources and trust, message conversion, compaction, tools, and extension execution |
| `src/features/` | Concrete product features built on core and extension mechanisms | plan / task, subagents, workflows, goals, cron, questionnaires, stream recovery, feature registration, and switches |
| `src/step/` | Step product identity, policies, and external integrations | Defaults, login, TOML configuration, permissions, MCP / OAuth, plugins, SDK / stdio, feedback, and redaction |
| `src/modes/`, `src/server/` | Non-interactive modes and host service adapters | print, RPC, event output, and services that reuse the same product session |
| `src/theme/` | Product theme catalog and resolution | Built-in themes, active theme, theme loading, and color resolution |
| `src/render/`, `src/components/` | Product rendering helpers and reusable components | Rendering helpers and components; the full interactive host is in `apps/cli/src/ui/` |
| `src/cli/`, compatibility entry points, and `src/utils/` | Existing argument / command helpers, compatibility forwarding, and product utilities | Preserve existing call boundaries; new process entry points and mode routing belong in `apps/cli`, without extending frozen legacy entry points |
| `docs/`, `examples/` | Public interface documentation and usage examples | SDK, extensions, modes, sessions, tools, configuration, and extension examples |
| `test/` | Product and regression validation | Unit tests, session suite, faux-provider harness, and regression fixtures |

### src/core: product runtime mechanisms

| Area | Main locations | Responsibility |
| --- | --- | --- |
| Session execution | `agent-session.ts`, `agent-session-runtime.ts`, `agent-session-services.ts` | Compose the Agent Loop; manage product execution, events, queues, retries, and cancellation |
| Session storage | `session-manager.ts`, `session-manager-factory.ts`, `session-export.ts` | Persist coding sessions as JSONL, branch, resume, and export |
| Messages and context | `messages.ts`, `system-prompt.ts`, `compaction/` | Convert model messages, construct product prompts, summarize, retain skill instructions, and recover from context overflow |
| Models and credentials | `model-runtime.ts`, `model-registry.ts`, `provider-composer.ts`, `auth-storage.ts` | Compose model selection, credentials, and configuration into providers; reuse lower-layer protocol implementations |
| Settings and resources | `settings-manager.ts`, `resource-loader.ts`, `skills.ts`, `trust-manager.ts` | Read settings, discover resources, load skills, and enforce project trust gates |
| Coding tools | `tools/` | read / edit / write / bash / powershell / find / grep / ls, file mutation queues, and final tool-output retention |
| Extension execution | `extensions/types.ts`, `loader.ts`, `runner.ts`, `wrapper.ts` | Extension contracts, loading, command and tool registration, event hooks, and host capability injection |

Core provides mechanisms that product features compose. Do not put a feature's state machine into tool loading, session storage, or the generic Agent Loop.

### src/features: concrete features and orchestration

| Feature | Main locations | Contents |
| --- | --- | --- |
| Feature composition | `index.ts`, `step.ts`, `step-capabilities.ts` | Built-in registration, capability selection, and switches |
| Plan / task | `step-plan.ts`, `plan-mode-tools.ts`, `step-tasks.ts` | Plan mode, plan-file write boundaries, structured tasks, recovery, and migration |
| Subagents | `step-subagent.ts`, `step-subagent-agents.ts`, `subagent/` | Agent definition discovery, persistent RPC children, lane lifecycles, notifications, results, and timeouts |
| Workflows | `workflow/` | QuickJS VM, host bridge, agent runner, journal, budgets, path ACLs, progress, and session-scoped Ultracode activation |
| Goal / cron | `step-schedule.ts`, `step-cron.ts` | Session-goal budgets and continuation; cron scheduling and durable jobs in trusted projects |
| Other product capabilities | `step-questionnaire.ts`, `step-stream-recovery.ts`, `llama/` | User questionnaires, stream recovery, and local model integration |

Features connect through existing extension and session-event interfaces. Reuse core tools, sessions, and completion semantics rather than maintain another execution loop.

### src/step: product policies and integrations

- Configuration and identity: `defaults.ts`, `environment.ts`, `storage-root.ts`, `config-toml.ts`, `settings-manager.ts`; resolve Step directories, defaults, and `config.toml` consistently.
- Login and permissions: `auth.ts`, `login-flow.ts`, `login-status.ts`, `permissions.ts`, `command-policy.ts`, `shell-analysis.ts`; reuse provider login protocols while keeping policies and approvals in the product layer.
- MCP and plugins: `mcp*.ts`, `plugins.ts`, `path-containment.ts`; service discovery, catalogs, OAuth, contribution resolution, cancellation, and path boundaries.
- Product entry points and feedback: `tool-profile.ts`, `system-prompt.ts`, `sdk.ts`, `stdio-host.ts`, `feedback/`, `secret-redaction.ts`; capability composition, host adaptation, feedback consent, and redaction.

## Boundaries and invariants

- Internal dependencies are limited to agent-core, providers, config, and tui. Do not import CLI or turn app hooks into reverse dependencies.
- Reuse agent-core's Loop and generic harness. Implement coding-session message conversion, skill retention, permissions, and tool-output policies in this package.
- Provider protocols and vendor SDKs stay in providers. This package passes user configuration, credentials, model selection, and tool capabilities to providers.
- Preserve the frozen `bin` / `exports` boundary. Do not add argv, TTY, or process entry points, or weaken `check:coding-agent-entry-freeze`.
- Reuse `src/theme/` and `config.ts` for theme catalogs and resolution. Renderers consume the active theme; do not add another theme registry.
- Session completion, cancellation, recovery, and tool permissions remain consistent across RPC, print, TUI, and SDK. Protocol adaptation and presentation may vary by mode.
- Add features through existing extension / feature interfaces. Compatibility wrappers must not introduce independent core execution semantics.

## Session, tool, and feature constraints

- Distinguish `agent_end` from `agent_settled`, which includes retry / compaction recovery. Background delivery, goal continuation, and final completion use full settlement semantics.
- Propagate cancellation through model requests, retry waits, and automatic compaction. Late callbacks must not reactivate canceled runs or replaced sessions.
- Reuse agent-core for lightweight context projection; change only the request view, without persisting it or rewriting the transcript. Product summaries retain user instructions, skills, and protected tails; do not permanently delete session history.
- Tool permissions run through Step's `tool_call` policy; UI presents approvals. Handle dangerous matches and incomplete analysis separately: Ask / Approve for Me cannot bypass either gate through automatic tool overrides or unattended allow. Only risk-acknowledged Full Access uses the `skipCommandPolicy` exception; explicit tool deny still applies. Follow `src/step/permissions.ts` and [command permissions](../../docs/command-permissions.md).
- Use the existing mutation queue for changes to the same file. Final text results pass through the shared output-retention boundary, including MCP, extensions, hook replacements, and errors. Save full oversized output before publishing a preview; storage failure must not automatically retry calls with side effects.
- Preserve extension ordering: pre-execution `tool_call`, then return-stage `tool_result`. Publish catalogs in batches through `registerTools` to avoid repeated tool and prompt refreshes; tools added after a request starts become available to later requests.
- Keep persistent RPC sessions for subagents. Build child environments through `buildSubagentChildEnv`, retaining the child marker and workflow / cron / goal disabling flags. Timeouts, failures, and cancellation must settle lanes and release resources. Background lanes belong to the session runtime that started them: run every rejecting check before a lane exists, send one terminal notification per lane, and stop a runtime's lanes on `session_shutdown` without touching another runtime's lanes (see [orchestration lifecycle](../../docs/orchestration-lifecycle.md#background-subagent-lanes)).
- Run user workflow code in the existing QuickJS VM through the restricted host bridge. Path ACLs and fan-out depth are separate contracts.
- Plan mode and structured task tracking are independent. Validate plan write paths; do not infer task state from reply numbering or completion markers.
- Persist goal controls before applying them. Clearing a goal revokes continuation and cancels its corresponding run. Deliver cron jobs when the host is idle with no pending user messages; preserve durable-store locking, atomic replacement, and rollback on failure.
- Configuration reads distinguish missing files, invalid TOML, and other I/O errors. Writes preserve fields such as `mcp_servers` from the read under the same lock; respect host-injected directories and project trust.
- Interactive MCP connects in the background; print / RPC wait for the initial catalog. Shutdown cancels connections and registration; late tools must not enter a new session. Isolate OAuth credentials by server identity and URL; do not borrow another product's identity.
- Preserve feedback consent, redaction, and endpoint injection. Public source must not embed private exporters, endpoints, or release configuration.

## Validation and documentation

- Run `pnpm exec vitest --run <test-path>` from this directory. For session regressions, prefer `test/suite/harness.ts` and faux providers; see the [test harness](test/suite/README.md).
- Run root `pnpm run check:coding-agent-entry-freeze`; run the full `pnpm run check` after code changes.
- Lifecycle changes cover cancellation, retries, compaction, queues, session replacement, and RPC. Permission tests use harmless shell fixtures; feature tests use fake RPC children, VM executors, and clocks. VM mocks do not replace actual isolation validation.
- Update public API documentation as applicable: [SDK](docs/sdk.md), [extensions](docs/extensions.md), [RPC](docs/rpc.md), [session format](docs/session-format.md), [output retention](docs/tool-output-retention.md), or [compaction recovery](docs/compaction-overflow-recovery.md).
- For product policies and orchestration, update [configuration](../../docs/step-configuration.md), [command permissions](../../docs/command-permissions.md), [orchestration lifecycle](../../docs/orchestration-lifecycle.md), [goal lifecycle](../../docs/goal-lifecycle.md), or [MCP catalogs](docs/mcp-catalog.md).
