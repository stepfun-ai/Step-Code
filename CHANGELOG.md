# Changelog

## [Unreleased]

### Changed

- Replace permission tiers with Ask, Approve for Me (default), and Full Access. Full Access runs dangerous and unanalyzable commands after a session-only or remembered risk acknowledgment. Legacy Bypass/Autopilot presets map to Approve for Me; Read Only maps to Ask, and `--approval-mode strict` is no longer accepted. Auto-resume remains an independent setting.

### Fixed

- Recognize `search_files`, `find_files`, and `list_directory` when selecting default system-prompt file-exploration guidance.
