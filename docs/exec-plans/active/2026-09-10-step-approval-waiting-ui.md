# Step approval waiting UI implementation plan

> **For agentic workers:** Use `superpowers:executing-plans` and test-driven development. The source-fix and local-test phases prohibited commit/push; the user-authorized MR publication phase below now permits committing and pushing only this fix. Do not restart existing user processes. Live tool approvals were prohibited in the source-fix phase; the later user-authorized live regression phase below permits individually reviewed, task-relevant operations. The source-fix phase did not deploy; the user subsequently authorized building and replacing the sc-selected local Step runtime for testing, under the bounded deployment section below.

**Goal:** Make a pending Step tool approval visibly different from running work, distinguish successive tool calls, and settle dismissed dialogs safely.

**Architecture:** Keep permission policy, agent-loop events, and parallel batch scheduling unchanged. Own transient waiting state in the interactive product UI, preserving custom working settings. Use the existing per-call ID rather than inventing a second batch scheduler. Keep approval controls visible with the existing overlay path. Validate dialog replacement/abort cleanup with a failing test before changing it.

**Tech stack:** TypeScript, Vitest, existing TUI components; source regressions are offline. A separately authorized live-model regression is recorded below.

## Evidence and boundaries

A parallel batch emits tool-start events and prepares approvals serially before executing approved tools. Approving one distinct `run_command` can therefore immediately reveal another approval with the same old heading. The existing working row and tool clock animate during this wait. This is not evidence of a repeated shell execution. A stale on-screen dialog is not established by incremental terminal traces alone.

This fix does not disable approvals, auto-accept anything, change approval timeout defaults, or claim that source changes are deployed to the existing process. Session data, credentials, and personal diagnostic evidence stay outside the repository.

## Steps

| Step | Tool / paths | Expectation | Rollback |
| --- | --- | --- | --- |
| 1. Recheck upstream and isolate | Read-only process/session metadata; authenticated `git fetch`, fast-forward only; new sibling worktree `step-harness-approval-ui-fix` | Base is the freshly verified upstream main; no pre-existing edits lost | Stop on dirty tracked files/divergence; retain the original checkout and other worktrees |
| 2. Read full affected sources and existing tests | `src/step/permissions.ts`; `src/modes/interactive/interactive-mode.ts`; selector, spinner and status components in `packages/coding-agent` | Small product-layer design with explicit waiting lifetime and no policy changes | Refine this plan before production edits if contracts differ |
| 3. Red regressions | `test/step-permissions.test.ts`, new `test/interactive-mode-approval.test.ts`, spinner/selector tests as required | Tests fail on generic identity, animated approval wait, and any reproduced orphaned dialog promise | Delete only this task's new tests if the hypothesis is disproven |
| 4. Minimal implementation | Permission title/identity and overlay; private interactive waiting/settlement lifecycle; pause clock/rendering as necessary | Approve, deny, escape, abort, timeout, replacement and reset all clean up; custom working preferences survive | Revert only this task's exact hunks; never reset/stash/clean other work |
| 5. Verification | Specific offline Vitest files from `packages/coding-agent`; focused TUI tests if changed; `npm run check` with full output | All changed tests pass, check exits 0, no real provider calls | Fix bounded regressions; report unrelated baseline issues accurately |
| 6. Focused review and handoff | Review current diff, update matching UI docs, global worklog and sanitized evidence | Reproducible source patch and honest deployment boundary | Keep isolated uncommitted worktree; no publishing without explicit request |

## Checklist

- [x] Latest upstream and runtime rechecked; isolated worktree ready.
- [x] Regression tests observed failing for the intended reasons.
- [x] Approval heading includes tool and distinct call identity.
- [x] Waiting state is static; normal running UI resumes without losing custom settings.
- [x] Dialog outcomes settle exactly once; stale callbacks cannot dismiss the replacement.
- [x] Controls remain usable, including constrained terminal sizes.
- [x] Targeted tests, full `npm run check`, focused review and docs complete.
- [x] Original checkout and live runtime deployment status reported precisely.

## Concrete design (after source inspection)

- Do not add a public dialog option or change core events. `showExtensionConfirm` privately marks its selector as an approval. Normal `select` and `input` prompts do not opt into that state.
- `WorkingStatusIndicator` gets a temporary approval-wait state: static waiting text instead of the running verb/tokens/tip, with both its animation and verb timers paused. Its original message/indicator configuration remains intact, including preference changes made during the wait.
- `StepToolSpinnerClock` gets a reversible pause. Waiting tool rows show a static glyph, do not request periodic renders, and do not count this UI approval wait as displayed running time. Runtime/telemetry durations are unchanged.
- Selector and input completion use idempotent per-dialog finish callbacks. Replacement cancels the previous simple dialog, removes its abort listener and timeout, and cannot let a late callback dismiss the replacement. UI reset and stop settle pending simple dialogs as cancelled.
- Step permission prompts use the existing `overlay: true` path and display the tool name plus a short call-ID suffix; keep the full ID and existing bounded input summary in the body. Explain that batch calls can require separate approvals before execution. Approval policy, default timeout, and Yes/No behavior stay unchanged.
- Test actual interactive dialog methods with real TUI components and a virtual terminal; no live-session input or provider request. Add focused unit tests for reversible status/spinner pause and permission prompt identity.

Baseline setup uses `npm ci --ignore-scripts`. The initial working-output suite could not import ignored provider JSON catalogs in the new worktree; copy only those generated data files from the same-SHA latest checkout and validate before re-running. The system Node is 22.14.0 (below the repository's 22.19.0 engine declaration); record setup warnings and use a compatible existing/isolated Node runtime if verification requires it. Do not change lockfiles or dependencies to conceal environment issues.

Plan review: Approved (read-only). Explicitly cover confirm/input cross-replacement, stale callbacks, reset/stop, preference changes/recreation, paused tool start/clear, and constrained viewport controls. Baseline: five targeted files, 30 tests passed before behavioral edits.

## Implementation and verification record

- Red: the three component/policy files produced 9 new failures with the 20 existing tests passing. The real interactive suite reproduced 20 failures out of 22: running presentation while confirming, unresolved replaced/reset/stopped dialogs, mount-error leftovers, and missing call identity. No shell tool or real provider was executed.
- First green iteration: 50/51 passed. The remaining 40×16 virtual-terminal failure showed a truncated cancel hint; Step selector hints now use the existing ANSI-aware wrapping utility. This is presentation only; keybindings are unchanged.
- Matching product behavior is documented in `packages/coding-agent/docs/step-integration.md`, not just this execution record.
- Verification uses an isolated official Node 22.19.0 binary with its archive SHA256 checked against the official release checksum list. No global Node/CLI installation or dependency/lockfile change. Check subprocesses use a task-owned TMPDIR to avoid collisions with other seats' browser-smoke artifacts.
- Initial `npm run check` formatted five scoped files, then flagged two now-write-only dialog fields. The cleanup now checks component ownership before clearing those fields; subsequent full checks pass. No unsafe autofix used.

### Upstream refresh before handoff

At 2026-09-10 21:41 UTC+8, a new upstream merge was found: `cff4dde934fa3b84004658e06157d3863ea01edb`. Both the requested checkout and the isolated fix worktree are now fast-forwarded to it. The only overlapping files were `permissions.ts` and its test; task-owned bytes were backed up with SHA256, merged three-way successfully, restored only for the fast-forward, and replaced with the merged bytes. No stash/reset/clean, commit, or loss of the original untracked release plan.

The upstream merge changes the default preset to bypass (explicit CLI/env/persisted settings still take precedence). This patch preserves that upstream behavior and does not modify the user's runtime configuration. New approval tests explicitly select `initialPreset: "ask"`; bypass must not make them appear to pass. Installer changes are upstream, not this fix. Provider catalog files are unchanged by the upstream refresh.

Before the refresh: full `npm run check` exited 0, and 12 explicit offline test files passed 178/178 tests. Reverification on the new base follows; no installed CLI or live session has been changed.


### Final review and verification

The focused code review returned one Important finding and no Critical
findings: closing confirmation A restored editor focus synchronously, which
could open confirmation B, after which A's cleanup incorrectly resumed B's
working/spinner state. Two new real-TUI regression cases (inline and overlay)
failed on the running status text instead of `Waiting for approval`.

The owning selector now releases its waiting state before dispose/unmount can
restore focus. It does not clear a replacement's state, and completion remains
idempotent. Both reproductions then passed. This is a verified narrow fix for
the review finding; no broader lifecycle or scheduling refactor was added.

Final verification on `cff4dde934fa3b84004658e06157d3863ea01edb`:

- Full root `npm run check`: exit 0, including Biome, pinned dependencies,
  import checks, shrinkwrap/install-lock validation, TypeScript, and browser
  smoke. Biome formatted only the newly added regression test.
- Twelve explicit offline test files: 180/180 passed, including the two new
  focus-restoration regressions and the 122x44, 80x24, and 40x16 viewports.
- `git diff --check`: clean; final changed/untracked paths are limited to the
  eleven task-owned source, test, documentation, and plan files. No staged
  changes, dependency edits, or lockfile edits.
- Upstream main was rechecked at 2026-09-10 22:35:36 UTC+8 and still matched
  `cff4dde`; the requested checkout is on that SHA and retains its pre-existing
  untracked release plan.

Keep `fix/approval-waiting-ui` and this isolated worktree uncommitted for
handoff. The installed CLI was not built, replaced, or restarted, and this
source patch is not deployed. The user's permission configuration is unchanged;
the upstream default-preset change is separate from this fix. Diagnostic
receipts and personal worklog entries remain outside the repository.


## Authorized local test deployment (2026-09-10)

The user explicitly requested replacing the Step harness launched by `sc` with
the tested fix. This authorizes a local build and installation only: no remote
release/upload, commit/push, edits to authentication/session/permission settings,
or automatic termination/restart of existing processes.

| Step | Tool / paths | Expectation | Rollback |
| --- | --- | --- | --- |
| 1. Resolve sc launch chain | Read launcher scripts, selected binary paths, and whitelisted live-process metadata | Identify the exact Step executable without assuming another sc/Codex seat is Step | No mutation; stop installation if target identity is unclear |
| 2. Build isolated test artifact | Existing `scripts/build-binaries.sh --product step --platform linux-x64 --offline-model-data --skip-install --skip-deps --out <new task directory>` with compatible Node/Bun and explicit dev version | Build exits 0; source tests remain valid; no dependency/config changes or provider calls | Leave old installed executable untouched; remove only own failed staging output if needed |
| 3. Smoke staged runtime | Isolated HOME/config plus `--help`, `--version`, and offline controlled TUI confirmation | Correct dev identity, resources load, fixed waiting/approval flow visible and cancelable | Do not install if startup/resource/approval checks fail |
| 4. Install sc-selected Step atomically | Keep a hash-verified backup; place complete runtime in a new versioned directory; compare old executable SHA immediately before a single atomic path switch | Next sc launch resolves the verified artifact; unrelated sc backends and running processes unchanged | Restore prior launcher bytes/link atomically from backup; retain old resource directories |
| 5. Verify and hand off | Recheck selected path/SHA/version, launch-route smoke without real prompts, record receipt and rollback | User can launch their existing sc workflow to test; distinguish new launches from old in-memory processes | Restore old target if post-install smoke fails; do not auto-approve user work |

- [x] sc runtime identity and unchanged configuration boundary verified.
- [x] Isolated binary build and offline smoke tests pass.
- [x] Exact local runtime switched with verified backup and rollback path.
- [x] sc route verified and user test instructions recorded.

Owner confirmation is the user's current explicit request to replace the
sc-launched harness for testing; no additional generic confirmation is needed
for this bounded local operation. Approval behavior must be tested in explicit
ask mode, not by relying on the upstream default bypass preset.


### Deployment verification checkpoint

The local versioned runtime was installed successfully on 2026-09-10 after
229 bundle files were hash-verified. Both staged and installed binaries passed
the loopback-only two-approval test (approve first, cancel second, execute only
the first, receive both tool results). The actual `sc agent check stepcli` route
reported the approval-ui build. The earlier source-only nondeployment paragraph
is historical; the local entrypoint now selects the tested build. No existing
process was restarted. Personal paths, receipts, backup, and rollback remain in
the operator's global worklog/runtime backup, not repository artifacts.

## Authorized live-model regression (2026-09-10)

The user explicitly requested a new tmux pane, actual `sc`, session model
`water18-0910`, and their exact Chinese research prompt ending in `保存成a.pdf`.
This is authorization for one real model run, not a synthetic-only test.

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| 1. Isolate and identify | New task-owned workspace and tmux session, real user HOME in a whitelisted child environment; hash/version probe | No existing seat is modified; installed fixed runtime is used | Stop only the newly created process if launch identity is wrong; preserve evidence |
| 2. Select model in TUI | `sc stepcli --approval-mode confirm --no-update-check`, then `/model water18-0910` | Footer and session model event match; selection is session-only | Exit new session; do not overwrite global model or permission preferences |
| 3. Submit exact prompt and observe | Literal paste; inspect each approval before approving only bounded relevant research/PDF actions | Distinct call identities, static waiting state, decisions settle, actual tool progress | Deny unrelated/dangerous actions; preserve pane for diagnosis rather than bypassing approvals |
| 4. Validate and hand off | Inspect native event metadata, PDF signature/pages/text, runtime SHA and configuration boundary | Report actual live outcome separately from prior offline test; user can inspect pane and PDF | Keep original runtime backup and isolated run artifacts; no commit/push |

- [x] Task-owned pane and fixed runtime identity verified.
- [x] In-TUI water18 model selection and exact prompt submission verified.
- [x] Live approval sequence and subsequent progress observed.
- [ ] PDF artifact validated, limits documented, pane handed off.

Do not silently substitute a different model, write a replacement report in the
operator seat, auto-approve all tools, use upstream bypass mode, or claim a
successful live regression if provider/auth/report generation blocks it.

### Live regression finding: multiline projected rows

The real model emitted multiline here-document `run_command` inputs. Pending
approvals settled and native call/result IDs were unique, but each running
spinner refresh painted another physical command heading and left dialog/status
fragments behind. The existing offline smoke used single-line commands and
therefore did not cover this failure.

Source trace: `formatStepCallTitle` inserts the raw command into a string and
replaces `callLines[0]` after the native `Text` renderer has already split its
rows. `clampStepLine` only checks visible width; it leaves embedded CR/LF/TAB
intact. The differential terminal tracks one array element as one physical row,
so cursor accounting diverges. Raw path/query-based collapsed summaries can
reach the same projection boundary.

This is a verification-driven correction within the existing authorized
presentation-only fix, not a new tool, permission policy, or scheduler change.
Retain full original arguments, native renderer bodies, and persisted messages.
Normalize row-control whitespace only at the Step row-clamping boundary, before
width measurement. Do not rewrite scripts, change model research, or globally
change the TUI renderer. Fixing only run_command's title would leave path/query
summaries vulnerable; forcing full-screen redraw on every frame would mask the
contract violation and discard differential-renderer behavior.

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| 1. Red regression | New explicit Step row-contract tests, real TUI plus VirtualTerminal | Multiline pending/settled titles and redraw cycles fail on embedded row controls or duplicated headings | Keep original runtime/session untouched; only task-owned test file |
| 2. Narrow repair | Step row projection helper, matching integration doc | Every projected row is one terminal line and width-bounded; original args/body unchanged | Revert only these task-owned hunks |
| 3. Reverify | New test + prior explicit regression files, full `npm run check` | All pass; source-only claims separated from installed runtime | Do not deploy a failing build |
| 4. Rebuild and validate | Existing binary build, loopback multiline TUI smoke, atomic versioned local update, sc launch check | Fixed binary passes original approvals plus animated multiline command rendering | Preserve both previous runtimes and guarded rollback; do not restart unrelated seats |
| 5. Real test closeout | Preserve original research run; inspect PDF and run new binary in the owned tmux test surface | Report real outcome and any independent research/auth limitations | No fabricated report or unsupported all-fixed claim |

- [x] Multiline row/real-terminal regressions observed failing.
- [x] Step projection repaired without changing executed arguments.
- [x] Full check and explicit test matrix pass after the repair.
- [x] Rebuilt installed binary verified against multiline rendering.


Multiline red evidence: all 12 new cases failed before production edits. Nine
cases exposed embedded CR/LF/TAB in a supposed physical row, including command,
path, and query titles. Three real VirtualTerminal redraw cases (122x44, 80x24,
40x16) accumulated six visible `run_command` headings for one component after
five spinner frames and completion. No model or command was executed by these
tests.


### Multiline repair and resumed-runtime verification

The Step-only projection now replaces tabs and embedded CR/LF before measuring
and clamping each row. The 12 new regressions pass; the focused component pair
passed 46/46, and the broader explicit matrix passed 13 files / 170 tests.
A fresh post-deployment run passed the full root check (no autofixes) and six
explicit approval/spinner/tool-rendering files, 99/99 tests. These selections
overlap and are not additive. Source hashes still match the deployed build.

The real binary loopback A/B reproduces the original defect: two native calls
produce eight running and nine completed command headings in the prior binary.
The staged and installed repaired binary produces exactly two in both phases.
It preserves approve/cancel behavior and executes the original multiline script
unchanged, including a marker after a shell comment. Focused read-only review
found no Critical or Important issue.

The complete local runtime was rebuilt and switched atomically; a fresh sc
route check reports the second approval-ui development build. Only the
user-authorized test process was gracefully exited and resumed on this build;
the original test pane is retained, and unrelated seats remain untouched.
The original prompt/native session is preserved. After resume the sc-selected
default model appeared in the footer, so the requested model was explicitly
reselected in the TUI before any new model prompt. A short, recorded technical
continuation resumed the research.

The resumed live run has progressed through distinct, individually inspected
approvals with static waiting frames and linked native results. Research/PDF
completion remains a separate open check: builtin search lacks a dedicated
credential, and a public quote endpoint returns TLS EOF. Do not count those
retrieval failures as a renderer loop or claim a PDF exists without validation.
Personal receipts, runtime paths and credentials stay outside this repository.


### Live UI regression closeout; PDF acceptance remains open

An actual requested-model shell loop with eight embedded newlines was sampled
through approval, execution and completion. Its single command heading remained
single in all 12 waiting, 16 running and 16 completed snapshots. The native
record has unique call/result identities, and the active executable hash is the
new installed runtime. No synthetic command was substituted in this live run.

The test pane is retained at a normal pending approval for the next public-data
fetch. Research/PDF acceptance is incomplete: no a.pdf exists at closeout,
builtin search credentials are absent, and quote endpoints returned TLS EOF
or HTTP 403 (alternative pages returned HTTP 200 but their data was not yet
validated). Keep the PDF checkbox open; do not report this as a successful
end-to-end financial report. No further automatic approvals or unrelated
process changes. Source/worktree are retained uncommitted for user testing.


## User-authorized MR publication (2026-09-10 UTC)

The user requested a merge request and asked that it explain the earlier
problems together, not just the multiline follow-up. This authorizes a scoped
commit, push of this fix branch and creation of one MR against main. It does
not authorize merging, a tagged release, more paid research, credential changes
or restarting the already-installed test runtime. This publication phase
supersedes only the earlier no-commit/no-push restrictions.

| Step | Tool / scope | Acceptance | Rollback |
| --- | --- | --- | --- |
| 1. Recheck target and ownership | Read-only GitLab project/MR queries, HTTPS fetch, source hash and index checks | Current main verified; only task-owned changes and no duplicate MR | Stop on permission errors or unexpected source/index changes; no forced Git operation |
| 2. Prepare reviewable publication | Existing source/tests, integration doc, root/package Unreleased notes and this plan | Explain successive approval identity, waiting animation, dialog settlement/reentrant focus and multiline row corruption; separate retrieval limitations | Restore only this phase's exact documentation edits if scope is rejected |
| 3. Independent pre-MR review | Read-only review of integrated diff, regression coverage and scope | No unresolved Critical/Important correctness findings; no personal runtime artifacts/secrets | Fix a reproduced issue with a failing regression before continuing |
| 4. Fresh verification | Full root check, explicit regression files, isolated credential-free `./test.sh` | Record actual results and distinguish unrelated baseline/environment failures | Do not relabel partial tests as full-suite success or weaken tests to pass |
| 5. Commit/push/create MR | Explicit path staging, normal hooks, non-forced push, one MR from this branch to main | Committed/pushed SHA and MR source/target/diff match the reviewed fix; no merge | Keep local worktree; stop if remote branch differs; no force push or remote deletion |
| 6. Verify remote receipt and handoff | GET MR/commits/changes/pipeline metadata | MR body includes all prior symptoms, actual verification, scope and open PDF limitation | Correct MR text if inaccurate; no automatic merge |

- [x] User explicitly authorized this MR publication and combined explanation.
- [x] Current main, repository permissions, source hashes and empty index checked.
- [x] Independent integrated review and fresh verification recorded.
- [ ] Only scoped source/tests/docs committed and pushed.
- [ ] One MR created and source SHA, target, file list and description verified.

Project-specific AGENTS.md requires Step product and package changelog notes
for the MR. Existing released entries are immutable. No dependency/lockfile,
provider contract, agent-loop, approval-policy or report-generation change is
part of this publication. Historical test/deployment evidence above remains
a checkpoint record rather than a claim that an installed process uses a
future commit. The real-model PDF acceptance checkbox remains open.


### Integrated review follow-up: reentrant replacement/teardown

The independent pre-MR review source-traced an additional ownership hole:
opening B cancels A, A restores editor focus, and a custom editor synchronously
opens C before B finishes replacing A. C can lose its cancellation callback or
remain underneath B. Reset/stop can similarly leave a refocus-created dialog
unsettled. This is distinct from the earlier direct-dismissal pause-order fix.

Within the already-approved transient-dialog scope, make replacement cleanup
and the full reset/stop operation a synchronous dialog-suppression boundary.
A simple select/confirm/input requested inside that cleanup returns its normal
cancelled result without mounting or starting a timer. Direct user dismissal
still permits a refocus callback to open the next dialog. A finally-restored
private guard is preferable to repeatedly closing dialogs (which can itself
reenter forever) or adding a second dialog queue/generation policy.

| Step | Tool / scope | Acceptance | Rollback |
| --- | --- | --- | --- |
| 1. Reproduce | Real-TUI tests combining refocus with confirm/input replacement and reset/stop, inline and overlay | Observe orphaned promise/ownership failures before production edits | Retain prior source bytes and red evidence outside the repo |
| 2. Narrow lifecycle repair | Private simple-dialog suppression during replacement cleanup and reset/stop | Original/requested promises settle once; only the intended overlay remains; no leaked countdown; direct-dismissal follow-up remains supported | Revert only new follow-up hunks |
| 3. Recheck and review | Explicit lifecycle/matrix tests, full check and isolated offline suite; same reviewer | No Important/Critical finding; final-source verification separate from prior deployed-binary evidence | Do not commit/push a failing or unreviewed change |

- [x] Combined reentrant regression observed failing.
- [x] Narrow lifecycle repair and regression matrix pass.
- [x] Independent follow-up review and final verification recorded.

This MR-only hardening does not replace or restart the already-installed test
binary. The prior live-model evidence applies to the earlier UI build; the
follow-up has its own source-level regression evidence.

Corrected red verification reproduced 24 failures in the 32 new combinations:
each had an unsettled refocus-created promise. The other eight combinations
and all 24 prior cases passed (24 failed / 32 passed overall). The initial
28-failure run also counted four zero-delay xterm parser callbacks as leaked
dialog timers; that result is superseded, not additional product failures.
The fixture now flushes only zero-delay parser work, without advancing the
1000-ms countdown interval or clearing timers to conceal a leak. Re-running
the prior source with this corrected fixture confirms the 24 failures;
restoring the repair passes all 56 cases.

The fix uses one private synchronous suppression guard, restored with finally,
around existing replacement and reset/stop cleanup. It does not add a queue,
alter normal dismissal callbacks, or change permission decisions. The complete
root check passes, and the six-file explicit approval/spinner/tool-rendering
matrix passes 131/131 tests after this final source change.

Independent follow-up review resolved the Important ownership finding and
found no remaining Critical or Important code issue. Its focused selection
passed 34 cases (32 new combinations and two preserved direct-dismissal
regressions; 22 other cases deliberately unselected). The sole Minor finding
was the stale initial red count, corrected above. The final offline-suite and
publication receipts are recorded in the next checkpoint.

### Final pre-publication verification checkpoint

The final source and tests are unchanged from the reviewed green revision.
Full root `npm run check` passed; the six explicit regression files passed
131/131, including all 56 lifecycle cases. Independent review has no remaining
Critical/Important issue, and its Minor evidence-note correction is included.

The complete isolated offline suite passed with `taskset -c 0-3 ./test.sh`:
all workspace runners exited successfully; coding-agent reports 318 files and
3111 tests passed, with its existing 7 files / 63 tests skipped. This bounds
only this test process's CPU affinity, giving the installed Vitest runner
three default workers instead of fourteen. It does not edit the runner,
source, test selection, assertions, timeouts, or the credential-free isolation.

Two prior runs at default fourteen-worker concurrency each had one failure in
the existing startup-session-name test (`code=null`). That test kills its CLI
child after 10 seconds, but the failing assertion did not preserve the signal,
so the kill mechanism is not claimed as directly observed. The unchanged test
passed three isolated runs (the first took 9.94 seconds); three equivalent CLI
invocations also exited 1 normally with the expected saved name. The bounded
full run supports a startup/concurrency sensitivity diagnosis; do not relabel
the two default-concurrency runs as passing. No unrelated timeout was raised.

An earlier four-test find failure was isolated to missing fd in the offline
PATH. Adding the same fd/rg tools present in CI, without changing source,
passed both affected files (76/76). The final suite used Node 22.19.0, fd 10.5.0
and rg 15.2.0. Failure logs and source/hash/verification receipts are retained
in the operator's global worklog, outside the repository.

The publication checkboxes for commit/push/MR above remain open at this source
snapshot. Actual remote completion, commit identity and CI state are recorded
in the MR and operator receipt after publication; no successful merge/release,
runtime redeployment or financial-PDF acceptance is implied by this checkpoint.
