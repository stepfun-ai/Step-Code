# Ultracode, goal, and cron reliability review

## Scope and design

Update the requested checkout to the latest `origin/github-opensource`, then audit
ultracode/workflow, `/goal`, and `/cron` against documented Claude Code behavior.
Prioritize reproducible lifecycle, interruption, budget, and scheduling defects.
Keep changes within the existing extension/runtime boundaries. Preserve durable
Step cron support while making differences from session-local scheduling explicit.
Use repository and official reference evidence to distinguish bugs from optional
product changes. Implement bounded fixes with regression tests and update the
matching runtime documentation. Per the follow-up user request, collect all changes in one MR targeting `github-opensource` after verification.
The latest report adds live foreground workflow progress to this MR: while
subagents are executing, show their counts, task labels, and changing statuses
in the existing tool row.

## Execution

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| Inspect status and fetch requested branch | `git status`, `git fetch origin github-opensource` | No tracked local changes; record fetched commit | Read-only inspection; fetched refs can remain |
| Switch requested checkout | `git switch --track -c github-opensource origin/github-opensource` | HEAD matches fetched branch; existing `.tmp/` preserved | Switch back to original detached commit `ad8b2ea` if needed, preserving local work |
| Review implementation, tests, recent changes, and official Claude Code references | Targeted `rg`, file reads, HTTP GETs | Concrete triggers and code paths for findings | No runtime mutations |
| Reproduce defects and implement bounded fixes | Package-local Vitest; explicit file edits | Regression fails before fix and passes after; existing affected tests pass | Revert only this session's edits |
| Connect workflow progress to the live tool row | Runtime progress callback, tool update/render hooks, delayed-runner regression tests | Counts and task statuses update before agents finish, including queued and terminal states | Revert only this session's progress changes |
| Update feature documentation | Explicit Markdown edits | User-visible behavior and known limits match code | Revert only this session's edits |
| Verify and record findings | Targeted tests, `npm run check`, `git diff --check` | Required checks pass or pre-existing failures are evidenced; final diff reviewed | Fix session-owned regressions |

The user subsequently authorized one MR for the complete change. After checks,
create a feature branch, commit only this session's files, push that branch, and
open one MR to `github-opensource`. Do not merge it or change unrelated `.tmp/`.

## Progress

- [x] Original checkout inspected: detached `ad8b2ea`, only untracked `.tmp/`.
- [x] Fetched `origin/github-opensource`: `d57a7ca`.
- [x] Requested checkout updated and verified.
- [x] Ultracode/workflow audited.
- [x] Goal audited.
- [x] Cron audited.
- [x] Foreground workflow progress streamed and rendered during execution.
- [x] Reproduced defects fixed and verified on the initial base.
- [x] Integrated newly fetched `604a0fd` and repeated affected verification.
- [x] Documentation and final findings recorded; verified execution plan archived.

## Reviewed design and bounded fixes

Official references retrieved on 2026-09-20:
- https://code.claude.com/docs/en/workflows.md
- https://code.claude.com/docs/en/goal.md
- https://code.claude.com/docs/en/scheduled-tasks.md

Implementation targets:
1. Workflow: retain opt-in and turn budget across internal retries/compaction;
   relay cancellation that predates tool execution; keep budget exhaustion
   authoritative even when scripts swallow errors or schema retries are pending.
2. Goal: accept Claude Code's exact clear aliases, report failed interruption
   truthfully, expose a user-only budget adjustment so budget-limited goals have
   a working recovery path, and show spent tokens even with no limit.
3. Cron: validate complete expression tokens; traverse DST by elapsed minutes;
   use bounded deterministic jitter and preserve exact off-boundary one-shots;
   keep durable read/modify/write and dispatch under the storage lock; preserve
   unknown records and roll back failed writes; retry failed deliveries; include
   missed prompts; drain only at idle with user input ahead of cron work.

The independent goal evaluator, workflow background task management, and a full `/loop`
entrypoint are larger follow-up designs. They will be documented as remaining
Claude Code differences rather than implied to exist in this patch. Foreground
live subagent progress is explicitly requested and is included in this patch.

## Additional user request

Use `StepCode` as the model-facing product identity in the system prompt.
Update the CLI composition root and the existing prompt identity test; keep
configuration paths and environment variable names accurate to their runtime use.

## Regression evidence

- Workflow RED: 7 failures reproduced before the runtime fixes. GREEN: the affected
  runtime, extension, and opt-in files pass (native VM cases remain skipped).
- Goal RED: 11 failures reproduced for aliases, pause reporting, budget recovery,
  persistence, and unbounded usage. GREEN: the complete goal test file passes.
- Cron RED: 23 cases failed before fixes, covering parser/DST, multiple runtimes,
  durable data preservation, delivery retries, jitter, capacity, and idle delivery.
- Combined goal, cron, system-prompt, and host cancellation regressions: 146 passed.
- Live-progress RED: three extension regressions and six tool-row cases reproduced
  missing updates/task rows. GREEN: delayed runners expose running/queued tasks
  before completion; cancellation, budget rejection, replay, narrow terminals,
  expansion, redraw, and final error/result rendering pass.
- Before the late upstream integration: 220 coding-agent tests passed, 16 native
  VM cases skipped; 23 CLI tool-row tests passed.

## Late upstream integration

The requested branch advanced during this work to `604a0fd`. Its changes include
goal status projection, task-plan guidance, and renamed Step themes. After the
verified task checkpoint, merge that fetched upstream commit into the feature
branch, preserve its goal/task changes, update the new UI test to the current
theme name, and rerun the affected tests and required code checks. Keep one MR
targeting `github-opensource`. Roll back only the merge if integration fails;
the task checkpoint preserves all scoped work without touching `.tmp/`.


## Final verification and delivery

The final implementation includes upstream `604a0fd89c0c3dfc9b4e58a6bac9dcbf79e7b582`
and retains its goal-status projection, task-plan guidance, and `step-blue`
default theme. The feature branch is
`fix/ultracode-goal-cron-reliability-20260920`, with one MR targeting
`github-opensource` as authorized. The task checkpoint is `aa674e3`.

Verification ran with Node 22.19.0. A separate worktree at the same upstream
commit received byte-identical copies of all 21 task files; this keeps other
sessions' ignored nested worktrees out of the root Biome scan.

- Required `npm run check`: passed with complete output; 1,100 files checked,
  no fixes, and architecture/security, TypeScript, and browser smoke checks passed.
- Affected coding-agent tests: 221 passed, 16 skipped across 10 files. The skips
  require the unavailable native `isolated-vm` module.
- Affected CLI tests: 35 passed across five files, including workflow tool-row
  rendering, plan rows, task plans, and session working-state tracking.
- CLI subprocess startup tests against current sources: seven passed across
  four files.
- Full non-E2E validation: exit 0. Coding-agent: 2,925 passed, 66 skipped;
  CLI: 623 passed; providers: 469 passed, 124 skipped; agent-core: 465 passed,
  one skipped; evals: 23 passed. All remaining invoked package and script tests
  also passed.

The installed package `dist` files were stale and caused startup import failures
on the pristine baseline as well. Full validation therefore used the exact
`test.sh` commands and credential-isolated `env -i` environment with two added
source-resolution settings: `NODE_OPTIONS` loads a TSX adapter only when the
subprocess entry is `apps/cli/src/main.ts`, and `TSX_TSCONFIG_PATH` points to the
validation worktree's root configuration. Vitest and terminal dependencies do
not receive the adapter hooks. No real provider credentials or model calls were
used. Native VM isolation and packaged binaries were not validated.

Local verification artifacts:

- `/data/tmp/step-harness-feature-review-20260920/full-test-current-source.log`
- `/data/tmp/step-harness-feature-review-20260920/final-validation-manifest.sha256`
- `/tmp/step-harness-cli-source-loader.mjs`
- `/tmp/step-harness-test-current-source.sh`

The runtime contracts are recorded in `docs/orchestration-lifecycle.md` and
`docs/goal-lifecycle.md`. Remaining design work is explicit: background workflow
management, an independent goal evaluator, and `/loop`/`/effort ultracode` entry
points. Live foreground subagent progress is implemented and verified here.
