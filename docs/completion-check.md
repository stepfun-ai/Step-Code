# Print-mode completion check

The Step CLI can perform a bounded completion check in the existing session:

```sh
step --print --completion-check git-committed --completion-check-attempts 2 "Complete the task and commit the changes."
step --mode json --completion-check git-committed "Complete the task and commit the changes."
```

The feature is off unless `--completion-check git-committed` is supplied. The
attempts option counts **additional prompts**, defaults to 2, and accepts integers
1 through 3. Both flags accept `--flag=value` syntax. Attempts without the check,
unsupported values, interactive mode, RPC, and SDK stdio are rejected. Piped
print mode is supported. Direct `runPrintMode` callers can supply the same
`completionCheck` and `completionCheckAttempts` options.

Before binding extensions or sending the first prompt, the check requires a Git
worktree with an existing HEAD commit and saves that HEAD. It then sends the
initial prompt, its images, and all additional user messages in their original
order. Once those prompts finish, completion requires all of these conditions:

- `starting-HEAD..HEAD` contains at least one commit. A preexisting commit or
  moving HEAD backwards is insufficient.
- The committed tree differs from the starting HEAD's tree. An empty commit or
  a change fully reverted before completion is insufficient. This tests delivery
  of a change, not its correctness; the canonical verifier still owns correctness.
- The index and tracked worktree are clean, including submodule changes.
- No unignored untracked files remain. Ignored files do not block completion.
- The final assistant message has non-whitespace text and no pending tool calls.

If any condition is missing, a short status-only prompt asks the same session to
finish the task's required verification and commit work and give a final answer.
The original conversation and session ID remain in use. Already complete output
costs no extra model calls. The follow-up budget applies to the whole invocation,
not separately to each user message. These prompts consume the original trial's
time budget; no trial timeout is extended or reset, and no new attempt is started.
The checker neither changes source files nor commits changes or runs hidden tests.

An explicit terminating tool denial, or an assistant error/abort observed during
this invocation, prevents further prompts from the checker, including when a
native retry subsequently succeeds. Pending user messages also stop at such a
terminal outcome when the check is enabled. Native provider retry policies are
unchanged. Explicit runtime session replacement continues to rebind listeners and
extensions, but the checker does not carry automatic feedback into another
session or working directory.

After the follow-up budget is exhausted, a valid final answer still returns exit
code **0** even if Git conditions remain unsatisfied. The canonical task verifier
owns the score; an ordinary failed task must not become an infrastructure error
that resamples the attempt. Missing/thinking-only final output returns **2** with
an explicit incomplete diagnostic. Existing terminal denials and final assistant
errors keep exit code **1**. Invalid configuration or failed Git preflight returns
**1** before a model call. If Git becomes unreadable after the model runs, the
checker stops adding prompts and reports that state; final text still returns 0,
and missing final text returns 2.

Text stdout contains only the last assistant answer. Diagnostics use stderr.
JSON mode keeps the ordinary session event stream, including the added user
prompts, and adds `completion_check` events. Each successful inspection includes
`check`, `attempt` (follow-ups already used, starting at 0), `maxAttempts`,
`hasNewCommit`, `hasCommittedChanges`, `trackedDirty`, `untrackedFiles`, `hasFinalText`, `status`
(`passed`, `follow_up`, or `exhausted`), and `willFollowUp`. A failed inspection
emits `status: "unavailable"` and `willFollowUp: false`. No filenames, file
contents, diffs, commit messages, or Git stderr appear in check feedback/events.

Git is invoked directly with fixed argument arrays, no shell, and only a
validated starting object ID as a variable argument. Reads use `rev-parse`,
`rev-list --max-count=1`, `diff --quiet <starting-HEAD> HEAD --`, and NUL-delimited
porcelain `status --no-renames` with normal untracked-directory reporting. The
tree diff disables external diffs, text conversion, and rename detection. Only
its exit status is used: 0 means no committed changes, 1 means committed changes,
and any other code, timeout, or cancellation makes the check unavailable. Each command has a 5-second timeout,
64-KiB stdout/stderr limits, and SIGKILL termination; optional Git index/cache
writes and fsmonitor are disabled. Lazy fetching and interactive Git prompts are
disabled. Normal disposal and SIGINT/SIGTERM/SIGHUP cancel outstanding Git reads
and retain the existing runtime, detached-child, stdout-backpressure, and signal
cleanup paths.
