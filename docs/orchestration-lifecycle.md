# Workflow and cron lifecycle

StepCode uses `workflow` for a bounded orchestration run, `/goal` for an explicit
session objective, and `cron_create` for calendar triggers. The CLI system prompt
identifies the product as **StepCode**. The executable and existing storage
namespace remain `step` and `.stepcode`.

## Ultracode and workflows

A prompt containing `ultracode`, `ultraloop`, or an explicit workflow request opts
that prompt into workflow orchestration. `/ultraloop on` enables it for the
session; `/ultraloop off` removes that standing opt-in. The prompt's `+500k` or
`+1.5m` directive supplies a default token budget for its workflow calls. Saved
workflow invocations and skills can also authorize workflow use. The opt-in is a
model-guidance and journaling contract; off-consent calls are recorded, not
rejected by a hard permission gate.

A product run may contain multiple low-level attempts because of retries or
context compaction. The opt-in and prompt budget survive those attempts and
clear at `agent_settled`. The next submitted prompt replaces the prompt-specific
state. Session mode survives settlement and resets with the session.

The runtime checks cancellation before entering the VM and after it returns.
A tool call whose signal was already aborted does not start a child agent.
Budget checks run after acquiring a concurrency slot and before schema retries.
Once an agent call is rejected for exhausted budget, the whole run reports
`budget_exceeded` even if the script catches the rejection and returns a value.
Finishing a successful final call at exactly the limit remains valid.

Budget accounting uses completed calls' input plus output usage. Already-running
calls can overshoot the limit by one concurrency wave; the gate stops new calls
and retries, not tokens already being generated. Workflow journals and progress
files remain the source for replay and inspection.

The foreground workflow tool streams progress snapshots while it runs. The tool
row shows running and queued counts, completed/total agents, failures, cache
hits, cancellations, token spend, and the current phase. Each accepted agent
call enters the projection before waiting for a concurrency slot. Budget or
cancellation failures also settle queued entries, so they do not remain shown
as waiting after the run ends.

Agent rows show a short label and a whitespace-normalized task summary of up to
200 characters. Calls without a label use that summary as their label. The
collapsed view prioritizes all running tasks, then previews queued and settled
tasks; the configured tool expansion action reveals the full list and result.
The workflow renderer owns its body so the generic five-line tool preview does
not hide active tasks. Phase and log updates use the same live update path.

Each `onUpdate` has readable text and a complete `WorkflowProgress` snapshot in
`details`, including for RPC consumers. Snapshots are independent of later
mutations. The final result remains `WorkflowRunResult`; the current tool row
retains its last progress snapshot when displaying that result or an error.
Updates from late child cleanup are ignored once the tool call has settled.
This projection describes assigned tasks and lifecycle states; child tool and
model output remain in the child trajectories.

Workflows require the native `isolated-vm` runtime. Registration is disabled when
it cannot load. Unit tests can inject a VM executor to check the host contract;
those tests do not validate native isolation.

## Child fan-out and turn settlement

Fan-out is one level deep. Every rpc child spawned for a subagent or a workflow
agent carries `STEP_CLI_SUBAGENT_CHILD=1` and `STEP_DISABLE_WORKFLOW=1`, so it
registers neither the `subagent` tool nor the `workflow` tool and cannot start
another wave.

The same child carries `STEP_DISABLE_CRON=1` and `STEP_DISABLE_GOAL=1`, so it
registers no scheduling tools either. A child runs in the parent's cwd and
inherits its project trust, so a cron extension there would attach to the same
`.step-cli/cron/tasks.json`: a durable job coming due while the child sat idle
was steered into the child's session and consumed under the shared lock, and the
parent never saw it fire. A goal in a child is the same escape in time rather
than space, since it keeps requesting continuations after the parent has settled
the turn and stopped reading.

All four markers are unconditional: a process the harness spawned is by
definition already inside somebody's fan-out, so it neither fans out again nor
holds scheduling authority of its own. `buildSubagentChildEnv` owns this
contract.

The workflow path ACL (`WORKFLOW_ACL_ENV`) stays separate from that decision. It
is forwarded only when the caller supplies one, and is explicitly cleared
otherwise so a child never inherits the parent's ACL. Deriving the fan-out gate
from the ACL instead previously left `subagent -> workflow` open, because the
subagent runner passes no ACL: its children read as top-level and each started a
further wave of workflow agents, multiplying concurrent provider streams well past
the account limit and producing cascading rate-limit failures.

A turn settles on `agent_settled`, a failed prompt ack, or child exit. Because a
child that stays alive without emitting any of those would strand its parent
indefinitely, and `executeSubagent` awaits every lane, each turn also carries an
idle watchdog. The budget is measured against child output rather than wall clock:
any stdout or stderr byte resets it, and the child forwards `message_update`
deltas, so a live generation continuously defers it. Tripping the watchdog settles
the turn as failed and ends the child even for a keep-alive lane. The default is
30 minutes, deliberately generous because a long `run_command` is silent while it
runs; `STEP_SUBAGENT_TURN_IDLE_TIMEOUT_MS` overrides it and `0` disables it.

## Cron scheduling and delivery

`cron_create` accepts numeric five-field local-time cron expressions. Fields
support wildcards, lists, ascending ranges, and integer steps on a wildcard or
range. Seconds and timezone fields are unsupported. Invalid tokens and prompts
longer than 16,000 characters are rejected before a job is added.

At most 50 jobs can be created in the runtime, counting session jobs and loaded
project jobs. Existing records are never dropped to enforce that creation limit.
The scheduler checks every second. It delivers only when the host is idle with
no pending user messages, rechecking that state before each delivery. It also
drains at `agent_settled`, after retry and compaction recovery. Due work waits
while the current turn runs; missed intervals do not create a burst of catch-up
turns.

Offsets follow the documented Claude Code bounds and are derived from the task
ID by default:

| Task | Offset from the matching local-time minute |
| --- | --- |
| Recurring | Zero to 30 minutes late, capped at half the interval |
| One-shot at `:00` or `:30` | Zero to 90 seconds early, never before creation |
| Other one-shot minute | No offset |

`nextFireAt` includes the offset. Finding a matching minute walks elapsed time
while comparing local calendar fields, so both occurrences of a repeated hour
at the autumn DST transition remain schedulable. The search window is 366 days.
`/cron`, `/cron list`, and `/cron status` show prompts and local next-fire times.
`/cron delete <id>` and `/cron remove <id>` remove a job.

Recurring jobs expire after seven days, with one final due delivery. A job whose
next occurrence is still in the future at expiry is removed without delivery.
One-shot jobs are removed after successful handoff to the host.

## Durable project jobs

Session jobs live in memory. `durable:true` requires project trust and stores
versioned JSONL records in `.stepcode/cron/tasks.json`. Persistence carries a job
across restarts; **the CLI must be running for tasks to fire**.

Each mutation rereads the latest durable records under the file lock. The lock
covers schedule selection, host handoff, and atomic file replacement. Two active
runtimes using the same project store preserve each other's creates and deletes,
and do not normally hand off the same due occurrence twice. List operations
refresh the durable view from disk.

The store is attached only once `.stepcode/cron/tasks.json` exists; `cron_create`
with `durable:true` creates it. A session that schedules no durable work therefore
performs no cron storage I/O, and the file is not created just because the project
is trusted. Firing precision comes from the in-memory view, so the one-second tick
does not reread the shared file: another runtime's edits are picked up at most 30
seconds later, and `/cron list` and every mutation still read it immediately. A
tick takes the storage lock only when a delivery or a removal can actually happen;
while the host is busy, due jobs are marked deferred in memory.

The runtime loads the whole file before any startup delivery. A missed durable
one-shot stays on disk until its batched notice, including the task ID and full
prompt, is accepted. Missed recurring jobs advance to the next occurrence.
Malformed or unsupported records are ignored for execution and preserved during
writes. A persisted recurrence with no next occurrence in the supported search
window is retained with a warning; it does not block other jobs from recovering
or firing. Read failures other than a missing file propagate instead of
masquerading as an empty schedule. A failed mutation rolls back the in-memory
change.

A synchronous delivery rejection leaves a job due for retry and produces a
warning. Successful delivery means handoff to the extension host, not completion
of the resulting agent work. The extension API has no asynchronous acceptance
acknowledgment; later model or session errors follow the host's error handling.
If the process crashes or a disk write fails after handoff, the stored occurrence
can be delivered again on recovery. Atomic exactly-once execution would require
an acknowledged outbox/consumer protocol across that boundary.

## Remaining Claude Code differences

The comparison uses official documentation retrieved on 2026-09-20:
[workflows](https://code.claude.com/docs/en/workflows),
[goals](https://code.claude.com/docs/en/goal), and
[scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks).

| Area | Current StepCode behavior | Follow-up for closer alignment |
| --- | --- | --- |
| Workflow entry | Prompt keyword and `/ultraloop` session controls | Add `/effort ultracode` or an equivalent entry if that vocabulary is desired |
| Workflow execution | Foreground tool with live agent counts/tasks, journals, cancellation, replay | Background workflow task view with pause/resume controls |
| Goal completion | Working agent calls `update_goal`; user pause/resume and persisted budgets | Independent completion evaluator with visible verdict/reason and a no-progress stop policy |
| Interval scheduling | `cron_create`, `cron_list`, `cron_delete`, `/cron` | `/loop` convenience command, including a design for completion-relative intervals |
| Scheduling persistence | Optional shared project store | Claude Code session schedules are session-local; retain the stronger StepCode persistence contract explicitly |

See [session goal lifecycle](goal-lifecycle.md) for goal controls, budget recovery,
and cancellation semantics. The prior
[design exploration](plan-loop-cron-workflow-hoh.md) records the original design;
this document describes the implemented runtime contract.
