# Changelog

Step CLI 产品级变更记录。底层运行时包的细节继续记录在对应的
`packages/*/CHANGELOG.md` 中；发布时两类记录一起更新。

## [Unreleased]

### Added

- Added bounded task progress widgets and compact task tool views; `/todos` is available independently of plan mode.
- Added the Step CLI standalone binary release bundle, cross-platform installers, checksum manifests, and managed `fd`/`rg` tools under `.step-cli`.
- Added the Step binary startup update check with Pi-native selection and restart behavior.
- Added the `step update` / `step upgrade` command that installs an exact or latest standalone Step release with checksum verification, staged smoke test, rollback, and update locking.

### Changed

- Changed the default permission preset to Bypass, so a fresh run with no CLI flag, `STEP_*` env var, or persisted preset runs tools without approval prompts; explicit overrides keep precedence and dangerous commands still require confirmation.
- Clarified Step tool descriptions and prompts: tasks are todos, plan mode produces a proposal, and submitting a plan for review is not unconditional approval.
- Changed CI release delivery to publish only standalone Step binaries, installers, and release metadata; npm packages are not released.
- Changed Step authentication commands to expose only the Step provider while retaining Pi's native auth flow.
- Changed Step user message backgrounds to softer Morandi-style gray tones that vary with the active theme.

### Fixed

- Fixed `search_files` / `find_files` hard-failing with `ripgrep (rg) is not available and could not be downloaded` (and the fd equivalent) inside evaluation sandboxes that ship without rg/fd and cannot reach GitHub. Both tools now fall back to `git grep` / `git ls-files` when the search path is inside a worktree, and to POSIX `grep` / `find` otherwise; `GrepOperations` gains an optional `search` primitive symmetric to `FindOperations.glob` for remote injectors.
- Fixed the Windows and Unix installers not persisting PATH, so `step` was not runnable in a new shell after `irm .../install.ps1 | iex` (or `curl | sh`). The install dir and managed-tools bin are now added to the user PATH idempotently: `install.ps1` writes `HKCU\Environment` directly (preserving `%VAR%` entries un-expanded, avoiding `setx` truncation) and broadcasts `WM_SETTINGCHANGE`; `install.sh` writes a self-guarded `# step-cli` block to the login-shell rc (zsh/bash/POSIX), configures fish via `fish_add_path`, never truncates an rc on an unterminated marker, and refuses paths with shell-unsafe characters. Both honor `STEP_INSTALL_DIR`/`STEP_CODING_AGENT_DIR` and degrade to a printed advisory when persistence fails.
- Fixed task history and branch restoration, ID reuse across sibling branches, and acceptance of cyclic dependencies.
- Fixed inconsistent plan entry paths and approval of missing or empty plans; plan mode now follows the active session branch.
- Fixed the Step queued-message preview and `update_plan` plan text dropping four characters at every wrap point in narrow terminals.
- Fixed `step --api-key <key>` so the explicit key also authenticates the built-in `search_web` MCP tool.
- Fixed `search_web` failing under StepCode by no longer reading the injected `STEP_API_KEY`; that credential targets the StepCode model gateway, which the fixed search endpoint does not follow.
- Fixed unauthenticated help, version, model-listing, session-export, SDK stdio, and offline invocations opening the interactive login flow.
- Fixed resuming a session replaying the launch logo animation, which cleared and repainted the whole screen on every frame.
- Fixed the launch logo animation continuing to repaint the whole screen once a new session's first output grows past the viewport.
- Fixed release archives and installers so Pi TUI native helpers and runtime resources are copied from both wrapped Unix archives and root-level Windows archives.
- Fixed GitLab test jobs so workspace package entrypoints are built before child-process tests run, and missing `git`, `fd`, or `rg` dependencies are reported or bootstrapped explicitly.
- Fixed Step authentication selectors to tolerate hosts that do not provide product-specific interactive options.
- Fixed StepCode launches failing when the injected `--session-file` session selector was not recognized by the Step entrypoint.
- Fixed StepCode-launched Step sessions so `STEPCLI_CONFIG_PATH` provider catalogs, active models, API keys, and base URLs are loaded from the injected config file.
- Fixed StepCode-launched model and permission persistence so reads and writes use the injected config file instead of mixing in `.step-cli` settings.
- Fixed StepCode-launched models with omitted reasoning metadata defaulting to `reasoning: true`; explicit `reasoning: false` remains supported.
- Fixed input, deletion, and menu lag in long sessions, where every keystroke reprocessed all settled messages before the screen could update.
- Fixed `/feedback` leaving the editor above the bottom row when a page was cancelled; every page of the flow now renders over the transcript.
- Fixed `search_files` silently omitting matching files in bracket-prefixed dynamic routes such as `[slug]`, `[...slug]`, and `[[...slug]]`.
