# Changelog

## [Unreleased]

### Fixed

- `steer()` and `followUp()` now refuse the session's own `/clm` family as well as registered extension commands; queued as text, `/clm status` used to reach the model as a literal line. The session also exposes the decision the two methods depend on: `isCommandInput()` and `submit()`, the entry that runs a command immediately and otherwise starts a turn or joins the running one.
- Summary requests now use the provider's model output limit and remaining-context sizing instead of fixed compaction/branch caps or reserve-derived budgets. Existing reserve arguments remain accepted for call compatibility; automatic trigger and branch source-selection settings are unchanged.
- Compaction and branch-summary inputs omit provider thinking blocks while retaining visible replies, tool calls, diagnostic output, and existing skill-retention rules. Original session history is unchanged. These changes adapt Pi commits `15e7bdc` and `6fcb486` (upstream PR #11036).
- Recognize `search_files`, `find_files`, and `list_directory` when selecting default system-prompt file-exploration guidance.
