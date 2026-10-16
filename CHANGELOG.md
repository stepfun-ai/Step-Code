# Changelog

## [Unreleased]

### Changed

- Replace permission tiers with Ask, Approve for Me (default), and Full Access. Full Access runs dangerous and unanalyzable commands after a session-only or remembered risk acknowledgment. Saved legacy permission modes reset to Ask for users to choose again; `--approval-mode strict` is no longer accepted. Both automatic tiers enable bounded model-error continuation by default; Ask does not.

### Fixed

- Stop flooding startup with `[Skill conflicts]` when the same skills are installed in both `~/.agents/skills` and `~/.claude/skills`. Byte-identical copies are now skipped silently, and remaining name collisions collapse to one summary line per directory pair; `--verbose` still lists each one.
- Cancel and drain workflow children before publishing a terminal state, share host admission across concurrent workflows, accept promise arrays in `parallel()`, and distinguish concurrency notices from actual script failures.
- Clamp workflow concurrency to the host ceiling, back off on temporary 429s with an independent retry budget and adaptive admission cap, and report failed nodes in final tool results instead of silently treating partial workflows as successful.
- Persist Ultracode on/off state in the current session journal so reopening that session restores its mode without changing global or project settings.
- Stop appending Ultracode capability tutorials on every turn. Announce session-mode transitions after user input, reuse unchanged state, and restore necessary reminders when context is compacted or replaced.
- Recognize `/exit` as an alias for `/quit`, including while the agent is running or compacting.
- Recognize `search_files`, `find_files`, and `list_directory` when selecting default system-prompt file-exploration guidance.
- Report callback errors (including nested workflow errors raised before any agent starts), and queue ordinary subagent batches beyond their concurrency window in the same process-wide admission window as workflow nodes. Subagent batches also honor `STEP_WORKFLOW_CONCURRENCY_LIMIT` and hold each slot until the child process exits.
- Let a tool return `isError: true` while keeping its partial output and details, so failed subagent and workflow results reach the model as errors. Finalize a partial assistant message when a provider stream throws, ends without a terminal event, or fails during construction, instead of leaving the turn unfinished.
- Classify provider failures structurally (HTTP status, provider error code, transport error) as rate limit, quota, auth, transient, or invalid request. Session retries, the separate 429 retry budget, and workflow congestion control use this classification instead of matching error text, so a 400 that mentions "429" is no longer retried and an exhausted quota returned as 429 is not treated as throttling.
- Resume workflows by matching each call's prompt and options instead of the journal's sequence prefix, so a failed or reordered node no longer forces every later call to re-run. Once a live call writes files, runs a shell command, or uses an unrecognized tool, cached calls that read the environment re-run as well; cached results are re-validated against the call's schema, and calls with a runtime (safeParse) schema always run live.
