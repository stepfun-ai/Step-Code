# Changelog

Step CLI 产品级变更记录。底层运行时包的细节继续记录在对应的
`packages/*/CHANGELOG.md` 中；发布时两类记录一起更新。

## [Unreleased]

### Added

- Added the Step CLI standalone binary release bundle, cross-platform installers, checksum manifests, and managed `fd`/`rg` tools under `.step-cli`.
- Added the Step binary startup update check with Pi-native selection and restart behavior.

### Changed

- Changed CI release delivery to publish only standalone Step binaries, installers, and release metadata; npm packages are not released.
- Changed Step authentication commands to expose only the Step provider while retaining Pi's native auth flow.
- Changed Step user message backgrounds to softer Morandi-style gray tones that vary with the active theme.

### Fixed

- Fixed release archives and installers so Pi TUI native helpers and runtime resources are copied from both wrapped Unix archives and root-level Windows archives.
- Fixed GitLab test jobs so workspace package entrypoints are built before child-process tests run, and missing `git`, `fd`, or `rg` dependencies are reported or bootstrapped explicitly.
- Fixed Step authentication selectors to tolerate hosts that do not provide product-specific interactive options.
