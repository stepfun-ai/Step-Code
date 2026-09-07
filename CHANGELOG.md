# Changelog

Step CLI 产品级变更记录。底层运行时包的细节继续记录在对应的
`packages/*/CHANGELOG.md` 中；发布时两类记录一起更新。

## [Unreleased]

### Added

- Added bounded task progress widgets and compact task tool views; `/todos` is available independently of plan mode.
- Added the Step CLI standalone binary release bundle, cross-platform installers, checksum manifests, and managed `fd`/`rg` tools under `.step-cli`.
- Added the Step binary startup update check with Pi-native selection and restart behavior.

### Changed

- Changed CI release delivery to publish only standalone Step binaries, installers, and release metadata; npm packages are not released.
- Changed Step authentication commands to expose only the Step provider while retaining Pi's native auth flow.
- Changed Step user message backgrounds to softer Morandi-style gray tones that vary with the active theme.

### Fixed

- Fixed task history and branch restoration, ID reuse across sibling branches, and acceptance of cyclic dependencies.
- Fixed inconsistent plan entry paths and approval of missing or empty plans; plan mode now follows the active session branch.
- Fixed `step --api-key <key>` so the explicit key also authenticates the built-in `search_web` MCP tool.
- Fixed `search_web` failing under StepCode by no longer reading the injected `STEP_API_KEY`; that credential targets the StepCode model gateway, which the fixed search endpoint does not follow.
- Fixed unauthenticated help, version, model-listing, session-export, SDK stdio, and offline invocations opening the interactive login flow.
- Fixed release archives and installers so Pi TUI native helpers and runtime resources are copied from both wrapped Unix archives and root-level Windows archives.
- Fixed GitLab test jobs so workspace package entrypoints are built before child-process tests run, and missing `git`, `fd`, or `rg` dependencies are reported or bootstrapped explicitly.
- Fixed Step authentication selectors to tolerate hosts that do not provide product-specific interactive options.
- Fixed StepCode launches failing when the injected `--session-file` session selector was not recognized by the Step entrypoint.
- Fixed StepCode-launched Step sessions so `STEPCLI_CONFIG_PATH` provider catalogs, active models, API keys, and base URLs are loaded from the injected config file.
- Fixed StepCode-launched model and permission persistence so reads and writes use the injected config file instead of mixing in `.step-cli` settings.
- Fixed StepCode-launched models with omitted reasoning metadata defaulting to `reasoning: true`; explicit `reasoning: false` remains supported.
- Fixed input, deletion, and menu lag in long sessions, where every keystroke reprocessed all settled messages before the screen could update.
