# Plan approval handoff

`exit_plan_mode` submits a written proposal for review. Leaving plan mode and
approving the proposal are separate events.

In the TUI, the tool blocks on the review dialog: the user approves execution,
requests refinements, or dismisses. Approval exits plan mode; feedback keeps it
active and steers the notes into the next response; dismissal keeps it active and
ends the turn. There is no deadline on that decision. The dialog closes when the
run is cancelled, and the tool then reports the review as aborted.

A host declares which of the two it is. One that can show a proposal and collect a
decision — the web and desktop apps — sets `planReviewSurface` when it binds the
session; plan mode then stays on, the turn ends, and the proposal is recorded as
`pendingProposalHash` in the `step-plan` entry. `mode` and `hasUI` cannot answer
this: every rpc host passes a dialog bridge, including clients with no review
surface.

An rpc client states it at startup: `--plan-review-surface` (or
`RpcModeOptions.planReviewSurface`) for a host that draws the proposal and
collects the answer. Without the flag a wire client keeps the handoff behavior,
because the transport says nothing about what the client can draw.

A host without that surface cannot obtain approval. It exits plan mode and hands
the proposal to the caller, but the turn ends immediately: leaving the mode does
not authorize execution. The caller must approve the exact snapshot before
starting an implementation turn. The host reports the proposal in place of the
answer it does not have: print text mode writes the handoff to stdout, and the
SDK result and the RPC `get_last_assistant_text` reply carry the handoff rather
than the assistant line that introduces the submission.

Plan mode does not hide tools: it denies mutating calls outside the plan file
through the `tool_call` policy, so the request's tool block stays byte-identical
and the provider's prompt cache keeps its prefix. Only a profile that lacks a
plan tool has it appended on entry, and that addition alone is reverted on exit.

The plan-file boundary has one spelling, shared by the plan extension's guard and
the Step permission pre-check:

- The check runs before the ordinary permission prompt, so the `ask` preset does
  not ask the user to approve an edit plan mode forbids and then refuse it.
- A mutation outside the plan file is blocked without a prompt. A write to the
  plan file still goes through the normal permission policy.
- A `then_run` command fused into a plan-file write is blocked: it is a shell
  execution the boundary does not permit, so the write is accepted only without
  it. `run_command` itself keeps its normal permissions; the plan prompt asks the
  model to stay read-only with it.
- The decision reads the persisted `step-plan` state, so a guard that runs before
  this process replayed `session_start` still blocks. When the live marker says
  plan mode is off, the check returns without walking the branch.
- An embedder that mounts the Step extension without the plan extension does not
  inherit the restriction: the pre-check is enabled only when the plan extension
  is mounted for that session.

## Mode announcements

Only the user enters plan mode, with `/plan` or `--plan`; there is no model-facing
entry tool. The system prompt only states that plan mode is user-controlled and
announced by the runtime; it carries no planning method in any mode. The method
and the mode itself reach the model as append-only messages instead:

| Transition | Appended at the next turn |
| --- | --- |
| Default → Plan | A hidden `step-plan-mode` custom message holding a `<collaboration_mode>` block with the plan method and the session plan path |
| Plan → Default (approval, `/plan` off, or a headless/RPC handoff) | A short Default block stating that the Plan instructions no longer apply |
| No change, or on and off again before a turn | Nothing |

Earlier blocks are never edited or removed; the latest one is authoritative. The
system prompt, tool block, and history before the new block stay byte-identical,
so a mode change costs only the appended block. An active mode is compared with
the last announcement still visible in the selected context, so resumed sessions
and branch navigation re-announce only when they disagree. Leaving the mode is
compared with the last announcement recorded in the branch history instead.

Two cases cannot wait for the next turn: compaction can summarize an announcement
away, and approval or `/plan` can change the mode during a run. The `context` hook
appends the missing block to that provider request only; it does not write session
history. The next turn persists the announcement normally. Leaving plan mode
still appends the Default block when the Plan block was compacted away, because
the compaction summary can carry its rules.

## Handoff details

Both interactive and external results carry structured `details`:

```json
{
  "outcome": "external_approval_required",
  "approvalSource": "external",
  "planFilePath": "/workspace/.stepcode/plans/session-example.md",
  "planContents": "# Plan\n\n1. Update the parser.\n2. Run focused tests.\n",
  "planHash": "64a6a6c86ef0197c43f9bfc081792cca8d33807fbe33390d2439308a790f7520",
  "planModeExited": true
}
```

`outcome: "external_approval_required"` identifies a handoff awaiting the
caller's decision. `planModeExited` describes the resulting mode state: `true` for
a caller that left the mode, `false` for a review-surface host that keeps planning
until the user answers. Neither means approval was granted. Every handoff ends the
turn: the result sets `stopTurn` in addition to `terminate`.

`approvalSource` identifies who owns the decision: `"user"` for the TUI review,
including feedback and dismissal, and for a review-surface host whose person
answers in the app; `"external"` for the headless / RPC caller's approval flow.
It does not indicate that approval has occurred. Source
and outcome are independent: a future caller-owned `"approved"` outcome can keep
`approvalSource: "external"` without claiming the user clicked the TUI. Native
headless/RPC exits currently emit `"external_approval_required"` only.

`planHash` is the lowercase hexadecimal SHA-256 digest of `planContents` encoded
as UTF-8. It covers the complete snapshot read from the file, including any BOM,
line endings, leading or trailing whitespace, and the end of a long proposal.
Nothing is trimmed, normalized, or truncated before hashing. The path identifies
the source file; the hash identifies the returned contents, even if that file
later changes.

A caller can verify the returned snapshot before presenting it for approval:

```js
import { createHash } from "node:crypto";

const details = toolResult.details;
if (details?.outcome === "external_approval_required") {
  const expectedHash = createHash("sha256")
    .update(details.planContents, "utf8")
    .digest("hex");
  // `planModeExited` is `true` for a caller that left the mode, `false` for a
  // review-surface host that keeps planning until its user answers.
  if (details.planHash !== expectedHash) {
    throw new Error("Incomplete or inconsistent plan handoff");
  }
  // Present details.planContents and bind the caller's decision to details.planHash.
  // Allow execution only after that caller-owned approval flow succeeds.
}
```

A caller-owned extension can use the existing `tool_result` hook to apply its
approval policy before the result reaches the runner. After that policy actually
approves the snapshot, it can retain the hash and contents, set
`outcome: "approved"` with `approvalSource: "external"`, and deliver an explicit
caller-approval message to the model. Merely changing metadata is not a substitute
for obtaining approval. Execution-time permission checks continue to apply.

This also lets an opted-in completion check run after a caller-approved plan.
Once an unapproved handoff has already reached the runner, automatic feedback
stays suppressed for that invocation; explicit caller messages are still delivered.
The runner does not infer an approval decision from their wording.

If the proposal changes, obtain a new review and approval for the new hash. A
matching hash identifies content; it is not an approval token. The interactive
tool rereads the file before accepting approval: a changed, missing, or
unreadable proposal keeps plan mode active and requires a new review.

Native outcomes keep their existing behavior:

| Outcome | `approvalSource` | `planModeExited` | Behavior |
| --- | --- | --- | --- |
| `approved` | `user` | `true` | The user selected execution; restore tools and continue. |
| `feedback` | `user` | `false` | Keep planning and steer the user's notes into the next response. |
| `dismissed` | `user` | `false` | Keep planning and stop the turn to wait for the user. |
| `external_approval_required` | `external` / `user` | `true` / `false` | The turn ends. `true` for a caller that left the mode (`external`); `false` for a review-surface host that keeps planning until its user answers (`user`). |

The TUI still selects execution by default, and Enter confirms that selection.
Interactive result details also include the hash of the reviewed snapshot.
Transcripts display external handoffs as **External approval required**, with the
complete plan, rather than displaying an approved result.

Missing, empty, whitespace-only, unreadable, and non-regular plan files leave
plan mode active. A request that needs no proposal may be answered read-only;
file absence or unchanged content never authorizes the model to disable planning.
Only the user can leave that mode with `/plan`. These guard results have no
handoff details or approval hash. Calling `exit_plan_mode` outside plan mode
likewise returns no handoff details. A non-error result is not itself approval.

`approvalSource`, `planHash`, and `planModeExited` are optional in `PlanReviewDetails`
for compatibility with existing producers and older transcripts. Native results
with a valid plan populate all three fields. Consumers should handle their absence
explicitly and must not infer approval or its source from missing fields, or infer
approval from plan-mode exit alone.

## Stop-turn barrier

A control decision ends the turn on its own. `stopTurn` on the tool result stops
the loop after the batch even when a sibling result does not set `terminate`:

- Sequential batches skip calls after the barrier and give each skipped call a
  paired error result, so the tool-call protocol stays complete.
- Parallel calls already in flight settle normally; no further model turn starts
  from the loop itself.
- A result-processing failure preserves a stop the tool already requested.
- Earlier calls in the batch are not rolled back.

The barrier ends that Agent Loop invocation. The session may still start another
turn for input queued after `agent_end` or for automatic context maintenance. The
proposal that a handoff left waiting is still recorded in the session, so the
guard below holds those turns too; a caller that owns the approval also gates
execution on its own side.

Inside the session, the plan extension registers one automatic-turn guard with
`ctx.registerAutomaticTurnGuard`, and it asks one question: is a proposal still
waiting for its decision.
The answer is the session fact `pendingProposalHash`, not the shape of the
transcript. A decision clears it — `/plan approve`, a request for changes, or
leaving plan mode — while a question typed past the proposal does not: on a host
with a review surface the user is still deciding, and on a caller handoff the
next turn owns the decision.
Guards belong to the extension generation that registered them, so a reload drops
the stale ones along with the runner whose context they capture.
The session asks that guard before every turn it would start on the user's
behalf — a feature's `triggerTurn` message, a goal continuation, a cron delivery,
a background lane waking its parent — and post-run recovery. A feature therefore
does not need to know the other starters to respect the decision, and adding a
new starter cannot silently bypass it.

Post-run recovery is the exception that proves the rule: overflow and truncation
recovery repair the transcript so the next request fits. A decision keeps them
from starting anything new, but the repair itself still runs; threshold compaction
stays deferred to the next request either way.

A feature that can defer its own trigger asks `ctx.hasPendingUserDecision()` and
retries later, instead of firing into a queue that would replay work after the
decision: cron keeps the job due, and a goal continuation stays pending.

A user's own prompt always runs: that message is how the decision gets answered.
A host bridge forwarding a real person's input reports its own `source`, so the
message is not mistaken for extension-generated text. The same holds while a run
is in flight: input a person typed waits in the queue, and when the turn submits
a proposal, that input is still what the next request delivers — as that request's
input, not after a request the model already took. The gate reads the message the
agent would deliver next, not whether the queue contains one — work a feature
queued ahead of the user's words still waits.
The wait is settled where the message is delivered, not where a prompt is
submitted: a message queued behind the submitting turn arrives without a new
`prompt`, and that delivery is the only channel a caller handoff has.
Context an extension queued (`sendCustomMessage`) is held the same way: it is
flushed once the decision is answered, not into a question typed while it waits.
The guard never guesses from wording. On a host without a review surface the
decision belongs to the caller, and the only channel it has is a message; the
first message after the handoff therefore settles the wait. A caller that wants
the wait ended without writing a message sends `/plan off` (leave without
implementing) or `/plan approve` (accept the proposal), and `/plan approve
<hash>` binds the decision to the snapshot the caller actually read.

`approve` claims the whole input, so a malformed hash is refused rather than read
as a task: answering nothing would drop the wait and hand the broken text to the
model as something to plan. `/plan approve` alone answers whatever is waiting;
`/plan approve <hash>` must still match the reviewed snapshot after rereading the
file. Verbs are matched without case, since a host forwards what its user typed,
and a task whose text starts with one of them has to be rephrased.

Approving, or answering with a message, delivers what the decision held. Leaving
without approving releases the gate but starts nothing, so held work runs on the
next turn that starts.

Leaving is a stop, not only a state change: `/plan off` aborts the run in flight.
The Default announcement reaches the model's next request, so a streaming run
would otherwise keep going with the plan boundary already lifted and start
implementing the proposal the user just rejected.

A session written before the decision fact recorded its wait only in the
transcript. `restorePlanState` migrates it once, from the still-unanswered
handoff at the tail of the branch, so upgrading does not lift the gate on a
proposal nobody answered. An entry that already carries `pendingProposalHash`
keeps it under any version: a build that recorded the fact before this one did
so without bumping the entry, and the transcript scan would drop a wait the
branch still reports.
