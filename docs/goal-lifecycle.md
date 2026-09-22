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

## Budget recovery and status

`/goal budget <positive integer|none>` changes the current goal's token limit.
The command preserves its objective, identity, iterations, and token/time usage.
`none` removes the limit. Only the user controls this limit; `update_goal` still
accepts only `complete` or `blocked`.

A budget-limited goal becomes paused when the revised limit leaves room for more
work. Run `/goal resume` to continue. A limit at or below the tokens already spent
keeps it budget-limited. Lowering the limit while a goal continuation is running
accounts finalized messages first and interrupts that continuation if the new
limit is exhausted. Editing the objective alone does not increase the budget.
A completed goal stays complete when its budget changes.

The new snapshot must persist before the budget takes effect. A persistence
failure leaves the prior limit authoritative. `/goal status` shows spent tokens
even when the goal has no limit, for example `Tokens: 123 (unbounded)`.

The exact arguments `stop`, `off`, `reset`, `none`, and `cancel` are aliases for
`clear`, matching Claude Code. Longer text such as `/goal stop flaky tests from
failing` is still an objective. If a pause persists but the host cannot interrupt
the continuation, the paused footer remains visible and the command reports the
interruption failure instead of claiming the run stopped.

## Claude Code comparison

StepCode uses explicit `update_goal` tool results from the working agent for
completion and blocker decisions. It has no separate completion evaluator.
[Claude Code's documented goal behavior](https://code.claude.com/docs/en/goal)
uses a small model to evaluate the conversation after each turn and record a
verdict and reason. Adding that evaluator is a separate follow-up: it needs a
provider/model selection policy, evidence inputs, token accounting, and a stop
policy when evaluation fails or no progress is made.

StepCode also preserves counters on resume and rejects replacement of an
unfinished goal. Claude Code documents resetting usage baselines on resume and
replacing an active goal with a new condition. These are product differences,
not behaviors introduced by the command aliases. Goal budgets count uncached
input plus output and gate subsequent continuations; an in-flight model request
can exceed the remaining limit.

See [workflow and cron lifecycle](orchestration-lifecycle.md) for the neighboring
coordination primitives and remaining Claude Code differences.
