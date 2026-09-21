# run_command background mode (dev-server leg of the frontend loop)

Owner: youwang + Claude. Branch: `feat/run-command-background`.

## Problem

run_command is strictly synchronous with a 600s cap, so a dev server cannot
survive the tool call that starts it. The frontend
build -> serve -> screenshot -> look loop has no way to keep the server alive
between turns, and Claude Code's Bash `run_in_background` has no Step
equivalent.

Constraint: the run_command description and promptSnippet are pinned
byte-for-byte by step-tool-profile.test.ts as a legacy contract, so the
feature must be additive — a new optional schema property (whose own
description reaches the model) plus a TOOL_RULES line, leaving the frozen
strings untouched.

## Steps

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| Add optional `run_in_background` to runCommandSchema; detached spawn mirroring the native bash tool (same shell resolution, stdin transport, detached process group), stdout+stderr to a tmpdir log, pid tracked via trackDetachedChildPid and untracked on exit, child unref'd | edit `src/step/tool-profile.ts` | tool returns immediately with pid + log path; log fills while the command keeps running; session shutdown kills leftovers via the existing detached registry | revert file |
| Extend the run_command TOOL_RULES line with background usage (dev servers, log readiness check, kill to stop) | edit `src/step/system-prompt.ts` | prompt guidance mentions run_in_background | revert file |
| Test: background run returns in <2s, pid > 0, log eventually contains the late marker | edit `test/step-tool-profile.test.ts` | test green | revert file |
| Changelog | edit `CHANGELOG.md` | Added entry present | revert file |

Out of scope: exit notifications back into the turn loop (would need the
lane-events pattern; poll-by-log is the v1 contract, matching how the model
checks readiness anyway).

No destructive or publishing side effects; code edits on a feature branch.
