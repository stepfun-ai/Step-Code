# Plan and task reliability implementation plan

> Execution: test-driven changes in an isolated worktree; independent review before the MR.

**Goal:** Make the existing plan and task tools reliable and legible without adding another checklist, compatibility tool, or runtime.

**Architecture:** Plan mode owns a Markdown proposal and the planning/approval boundary. Tasks own actionable execution items and progress, usable in any mode. Both use the existing extension lifecycle and session entries. UI is a projection, not a store.

**Tech stack:** TypeScript, existing ExtensionAPI / SessionManager / TUI, Vitest.

## Approved scope and design

The user approved continuation and an MR on 2026-09-07, emphasizing minimal code and separate plan/task semantics.

- Keep `enter_plan_mode`, `exit_plan_mode` and the four `task_*` tools. No `update_plan`/`TodoWrite` aliases, Markdown-to-task parser, scheduler, or new persistence layer.
- Restore task contents and plan mode from the active session branch on `session_start` and `session_tree`. Clear missing state. Task IDs use a session-wide high-water mark so sibling history cannot reuse an ID; branch contents remain isolated.
- Clone task data at input, snapshot, restore and tool-result boundaries. Reject dependency cycles before any mutation, including cycles introduced by a single mixed update. Preserve existing owner/metadata/dependency fields and status policy.
- The task extension owns `/todos`, a bounded progress widget, and task tool rendering. Render history from each immutable result. Reuse existing text/theme APIs; no changes to the generic tool renderer or TUI runtime.
- Unify `/plan`, `--plan`, model entry, and lifecycle restore. An explicit `--plan` enters planning at process startup even when the restored mode is off; later reload/new/resume/fork/tree events do not reapply it. Already-active restoration preserves its source without duplicate telemetry. Keep plan-file writes available and other file writes blocked. Keep the existing command permission policy, telemetry dimensions, and headless/RPC caller-owned approval behavior; describe these accurately.
- Require a readable nonempty regular plan file before offering approval/exiting. Keep Execute / Stay / Refine and no auto-generation of tasks from the document.
- Preserve only existing compatibility: legacy plan todos migrate to tasks, `/todos` stays, existing history rendering stays. Test migration during active-branch restoration without duplicate imports.
- State plainly in prompts/docs that plans describe approach/constraints/verification; tasks track execution. Use `task_list` when resuming multi-step work; do not inject the whole list every turn.

## Step

- [x] Audit latest `origin/main` (`2e1eef64ab9f9dcdff6231e3ed9ddd6b94cddc1f`) and reproduce snapshot aliasing, wrong-branch restoration, inconsistent `/plan`, cycle acceptance and empty-plan approval.
- [x] Confirm separate plan/task responsibilities with official Claude Code tool documentation and the official Codex checklist handler; do not depend on unverified defaults.
- [x] Create isolated `fix/plan-task-reliability` worktree based on latest main; preserve all existing worktrees and untracked files.
- [x] Review this design/plan and record baseline targeted tests.
- [x] Task state: add failing real-SessionManager regressions to `packages/coding-agent/test/step-tasks-extension.test.ts`; fix `src/extensions/step-tasks.ts` and bounded migration wiring if needed; rerun tests.
- [x] Plan mode: add failing lifecycle/entry/file-validation regressions to `packages/coding-agent/test/step-plan-extension.test.ts`; fix `src/extensions/step-plan.ts`, `plan-mode-tools.ts`, and migration wiring; rerun tests. Independent file ownership from task work.
- [x] Task presentation: add a small pure rendering helper only if it avoids repetition, using existing extension widget/tool renderers. Add focused tests for all statuses, clipping, immutable history, and `/todos` independently of plan mode.
- [x] Update `packages/coding-agent/src/step/system-prompt.ts` and its tests; update `packages/coding-agent/docs/step-integration.md` with the behavioral contract and official reference links; update root/package changelogs for the MR.
- [x] Independently review spec compliance and code quality; address concrete findings and rerun verification.
- [x] Stage only owned files, commit, push without force, and open a GitLab MR targeting `main` with verified results and intentional limitations. Published as MR !43 at `784bc87`; the original pipeline passed.

## Tool

- Git inspection/fetch/worktree only; `HOME=/home/youwang` for existing GitLab authentication. Never expose credentials, reset, stash, clean, force-push, or stage broadly.
- Baseline and focused regressions, from `packages/coding-agent`:
  `node ../../node_modules/vitest/dist/cli.js --run test/step-tasks-extension.test.ts test/step-plan-extension.test.ts test/step-system-prompt.test.ts test/step-capabilities-extension.test.ts test/tool-execution-component.test.ts test/session-manager/tree-traversal.test.ts`
- Add focused presentation/migration tests to the explicit command if new test files are needed.
- `npm run check` from root (full output; includes formatter writes), followed by `git diff --check` and explicit diff review. No build, full Vitest suite, real model calls, or dependency changes.

## Expectation

Old snapshots/results never change. Navigating backward or to a sibling branch restores that branch's tasks and plan state; returning to a branch preserves its own state. Rejected dependency updates are atomic. Planning is writable only at its plan-file exception and resumes consistently through every entry path. Missing/empty/unreadable plans do not exit. Tasks render concise progress and remain independent of plan mode. Existing headless/RPC and legacy-session behavior stays intentional and tested. Targeted tests and root checks pass; MR contains only scoped changes.

## Rollback

Before publication, revert only this worktree's owned changes. After publication, revert the scoped commits; no schema rewrite, session-file rewrite, dependency migration, or runtime replacement is introduced. Do not touch existing user changes or live runtime symlinks.

## Authorization

The user's instruction "接着继续 全面review 搞完之后mr" authorizes implementation, commits, push, and MR creation. It does not authorize merging the MR, release/deploy, or unrelated changes.

## Verification log

- Design/plan independently reviewed: approved; migration write ownership assigned to plan worker.
- Initial baseline: 35 tests passed across task, plan, prompt; two suites could not import missing MCP SDK / ignored model catalog assets. Rehydrating locked dependencies in this worktree only before retrying.

- Baseline hydration completed in this worktree only: locked dependencies installed with scripts disabled and ignored offline model catalog copied locally. Baseline targeted UI/tree suites passed 64 tests; combined with the original 35, all 99 baseline tests passed across five files.
- Verified the official Node 22.19.0 archive against its published SHA256 and use that temporary binary for verification; the host default 22.14.0 is below the repo minimum. No dependency/lockfile changes.
- Task state TDD: 11 failed / 8 passed before fixes, then 19/19 passed (snapshots, input/results, branch navigation, allocator, compaction, atomic dependency validation).
- Prompt TDD: 1 failed / 17 passed before wording changes; 18/18 passed after distinguishing proposals from execution progress, resume recovery, and external approval for non-TUI callers.
- Task presentation TDD: 10 failed / 20 passed before implementation. First implementation passed 29/30; the remaining test caught the TUI truncation helper appending ANSI reset sequences to otherwise plain RPC widget strings. Strip those resets at the widget projection boundary; 30/30 passed.

- Integration review clarified CLI precedence: initial `session_start` is `startup` even for `--continue`, while in-process resume/reload use distinct reasons. Explicit `--plan` should enter on that initial event when mode was off; no additional consumed-flag state is needed. The prior implementer preserved saved-off precedence from the original implementation; update the regression to cover the intended startup override and use `reload`, not a synthetic second `startup`, when testing non-reapplication.

- Task spec review found deletion bypassing dependency validation and misleading `task_get` readiness guidance. Regression tests failed 4/4 before the fixes; the complete task suite then passed 34/34. Independent re-review: spec compliant, no outstanding findings.
- Startup override TDD: persisted-off restoration failed while persisted-on restoration passed; after the minimal precedence fix, both cases passed (2/2).
- Root `npm run check` passed once after the task/prompt integration; repeat after final plan fixes and review. Formatter changes stayed within the owned files; no dependency or lock changes.
- Plan spec review found that legacy saved tool lists could drop the six currently active plan/task capabilities. Scope the repair to those six names and preserve the branch's ordinary built-in/custom selection; do not union all registered extensions or introduce a tool registry/version layer. Runtime tool exclusions and inactive capabilities must not be enabled by this repair. Add active-tool regressions for both lifecycle events, exit restoration, and genuinely registered sibling custom tools.

- Plan legacy-tool TDD: the five narrowed regressions failed before repair; all 58 plan tests passed after preserving only currently active plan/task capabilities in the saved baseline. Registered sibling custom-tool selection and inactive capability preservation are covered. No extra registry API or state was added.
- Added the existing capability-composition suite to final verification to cover six-tool registration and `/todos` ownership together with the targeted plan/task/prompt/UI/session-tree suites.
- Re-fetched `origin/main` before final verification; it remains `2e1eef64ab9f9dcdff6231e3ed9ddd6b94cddc1f`. Other worktrees were only listed, not modified.

- Independent plan spec re-review approved both the startup override and narrow legacy six-tool repair, with no remaining in-scope findings. A fresh reviewer is reviewing code quality/integration across the complete patch while final checks run.

- Final focused verification passed: 180/180 tests across six explicit suites (tasks 34, plan 58, prompt 18, capability composition 6, existing tool UI/session-tree 64). Command completed with exit 0; no full-suite, build, or real model calls were run.
- Final root `npm run check` passed with exit 0 on Node 22.19.0: formatter/lint, pinned dependencies, relative imports, shrinkwrap/install-lock consistency, TypeScript, and browser smoke checks. `git diff --check` also passed. The final test run occurred after formatter writes completed.

- Final code-quality review found a direct B-off → A-off navigation gap: off snapshots clear the transient tool baseline, and the old regression visited A-on first, masking the leak. Add direct and repeated restore cases plus legacy off-snapshot/new-entry coverage. Recover the latest saved baseline from existing active-branch plan entries, without adding a field/store or unioning ordinary tools. The prior 180-test/root-check results predate this follow-up; verification and re-review are required again before publication.

- Final quality follow-up TDD: the direct/repeated off-branch restore cases and latest-baseline/new-entry case failed 3/3 before the fix (59 plan tests total, other cases skipped for RED). Read the newest saved tool baseline from the active branch's existing plan entries; leave the transient baseline cleared while off. No new field, persistence format, or ordinary-tool union was added.
- Fresh post-review verification passed: 181/181 tests across the six explicit suites, exit 0 (449.77s total; 3.96s tests). Root `npm run check` passed again with exit 0, including browser smoke; Biome reported no fixes. These results include the off-branch fix and supersede the earlier 180-test run.
- Independent quality re-review approved the fix and closed its sole Important finding. Task/plan spec and final code-quality reviews have no outstanding findings. The full owned diff and tool/runtime ownership boundaries were reviewed again before publication.
- Final publication preparation re-fetched `origin/main` at `2e1eef64ab9f9dcdff6231e3ed9ddd6b94cddc1f`, confirmed the target project's default branch is `main`, and confirmed there is no existing open MR for this source branch. Publication follows this verification commit; keep this execution record active until the MR lands. No merge, release, or deployment is authorized.

## 2026-09-08 follow-up: clarify model-facing descriptions

**Approval:** The user approved the proposed wording upgrade and requested that it be added to the existing MR !43. That MR is open at `784bc87`; its original pipeline passed. This follow-up does not authorize merging or deploying.

**Scope:** Keep all six tool names, schemas, execution functions, state and permissions unchanged. `task_*` describes a session todo/checklist, not work execution, delegation or scheduling. Plan mode describes producing and reviewing a Markdown proposal, not another checklist. Entry returns the proposal path for existing file tools; exit requests review rather than promising unconditional exit. Preserve the file-only planning restriction and explicitly describe caller-owned approval after automatic headless/RPC exit. Keep common usage policy in the system prompt and field semantics in the existing schemas.

### Step / Tool / Expectation / Rollback

- [x] Review this bounded follow-up plan while the main worker reads the existing tests. Independent reviewer approved with no blocking gaps; no new design document or runtime abstraction.
- [x] RED: extend `packages/coding-agent/test/step-tasks-extension.test.ts`, `step-plan-extension.test.ts`, and `step-system-prompt.test.ts` with assertions on todo/proposal purpose, snippets, non-execution and mode-specific review semantics. Reuse their registration harnesses; assert important clauses, not snapshots of entire descriptions. Run only these three files and verify the expected wording failures.
- [x] GREEN: update only `description` / `promptSnippet` in `src/extensions/step-tasks.ts` and `plan-mode-tools.ts`, plus the matching task/planning guidance in `src/step/system-prompt.ts`. Preserve existing policy thresholds and runtime behavior. Update the existing integration section and unreleased changelog entries to state the clearer contract.
- [x] Verify the six explicit suites listed above and root `npm run check` using Node 22.19.0; inspect full output and `git diff --check`. Review the follow-up diff independently for inaccurate approval/security claims or accidental runtime/schema changes.
- [ ] Stage only this follow-up's owned paths, create a new commit, push normally to `fix/plan-task-reliability`, and update MR !43 with fresh verification. Verify the remote head matches the new commit; do not create another MR or rewrite the original commit.

**Tools:** The existing Vitest command under `## Tool`, narrowed to three files for RED; root `npm run check`; `git diff`; existing authenticated `glab` for MR !43. No new dependencies, full-suite/model calls, build, or release.

**Expectation:** Every tool explains its own purpose; task creation cannot be mistaken for spawning work, and `exit_plan_mode` cannot be mistaken for unconditional approval. Tool snippets and system guidance use the same terms. Existing state/approval behavior tests remain green.

**Rollback:** Revert only the follow-up commit if needed. It changes text, tests and documentation, not session data or runtime contracts.

### Follow-up verification

- RED: all three targeted suites loaded successfully; 4 expected wording assertions failed and 110 existing tests passed. Log: `/tmp/step-plan-tool-copy-red.log`.
- GREEN: all six explicit suites passed, 184/184 (task 35, plan 61, prompt 18, capability composition 6, existing tool UI/session-tree 64). Exit 0 after formatter writes completed. Log: `/tmp/step-plan-tool-copy-green.log`.
- Root `npm run check` passed with exit 0 on Node 22.19.0; its three formatter changes stayed in owned TS/test files. `git diff --check` passed; dependencies/lockfiles, schemas and execution functions are unchanged. Log: `/tmp/step-plan-tool-copy-check.log`.
- Independent follow-up code/spec review approved with no blockers. Re-fetched `main` remains `2e1eef6` and the MR source remains `784bc87` before publication. The commit is prepared here; its publication is recorded in MR !43 and the worklog after push.
