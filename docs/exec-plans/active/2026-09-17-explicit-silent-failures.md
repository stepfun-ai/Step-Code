# Explicit silent failures: workflow VM gate + subagent lane recovery

Owner: youwang + Claude. Branch: `fix/explicit-silent-failures`.

## Problem

Three failure modes leave no user-visible trace:

1. `STEP_ENABLE_WORKFLOW=1` with a missing/unbuildable isolated-vm silently
   registers no workflow tools — an explicit "on" degrades with zero signal.
2. A failed background lane's `<agent-notification>` carries only the lane's
   aggregate output text; for multi-task lanes the per-task error reason can
   be diluted or absent entirely (empty output → headline only).
3. A dead keep-alive lane child is respawned silently ("resumes the transcript
   from disk") — the recovery chain erases its own crime scene.

Criterion applied: bad silence = an explicit user intent degrading invisibly,
or a recovery that leaves no trace. Deliberate fail-soft with a ledger (VM
parallel/pipeline null-on-error + journal) is NOT changed.

## Steps

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| registration-gate returns a refusal reason (`not-enabled` / `disabled-by-env` / `vm-unavailable`, vmAvailable injectable for tests); workflow extension warns once at session_start only for `vm-unavailable` | edit `workflow/registration-gate.ts`, `workflow/step-workflow.ts` | warning fires exactly once when explicitly enabled without VM; never-enabled stays silent | revert files |
| `notifyLaneFinal` appends per-failed-task reasons (errorMessage/stderr, deduped against output) | edit `subagent/lane-events.ts` | failed lane notification always names the cause | revert file |
| New `background_restarted` lane event: spawned-session registry in `runStepSubagentProcess` detects dead-child respawn, `onChildRespawn` plumbed through execute.ts into the lane, Delegation prompt lists the event | edit `step-subagent.ts`, `subagent/execute.ts`, `subagent/lane-lifecycle.ts`, `step/system-prompt.ts` | respawn produces a generation-guarded notification | revert files |
| Tests + changelog | add `test/workflow-registration.test.ts`, `test/subagent-lane-notifications.test.ts`; edit `CHANGELOG.md` | targeted vitest green; `npm run check` green | revert files |

No destructive or publishing side effects; code edits on a feature branch.
