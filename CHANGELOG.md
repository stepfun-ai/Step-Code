# Changelog

StepCode 产品级变更记录。底层运行时包的细节继续记录在对应的
`packages/*/CHANGELOG.md` 中；发布时两类记录一起更新。

## [Unreleased]

### Added

- Added a `Step Plan Oversea` login option: the login page now offers the overseas Step Plan alongside the mainland one, signing in through `https://platform.stepfun.ai` and using `https://api.stepfun.ai/step_plan` for models. An overseas plan login also routes `search_web` to `https://api.stepfun.ai/v1/mcp/web_search/mcp`, and `step login status` reports `Login method: Step Plan Oversea.` (with the stored profile in `--json`) after validating the credential against the overseas endpoint.
- Added a first-run theme picker: the first interactive launch asks which theme reads best in the terminal after the startup login and the MCP import offer, on a screen of its own before the main UI is built (so no logo/input flashes past first), applying each option as it is highlighted and showing a syntax/diff sample. The chosen setting is written to `config.toml` before the UI is built, so the session opens in it; Escape answers with the terminal-following default and writes that, so the `theme` key alone decides whether the screen has been seen and deleting it asks again.
- Added bounded task progress widgets and compact task tool views; `/todos` is available independently of plan mode.
- Added the StepCode standalone binary release bundle, cross-platform installers, checksum manifests, and managed `fd`/`rg` tools under `.stepcode`.
- Added the Step binary startup update check with Pi-native selection and restart behavior.
- Added the `step update` / `step upgrade` command that installs an exact or latest standalone Step release with checksum verification, staged smoke test, rollback, and update locking.
- Added active-only elapsed time to the goal footer status (`Goal: active · 12m 3s`), refreshed at message boundaries; paused spans never count.
- Added `run_in_background` to `run_command`: the command starts detached and the call returns immediately with a pid and a log file capturing stdout+stderr, so long-running processes such as dev servers survive the turn. Readiness is checked by reading the log, `kill <pid>` stops the process, and anything still running is terminated when the session exits.
- Added Claude Code usage parity for workflow opt-in: the keyword `ultracode` now grants the same per-turn opt-in as `ultraloop`, and a `+500k`-style token target in the opting message becomes the run's default budget (an explicit `budget` parameter still wins). The workflow tool result now includes `scriptPath`, the persisted script copy to edit and re-invoke for iteration.
- Added frontend visual-verification guidance to the Step system prompt: the validation step now asks for a visual check on UI-facing changes (pointing at the playwright plugin when no browser tool is present), and a browser-tool-gated section teaches the render → screenshot → read_file → iterate loop and the subagent save-to-file pattern.
- Added a `background_restarted` lane event: when a background agent's keep-alive child dies and a new child resumes its transcript, the parent session is notified instead of the respawn happening silently.

### Changed

- Changed `/goal` feedback to guide the next step: creation lists the companion commands, `/goal status` formats time in minute/hour units instead of raw seconds, pausing points at `/goal resume`, and starting over an unfinished goal explains resume/edit/clear per status instead of a bare warning.
- Changed `/goal pause` to actually stop goal execution: it interrupts an in-flight goal-continuation turn immediately (turns the user started themselves keep running), and a queued goal continuation that only starts after the goal was paused or cleared is aborted at turn start instead of silently doing goal work.
- Changed silent goal auto-stops to be announced: when a run abort or error pauses/blocks the goal (or a usage/token budget limit stops it), a warning now explains how to recover, and a plain message typed while the goal is paused notes once per pause that it does not resume the goal.
- Changed workflow `pipeline()` to Claude Code semantics: each item's stage chain runs concurrently (wall-clock is the slowest chain, not the sum), stage callbacks receive `(prevResult, originalItem, index)`, and a throwing stage drops that item to `null` and skips its remaining stages. `parallel()` now resolves a throwing task to `null` instead of rejecting the whole wave; both primitives cap batches at 4096 entries.
- Changed workflow registration to on-by-default for Claude Code parity: the `workflow` tool, `/workflows`, and `/ultraloop` now register without `STEP_ENABLE_WORKFLOW` (the variable is no longer read), while usage keeps requiring the explicit ultraloop/ultracode opt-in per turn or session. `STEP_DISABLE_WORKFLOW=1` (or an embedder's `enabled: false`) turns registration off, and a session whose isolated-vm native module fails to load now starts with the existing warning by default instead of only when the enable flag was set.

- Changed the default permission preset to Bypass, so a fresh run with no CLI flag, `STEP_*` env var, or persisted preset runs tools without approval prompts; explicit overrides keep precedence and dangerous commands still require confirmation.
- `AgentLoopConfig.toolCallLeakRetries` is removed. The low-level loop no longer guesses a tool intent from markup in text; it records the structural classification (`classifyIncompleteAssistantTurn()`, now in `@step-harness/providers`) on every finished assistant message as `incomplete`, and hosts decide what to do about it.
- Plan mode is now entered only by the user, with `/plan` or `--plan`; the `enter_plan_mode` tool is removed. The default system prompt no longer carries a `# Planning` section. Entering plan mode appends one hidden `<collaboration_mode>` block with the plan method and plan path, and leaving it appends a short Default block, so the system prompt and tool block stay byte-identical across a plan cycle. Sessions recorded with an agent-initiated plan still restore. See [plan approval](docs/plan-approval.md#mode-announcements).
- Subagents are no longer an automatic escalation. The `subagent` tool description now carries an explicit-request gate and a delegation method (critical path first, self-contained briefs, disjoint write sets, no redoing delegated work), replacing the system prompt's `# Delegation` section; `# Coordination primitives` only routes between authorized primitives. Session-standing `/ultracode on` also authorizes proactive delegation. See [orchestration lifecycle](docs/orchestration-lifecycle.md#subagent-delegation-authorization).
- `--mode json` and `--mode rpc` now write only session **facts**: `message_update` and `tool_execution_update` are live frames — each superseded by `message_end` / `tool_execution_end` — and no longer appear in that stream. A harness that redirects one of them to a file therefore gets a record proportional to the work done, not to the tokens streamed; a subagent call that wrote 4,992 MiB of repeated child transcripts now writes a few KiB. Pass the new `--include-live-events` flag to get the frames back: a live viewer wants them, a log does not. See [JSON output](packages/coding-agent/docs/json.md) and [RPC](packages/coding-agent/docs/rpc.md).
- Replace permission tiers with Ask, Approve for Me (default), and Full Access. Full Access runs dangerous and unanalyzable commands after a session-only or remembered risk acknowledgment. Saved legacy permission modes reset to Ask for users to choose again; `--approval-mode strict` is no longer accepted. Both automatic tiers enable bounded model-error continuation by default; Ask does not.
- Clarified Step tool descriptions and prompts: tasks are todos, plan mode produces a proposal, and submitting a plan for review is not unconditional approval.
- Changed CI release delivery to publish only standalone Step binaries, installers, and release metadata; npm packages are not released.
- Changed Step authentication commands to expose only the Step provider while retaining Pi's native auth flow.
- Changed Step user message backgrounds to softer Morandi-style gray tones that vary with the active theme.
- Changed the system prompt to stop instructing the model to ask a clarifying question, announce a cost, or state a target and then wait for a reply: a concrete implementation request now proceeds on a reasonable assumption. The security rules, the caution that `rm -rf`/force-push and similar commands are never routine, and the requirement that opt-in gated tools need an explicit user trigger are unchanged; approval itself stays with the runtime's approval mechanism. In a non-interactive run nobody answers such a question, so the turn produced no tool call and ended the session.
- Changed `read_file` image budgets to Claude Code's exact resize semantics, with the byte budget raised for the Step backend: the base64 byte budget rises from 4.5MB to 100MB (the Step gateway accepts far larger inline images than Anthropic's 5MB cap; a run on a 5MB-capped dialect should pass a smaller `maxBytes`), a byte-only overage re-encodes at the original dimensions (PNG, then JPEG at quality 80/60/40/20) instead of shrinking the image, a dimension overage resizes to fit 2000×2000 and runs the same encode ladder, and the last resort — JPEG quality 20 at up-to-1000px width — is returned unconditionally. A decodable image is therefore never dropped with `Image omitted: could not be resized below the inline image size limit.`; that message now only remains for images that cannot be decoded and whose container header cannot prove they fit the budgets.

### Fixed

- Recover a normal assistant response that contains neither visible text nor an executable tool call: keep the original message in history unchanged, append one hidden user-role recovery prompt, and continue. Recovery is bounded by a streak of consecutive empty turns. Only a turn with visible text or an executed tool call resets it, and so does any user input, so a long autonomous run is not ended by one transient empty response and a provider error in between does not refill the budget. Automatic compaction runs first when the response also exceeded the context window.
- A run that ends without a usable answer reports it on `agent_settled` as `failure` (reason and message), instead of rewriting the assistant message's provider stop reason, so a settled run no longer means success by itself. Subagent lanes and goal continuation act on it, and print/JSON pick their exit code from the same classification, so no consumer decides success from `stopReason` alone. `assistantTerminalFailure()` in `@step-harness/providers` applies the same rule to a message that has not settled yet. The hidden recovery message records the entry it answers in `details.recoversEntryId`.
- Summary requests now use the provider's model output limit and remaining-context sizing instead of fixed compaction/branch caps or reserve-derived budgets. Existing reserve arguments remain accepted for call compatibility; automatic trigger and branch source-selection settings are unchanged.
- Compaction and branch-summary inputs omit provider thinking blocks while retaining visible replies, tool calls, diagnostic output, and existing skill-retention rules. Original session history is unchanged. These changes adapt Pi commits `15e7bdc` and `6fcb486` (upstream PR #11036).

- Stop flooding startup with `[Skill conflicts]` when the same skills are installed in both `~/.agents/skills` and `~/.claude/skills`. Byte-identical copies are now skipped silently, and remaining name collisions collapse to one summary line per directory pair; `--verbose` still lists each one.

- Recognize `search_files`, `find_files`, and `list_directory` when selecting default system-prompt file-exploration guidance.

- Fixed Step telemetry never reaching the collector, so no usage reached the events dashboard at all. Three independent breaks each sufficed on their own: `apps/cli/src/observability.ts` was still the public no-op provider, so no reporter existed in the process (not even `first_launch`); `telemetry-runtime.ts` resolved the build channel from `STEP_CLI_BUILD_CHANNEL`, a name no build sets since the rename to `STEPCODE_BUILD_*`, so every release binary resolved `dev`, stamped `channel=dev` on the envelope and left the endpoint unset; and the GitHub binary workflow passed `STEP_CLI_BUILD_*` to a build script that only reads `STEPCODE_BUILD_*`, so its artifacts also fell back to `dev` and the `0.3.1` version fallback. Telemetry now resolves channel and commit through the shared `readStepBuildIdentity`, so the telemetry and feedback envelopes can no longer disagree about which build they came from. A source checkout still only writes its local spool unless `STEPCODE_TELEMETRY_ENDPOINT` is set.

- Fixed the launcher-injected username being dropped from feedback envelopes: `readFeedbackUsername` read only `STEPCODE_USER`, while the shipping launcher sets `STEP_CLI_USER` (the only spelling the previous CLI ever read) and telemetry already accepted it. Feedback reports therefore arrived without the collector's "使用者" dimension while telemetry events kept it.

- Fixed the Step collector URLs being duplicated across three files with no single source of truth; `observer-endpoints.ts` now owns the dev/release origins and the events/feedback/feedback-bundle routes. The release origin keeps its `/stepcliobserserver` path segment — it is a gateway route, not a host, and normalizing it through `URL().origin` would break every route. Adoption policy is unchanged: telemetry adopts the built-in default on release only, feedback on both channels.

- Fixed `/goal clear` leaving the current request thinking after the goal was removed; clearing a goal now interrupts a busy run, including retry backoff and automatic compaction, after persisting the cleared state.

- Fixed `read_file` dropping small in-limit images with `Image omitted: could not be resized below the inline image size limit.` when Photon/WASM failed to load (for example in some Bun compiled binary layouts). The resize path now reads pixel dimensions directly from the PNG/JPEG/GIF/WebP header when Photon is unavailable and passes an image through untouched if it already fits both the pixel and base64 budgets; oversize images still return the same error instead of shipping unbounded bytes.

- Fixed the Unix `curl | sh` installer never placing `photon_rs_bg.wasm` next to the installed binary, so image resizing was disabled on fresh macOS/Linux installs: `read_file` could only pass through images already within the inline budget, and anything larger failed with `could not be resized` until a later `step update` happened to restore the file. `install.sh` now copies the wasm into the install directory, matching `install.ps1` and the `step update` self-update which already ship it.

- Fixed the same `Image omitted` error for in-budget images when Photon loads but throws while decoding that specific image (container variants its decoder rejects, corrupt metadata): the decode-failure path now falls back to the same header-only passthrough as the module-missing path, so an original within the 2000×2000 pixel and 100MB base64 budgets reaches the model untouched while oversize images keep returning the resize error.

- Fixed a signed-in Step session starting with `No models available. Use /login to log into a provider via OAuth or API key.` and `model unknown`. The Step catalog is discovered from `{base}/v1/models` and is not cached between runs, but startup only composed catalogs from cache, so the initial model had nothing to resolve against until something else refreshed (for example opening `/model`). Startup now pulls the Step catalog once, bounded and best-effort, before it picks the model.

- Fixed the Step MCP bridge dropping image blocks from tool results: screenshot-style MCP tools (for example the playwright plugin) now attach real images to the model, resized and capability-downgraded downstream like read_file images, and an image-only result renders a "(see attached image)" note instead of a base64 JSON dump.

- Fixed two silent failure modes around explicit user intent: with `STEP_ENABLE_WORKFLOW` set but the isolated-vm native module unavailable, the session now starts with a warning naming the missing module instead of silently registering no workflow tools; and a failed background lane's `<agent-notification>` now always carries each failed task's error reason instead of only the aggregate output text, which could omit the cause.

- Cancel and drain workflow children before publishing a terminal state, share host admission across concurrent workflows, accept promise arrays in `parallel()`, and distinguish concurrency notices from actual script failures.

- Clamp workflow concurrency to the host ceiling, back off on temporary 429s with an independent retry budget and adaptive admission cap, and report failed nodes in final tool results instead of silently treating partial workflows as successful.

- Report callback errors (including nested workflow errors raised before any agent starts), and queue ordinary subagent batches beyond their concurrency window in the same process-wide admission window as workflow nodes. Subagent batches also honor `STEP_WORKFLOW_CONCURRENCY_LIMIT` and hold each slot until the child process exits.

- Resume workflows by matching each call's prompt and options instead of the journal's sequence prefix, so a failed or reordered node no longer forces every later call to re-run. Once a live call writes files, runs a shell command, or uses an unrecognized tool, cached calls that read the environment re-run as well; cached results are re-validated against the call's schema, and calls with a runtime (safeParse) schema always run live.

- Persist Ultracode on/off state in the current session journal so reopening that session restores its mode without changing global or project settings.

- Stop appending Ultracode capability tutorials on every turn. Announce session-mode transitions after user input, reuse unchanged state, and restore necessary reminders when context is compacted or replaced.

- Fixed a StepCode alias of a built-in catalog model losing that model's thinking contract. A model injected through `STEPCODE_CONFIG_PATH` was rebuilt from the StepCode entry alone, so it carried no `compat` and the Anthropic adapter fell back to the legacy `thinking: {type: "enabled", budget_tokens}` payload. Upstreams that require adaptive thinking reject that with `400 ValidationException: "thinking.type.enabled" is not supported for this model`, so `stepcode-anthropic/claude-opus-5` failed intermittently depending on which gateway backend served the request while every other model kept working. `normalizeModel` now matches the wire model id together with the wire dialect against the built-in catalog and inherits `forceAdaptiveThinking` plus the model's `thinkingLevelMap`; the StepCode entry's own `compat` block is layered over the inherited value, so a key it states wins and its siblings are kept, an alias the catalog does not know is untouched unless it declares the flag itself, and nothing is inherited for a non-Anthropic wire dialect.

- Fixed Step approval dialogs appearing to loop: show distinct call IDs and a static waiting state, settle cancelled or replaced dialogs once, and prevent multiline tool titles from corrupting terminal redraws.

- Fixed `search_files` / `find_files` hard-failing with `ripgrep (rg) is not available and could not be downloaded` (and the fd equivalent) inside evaluation sandboxes that ship without rg/fd and cannot reach GitHub. Both tools now fall back to `git grep` / `git ls-files` when the search path is inside a worktree, and to POSIX `grep` / `find` otherwise; `GrepOperations` gains an optional `search` primitive symmetric to `FindOperations.glob` for remote injectors.

- Fixed the Windows and Unix installers not persisting PATH, so `step` was not runnable in a new shell after `irm .../install.ps1 | iex` (or `curl | sh`). The install dir and managed-tools bin are now added to the user PATH idempotently: `install.ps1` writes `HKCU\Environment` directly (preserving `%VAR%` entries un-expanded, avoiding `setx` truncation) and broadcasts `WM_SETTINGCHANGE`; `install.sh` writes a self-guarded `# stepcode` block to the login-shell rc (zsh/bash/POSIX), configures fish via `fish_add_path`, never truncates an rc on an unterminated marker, and refuses paths with shell-unsafe characters. Both honor `STEP_INSTALL_DIR`/`STEP_CODING_AGENT_DIR` and degrade to a printed advisory when persistence fails.

- Fixed task history and branch restoration, ID reuse across sibling branches, and acceptance of cyclic dependencies.

- Fixed inconsistent plan entry paths and approval of missing or empty plans; plan mode now follows the active session branch.

- Fixed the Step queued-message preview and `update_plan` plan text dropping four characters at every wrap point in narrow terminals.

- Fixed `step --api-key <key>` so the explicit key also authenticates the built-in `search_web` MCP tool.

- Fixed `search_web` failing under StepCode by no longer reading the injected `STEP_API_KEY`; that credential targets the StepCode model gateway, which the fixed search endpoint does not follow.

- Fixed unauthenticated help, version, model-listing, session-export, SDK stdio, and offline invocations opening the interactive login flow.

- Recognize `/exit` as an alias for `/quit`, including while the agent is running or compacting.

- Fixed resuming a session replaying the launch logo animation, which cleared and repainted the whole screen on every frame.

- Fixed the launch logo animation continuing to repaint the whole screen once a new session's first output grows past the viewport.

- Fixed release archives and installers so Pi TUI native helpers and runtime resources are copied from both wrapped Unix archives and root-level Windows archives.

- Fixed GitLab test jobs so workspace package entrypoints are built before child-process tests run, and missing `git`, `fd`, or `rg` dependencies are reported or bootstrapped explicitly.

- Fixed Step authentication selectors to tolerate hosts that do not provide product-specific interactive options.

- Fixed StepCode launches failing when the injected `--session-file` session selector was not recognized by the Step entrypoint.

- Fixed StepCode-launched Step sessions so `STEPCODE_CONFIG_PATH` provider catalogs, active models, API keys, and base URLs are loaded from the injected config file.

- Fixed StepCode-launched model and permission persistence so reads and writes use the injected config file instead of mixing in `.stepcode` settings.

- Fixed StepCode-launched models with omitted reasoning metadata defaulting to `reasoning: true`; explicit `reasoning: false` remains supported.

- Fixed StepCode-launched models with omitted vision metadata registering as text-only, so `read_file` replaced every image with a "current model does not support images" note even on vision-capable models such as `water18-0910`. Omitted capability metadata now defaults to image input; an explicit `supportsVision: false` or a declared `input` list remains authoritative.

- Fixed input, deletion, and menu lag in long sessions, where every keystroke reprocessed all settled messages before the screen could update.

- Fixed `/feedback` leaving the editor above the bottom row when a page was cancelled; every page of the flow now renders over the transcript.

- Fixed `search_files` silently omitting matching files in bracket-prefixed dynamic routes such as `[slug]`, `[...slug]`, and `[[...slug]]`.

- Fixed sessions ending silently when a serving-side tool parser leaks the model's `<tool_call>`/`<function=` markup into assistant text: that turn carries no executable call even though the model meant to act, so the loop now resamples the identical context up to twice before the run can end.

- Let a tool return `isError: true` while keeping its partial output and details, so failed subagent and workflow results reach the model as errors. Finalize a partial assistant message when a provider stream throws, ends without a terminal event, or fails during construction, instead of leaving the turn unfinished.

- Fixed the `--mode json` event stream emitting the first streamed token twice: `message_start` already carried content (e.g. `thinking="The"`) that the following delta repeated, because every provider stream event (and the proxy transport) shared one mutable message whose `content` was appended in place and could be serialized after the producer advanced. The start event now exposes its own empty initial `content`, so deltas alone build the message.

- Classify provider failures structurally (HTTP status, provider error code, transport error) as rate limit, quota, auth, transient, or invalid request. Session retries, the separate 429 retry budget, and workflow congestion control use this classification instead of matching error text, so a 400 that mentions "429" is no longer retried and an exhausted quota returned as 429 is not treated as throttling.

- Fixed piped stdin being trimmed and glued onto the CLI prompt with no separator (`printf '  x  \n' | step -p 'y'` sent the model `xy`): stdin is now preserved verbatim and separated from the CLI message by a single newline, while a whitespace-only pipe is still treated as absent.

- Fixed `--mode json` exiting 0 when the request failed with `stopReason: error`: the exit-code check ran only in text mode, so JSON runs reported success on failure. A failed request (and a hook-terminated tool block) now exits non-zero in both text and JSON modes.

