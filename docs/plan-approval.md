# Plan approval handoff

`exit_plan_mode` submits a written proposal for review. Leaving plan mode and
approving the proposal are separate events. In headless and RPC sessions, a valid
proposal exits plan mode, while the caller remains responsible for obtaining
approval before execution. This also applies to RPC contexts with `hasUI: true`;
their UI bridge does not provide interactive approval.

Plan mode does not hide tools: it denies mutating calls outside the plan file
through the `tool_call` policy, so the request's tool block stays byte-identical
and the provider's prompt cache keeps its prefix. Only a profile that lacks a
plan tool has it appended on entry, and that addition alone is reverted on exit.

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

Successful headless and RPC exits return the existing model-facing text plus
structured `details`, for example:

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

`outcome: "external_approval_required"` identifies a handoff awaiting the caller's
decision. `planModeExited: true` describes the resulting mode state; it does not
mean approval was granted. The result still has `terminate: false`, so the host
must gate execution through its own approval flow. These details do not add an
approval command or enforce an execution barrier.

`approvalSource` identifies who owns the decision: `"user"` for native interactive
review, including feedback and dismissal, and `"external"` for the headless/RPC
caller's approval flow. It does not indicate that approval has occurred. Source
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
  if (details.planModeExited !== true || details.planHash !== expectedHash) {
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
matching hash identifies content; it is not an approval token.

Native outcomes keep their existing behavior:

| Outcome | `approvalSource` | `planModeExited` | Behavior |
| --- | --- | --- | --- |
| `approved` | `user` | `true` | The user selected execution; restore tools and continue. |
| `feedback` | `user` | `false` | Keep planning and steer the user's notes into the next response. |
| `dismissed` | `user` | `false` | Keep planning and terminate the turn to wait for the user. |
| `external_approval_required` | `external` | `true` | Headless/RPC handoff; the caller must gate execution. |

The TUI still selects execution by default, and Enter confirms that selection.
Interactive result details also include the hash of the reviewed snapshot.
Transcripts display external handoffs as **External approval required**, with the
complete plan, rather than displaying an approved result.

Missing, empty, whitespace-only, unreadable, and non-regular plan files retain
their existing explanatory text and leave plan mode active. Their `details` are
`undefined`; they never receive a successful handoff outcome or hash. Calling
`exit_plan_mode` outside plan mode likewise returns no handoff details. A
non-error tool result alone is therefore insufficient to recognize a handoff.

`approvalSource`, `planHash`, and `planModeExited` are optional in `PlanReviewDetails`
for compatibility with existing producers and older transcripts. Native results
with a valid plan populate all three fields. Consumers should handle their absence
explicitly and must not infer approval or its source from missing fields, or infer
approval from plan-mode exit alone.
