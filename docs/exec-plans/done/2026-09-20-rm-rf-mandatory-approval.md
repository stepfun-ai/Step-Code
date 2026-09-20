# Mandatory approval for recursive forced removal

Base: `github-opensource`. Any future PR/MR targets only `github-opensource`.

The current detector only recognizes recursive forced removal of critical roots.
Require explicit approval for every matched `rm` invocation with recursive and
force options, regardless of target. Preserve strict/read-only denial and deny
unattended execution when no approval channel exists.

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| Isolate changes from github-opensource | `git worktree add -b codex/rm-rf-mandatory-approval` | Original checkout and concurrent edits remain untouched | Keep the isolated worktree; revert only task-owned edits if necessary |
| Centralize command rules | Edit product-layer command detector and permission integration | Named, typed rules share shell inspection; recursive force removal is target-independent and cannot use automatic approval | Restore only task-owned hunks |
| Verify policy and command forms | Targeted offline Vitest tests | Combined/split/long flags, wrappers, compound commands, per-call approval, refusal, and unattended behavior pass | Fix regressions before delivery |
| Document and check | Update matching docs; `npm run check`; `git diff --check` | Policy boundaries and extension mechanism documented; checks pass | Retain evidence and report blockers |
| Finish | Move this plan to `docs/exec-plans/done/` | Verified uncommitted change ready for review | No commit, push, merge, or publication requested |

No destructive commands will be executed by tests. Test command strings are
passed only to policy evaluation and mocked approval handlers.

## Initial verification

- Isolated branch: `codex/rm-rf-mandatory-approval`, based on
  `github-opensource` at `57fa228e1e0350439e63c99b49a9afa24ba1e13b`.
- Moved the existing detectors into `step/command-policy.ts`, using a typed,
  named rule registry and shared shell traversal. Recursive forced removal now
  matches independently of its target. Preset descriptions mention the exception.
- Covered combined, split and long options, option termination, wrappers,
  command chains, shell command strings, PowerShell command arguments, escaped
  newlines, ordinary argument text, all presets, tool allow overrides, repeated
  approval, denial, and unattended/background requests.
- Initial regressions: 60 failed, 50 passed across the command and permission
  suites before implementation. Replaced the ordinary-write fixture with
  `mkdir build` so its existing unattended-policy tests retain their purpose.
- Final targeted verification: 5 files, 202 tests passed with
  `pnpm exec vitest --run test/step-command-policy.test.ts test/step-permissions.test.ts test/step-extension.test.ts test/step-plan-extension.test.ts test/step-stdio-host.test.ts`
  from `packages/coding-agent`.
- `npm run check` passed with full output: 1,098 files checked, no final formatter
  changes; architecture checks and TypeScript passed. `git diff --check` passed.
- The installed toolchain reports npm/pnpm configuration warnings and a Vitest
  config-bundling warning for the root `vitest/config` import. Commands still exit
  zero; dependency/configuration files and the lockfile were not changed.
- Added command-policy documentation and persisted the requested branch policy
  in `AGENTS.md`. No dependency, agent-loop, transport, or TUI changes.
- This remains static command inspection, not a shell sandbox. The initial
  implementation retained existing substitution/regex matching; the review
  follow-up below replaces substitution matching with quote-aware scanning.
  Aliases, dynamically constructed commands/options, and script-file contents
  are not evaluated.
- No commit, push, merge, or publication performed.

## Review follow-up

The user requested a standards and requirements review. Independent read-only
reviews run against the original base plus all tracked and untracked task files.
Detector-only probes reproduced missed literal commands with redirection and
wrapper arguments, false positives in quoted/commented substitutions and empty
shell scripts, and an explicit deny override becoming a confirmation.

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| Record regressions | Targeted policy tests; no shell execution | Each confirmed gap fails before its repair | Revert only follow-up test hunks if a finding is invalid |
| Repair command inspection and deny precedence | Product command policy and existing controller | Literal executable forms ask; inert text does not; explicit denial stays denial | Revert only task-owned follow-up hunks |
| Recheck and independent re-review | Focused Vitest; full `npm run check`; read-only reviewers | Tests and checks pass; findings resolved or accurately reported | Keep uncommitted work isolated |

### Review outcome

- Standards review found no hard violations. Detector tests now import the
  detector module directly; existing public exports remain available without
  compatibility branches or changes to package entry points.
- Requirements review identified eight findings across its passes, all resolved:
  literal command bypasses, inert-text false positives, explicit deny precedence,
  comments inside substitutions, grouped wrapper options, named file descriptors,
  heredoc text handling, and heredoc outer expansion when feeding a shell.
- Wrapper option metadata is per command. Shell traversal is shared across
  named rules and handles quoted substitutions, empty arguments, redirections,
  process substitutions, `find -exec`, and `xargs`. Heredoc input separates
  literal text, outer expansion, and script input to a shell.
- All regression strings are inspected only; tests do not execute them. Initial
  follow-up regressions failed 13 cases before repairs; subsequent review cases
  were added before their respective repairs where practical.
- Final targeted run: five files, 239 tests passed using the same five-file
  command above. The independent requirements reviewer also ran the detector
  suite: 126 tests passed. Final review: eight resolved, zero unresolved blocking
  requirements findings within the documented static-inspection scope.
- Final `npm run check` and `git diff --check` passed. Package manifests and
  lockfile remain unchanged. npm/pnpm configuration warnings and the Vitest
  root-config import warning remain toolchain limitations; do not interpret a
  zero exit status as a warning-free pre-commit result.
- Manual `!` input and RPC `bash` use the separate user-command event and are
  explicitly outside this agent-tool policy. Removed the misleading fabricated
  `user_bash` tool-call test parameter. SDK agent tools still pass through the
  product permission hook before the SDK bypass shortcut.
- No commit, push, merge, or publication performed. The only base and future
  merge target remain `github-opensource`.

## MR publication

The user explicitly requested an MR and compliance with repository rules.
This authorizes the task-owned commit, feature-branch push, and MR creation;
it does not authorize merging. The target is `github-opensource` only.

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| Resolve validation warnings | Use pinned pnpm/npm tools in an isolated temporary prefix; remove redundant shared-config runtime import | No suppressed diagnostics; dependency and lockfile unchanged | Restore only new config hunk and discard task-local tooling if unsuitable |
| Validate publication candidate | `npm run check`, `./test.sh`, focused tests, diff review | Required checks pass with full check output; failures investigated rather than hidden | Do not commit a failing candidate |
| Verify access and target | GitLab user/project metadata, remote refs, existing MR lookup | Correct project, permission, and github-opensource target | Stop remote writes if identity or target cannot be verified |
| Commit owned files and publish | Explicit `git add` paths, normal commit hooks, push feature branch, `glab mr create` with description file | Only this change is published; Chinese MR sections, truthful checks, AI attribution | Keep commit recoverable; do not force-push or merge |
| Read back MR | GitLab API or `glab mr view` | Source/target, title, description, URL verified | Correct MR metadata within the authorized request |

### Publication preparation status

- Installed task-local npm 10.9.3 and pnpm 9.15.9 with lifecycle scripts disabled
  under `/tmp/step-rm-mr-tools`. No repository dependency or lockfile changes.
- Removed the redundant `defineConfig` runtime import from `vitest.base.ts`;
  the shared object and aliases are unchanged. Full `npm run check` now exits
  zero without warnings. The five focused suites also pass 239 tests without
  the previous Vitest import warning.
- Ran the required `./test.sh` with its credential-free environment. It failed:
  coding-agent reports six failing tests and one failed suite because child
  processes/package subpaths require absent `dist` outputs in this fresh
  worktree. Do not report this run as passing. Log:
  `/tmp/step-rm-mr-offline-tests.log` (local only).
- Requested explicit authorization for `npm run build:offline` because AGENTS.md
  prohibits unrequested builds. Pending authorization; no build executed.
- Git fetch succeeded on retry. `origin/github-opensource` is
  `d57a7ca0b246e74c1f1e85472df3dcba1176642f`; the task remains based on its earlier
  ancestor and changes are still isolated. Upstream touches another region of
  `step-extension.test.ts`; no branch switch, merge, or rebase performed.
- GitLab HTTPS API repeatedly times out connecting to `30.100.0.1:443`.
  Requested confirmation/restoration of company-network connectivity. SSH has
  worked intermittently, but API identity, permission and MR lookup are not yet
  verified.
- Prepared the Chinese description in `/tmp/step-rm-mr-description.md` with
  required sections, truthful pending full-test status, boundaries and AI
  attribution. Update the full-test result and plan path before submission.
- No commit, push or MR creation yet. Full-test completion and API connectivity
  remain publication blockers; no checks or contributor gates bypassed.

### Updated user authorization

The user explicitly authorized the build, then requested a committed and pushed
feature branch plus GitLab's MR-creation link. Actual API-based MR creation is
no longer required. Finish the offline build and validation, commit only owned
files using normal hooks, push `codex/rm-rf-mandatory-approval`, and return the
creation URL with `github-opensource` preselected as target. Do not merge.

### Build and final validation

- User-authorized `npm run build:offline` completed successfully, including model
  data validation, workspace compilation, asset copies, and the Step bundle
  (15 files, 5.9 MiB). Generated output is ignored and not part of the commit.
- The first full run after building passed the earlier missing-artifact tests.
  It had one timeout in the existing reftable watcher test:
  `footer-data-provider.test.ts` / updates the cached branch when the reftable
  directory changes. That file then passed all eight tests in isolation with
  no source, assertion, timeout or runner changes. A further full isolated run
  is recorded below when complete; the earlier failed run remains recorded.
- SSH verified the remote target remains `d57a7ca` and the source branch does not
  yet exist. GitLab API access is unnecessary for the user's requested push link.
- The final unchanged-source `./test.sh` run exited zero. coding-agent passed
  267 files / 2,981 tests (existing 7 files / 66 tests skipped); CLI passed
  74 files / 566 tests. All other workspace runners and script tests completed
  successfully. The previously timing-out watcher test also passed in this run.
  No tests were skipped, weakened or given larger timeouts to obtain the pass.
- Final validation uses npm 10.9.3 and pnpm 9.15.9 from the task-local toolchain.
  `npm run check` and the 239 focused tests passed without the earlier toolchain
  or shared-config warnings. Package metadata and lockfile remain unchanged.
- Source and docs are verified and this execution record is archived before the
  task-owned commit. The commit runs the repository's existing `.husky/pre-commit`
  via a command-local hooks path, without changing shared repository config or
  bypassing checks. Push completion and the returned creation URL are reported
  in the task response; no API-based MR creation or merge is requested.
