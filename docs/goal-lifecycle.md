# Session goal lifecycle

Step keeps one explicit goal per session. `create_goal` starts it, `get_goal`
inspects it, and `update_goal` records verified completion or a genuine blocker.
The host schedules an active goal's next turn after the current run settles.

## User controls

- `/goal pause` preserves the goal and stops automatic continuation. It interrupts
  an in-flight goal continuation, while leaving a user-initiated turn running.
- `/goal resume` reactivates a resumable goal.
- `/goal clear` removes the goal and interrupts the current run if the session is
  busy, including a turn that created the goal before its first continuation.
  Clearing an idle goal starts no work. With no goal set, the command leaves an
  unrelated running conversation alone.

Clear persists the cleared snapshot and revokes continuation before requesting
cancellation through the session's abort path. The subsequent aborted
message and settlement cannot restore the goal or schedule another goal turn.
A goal continuation already handed to the host queue is recognized and aborted
if it starts after clear.

If persistence fails, clear reports a warning and does not claim the goal was
removed or interrupt the run. If the host cannot interrupt a successfully
cleared goal's run, the cleared state remains authoritative and the command
reports the cancellation failure. These semantics apply to both TUI and RPC.

## Cancellation across attempts

An agent run includes model requests, retry backoff, and automatic context
compaction. Session cancellation aborts all three and records cancellation for
the lifetime of that run. The host checks this state before and after post-run
recovery, so a clear received at `agent_end` or `compaction_end` cannot start a
new attempt. Cancellation received while compaction resolves credentials is
checked before it starts a summary request. A cancelled compaction extension
also cannot fall back to the default summary request.

`ExtensionContext.abort()` always cancels the session run before invoking the
optional host UI cleanup hook. The TUI uses that hook to restore queued input;
RPC uses the same session cancellation without UI cleanup.

Here “busy” means an active agent run, including its retry and automatic
compaction. A standalone manual `/compact` or tree-summary operation does not
make the session's `isIdle()` false; clearing an idle goal does not cancel those
separate operations.
