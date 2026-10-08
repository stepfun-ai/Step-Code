# Print-mode completion check

The Step CLI can perform a bounded completion check in the existing session:

```sh
step --print --completion-check git-committed --completion-check-attempts 2 "Complete the task and commit the changes."
step --mode json --completion-check git-committed "Complete the task and commit the changes."
step --mode json --completion-check git-committed --completion-review "Complete the task and commit the changes."
```

The feature is off unless `--completion-check git-committed` is supplied. The
attempts option counts **additional prompts**, defaults to 2, and accepts integers
1 through 3. Both flags accept `--flag=value` syntax. Attempts without the check,
unsupported values, interactive mode, RPC, and SDK stdio are rejected. Piped
print mode is supported. Direct `runPrintMode` callers can supply the same
`completionCheck` and `completionCheckAttempts` options. The boolean
`--completion-review` flag takes no value, requires `--completion-check
git-committed`, and defaults off. Direct callers can set `completionReview: true`.

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

Headless clients can set `STEP_CODING_AGENT_PLAN_DIR` to place generated
Markdown plans outside the worktree; see [plan file storage](step-configuration.md#plan-file-storage).
The conditions above still apply to all files remaining in the worktree.

If any condition is missing, a short status-only prompt asks the same session to
finish the task's required verification and commit work and give a final answer.
The original conversation and session ID remain in use. With review off, already
complete output costs no extra model calls. The follow-up budget applies to the whole invocation,
not separately to each user message. These prompts consume the original trial's
time budget; no trial timeout is extended or reset, and no new attempt is started.
The checker neither changes source files nor commits changes or runs hidden tests.

With `--completion-review`, the first eligible completion follow-up requests one
generic self-review even if the Git conditions and final text already pass. It
asks the same session and model to compare the work with the original visible
task, check public interfaces and types, boundary cases and the final diff, and
confirm relevant tests and checks ran after the last edit. It asks the assistant
to fix issues, commit remaining task changes, and provide a final answer while
preserving unrelated user changes and permission denials.

Any missing Git or final-text conditions are included in that same review prompt.
Review consumes **one of the existing follow-up slots**, with no extra budget or
new session. Later iterations use ordinary completion checks and feedback without
repeating the self-review. For example, a two-slot budget permits one combined
review/repair prompt and at most one further completion prompt. The review is an
optional experiment, not a grader; its benefit to task scores is unproven. It
introduces no hidden tests, external grading feedback, automatic commits, or
independent correctness judgment.

An explicit terminating tool denial, or an assistant error/abort observed during
this invocation, prevents further prompts from the checker, including when a
native retry subsequently succeeds. Pending user messages also stop at such a
terminal outcome when the check is enabled. Native provider retry policies are
unchanged. Explicit runtime session replacement continues to rebind listeners and
extensions, but the checker does not carry automatic feedback into another
session or working directory.
These rules also suppress review, including after an error recovered by native
retry. If cancellation or replacement occurs while waiting for stdout, a planned
review is not sent. Budget exhaustion and final-output exit codes are unchanged.

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

Only when review is enabled, completion events also contain
`review: { requested: boolean, sent: boolean }`. `requested` becomes true when the
first eligible inspection schedules review. `sent` becomes true only when the
original review text is emitted as a user message by that session; it does not
assert that the model completed a review or that the result is correct. A prompt
that fails preflight or is intercepted without delivery remains unsent.
Events scheduling feedback include `followUpKind: "review"` or `"completion"`.

When the review user message is delivered, JSON emits an additional
`completion_check` receipt with the same attempt and inspection fields and
`review.sent: true`. This preserves delivery evidence even if a later assistant
error or runtime replacement prevents another inspection. The receipt does not
run Git or consume another follow-up slot; count prompts by attempts and user
messages rather than the number of events. Subsequent inspections retain the
review state. With review disabled, these fields and the receipt are absent and
the existing event shape is unchanged.

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
