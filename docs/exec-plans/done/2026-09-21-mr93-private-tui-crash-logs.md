# MR !93: private default TUI crash logs

Base: `4c448e0b8c1af231621adae6c259b65360fe1b5c`, verified against the remote source
branch and `refs/merge-requests/93/head`. Work is isolated on
`codex/fix-mr93-tui-crash-logs`.

Scope: close the shared temporary directory preoccupation/symlink write in default
TUI crash logging, preserve explicit `logDirectory`, and correct the two requested
coding-agent comments. Keep the MR's environment contract and identity behavior.

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| Reproduce | Add a node:test regression through `TuiMainScreen.renderNow()` using only a test-owned temporary root | The unchanged renderer overwrites the test marker through a preplaced shared-path symlink and fails the assertion | Remove only this task's new test |
| Repair | Allocate a private random default directory with `mkdtempSync`; update the two comments and TUI documentation | Default crash logs cannot reuse the shared path; explicit directories still work; normal rendering requires no log directory | Revert only this task's source/doc edits |
| Verify | Focused TUI tests, CLI integration tests, render-equivalence gate, `npm run check`, `./test.sh`, `git diff --check`; independent read-only patch review | Regression passes, explicit-directory crash logs still exist, offline checks pass with actual results recorded | Revise this task's patch without touching other worktrees |

The initial implementation was left uncommitted. The user subsequently authorized
a local commit after a fresh independent review. Push, MR comments, merge, and
deployment remain outside this task.

## Results

- Dependencies installed with `pnpm install --frozen-lockfile --ignore-scripts`;
  no manifest or lockfile changes.
- Red phase: `node --test test/tui-crash-log.test.ts` from `packages/tui`
  failed 3 tests and passed 2 against unchanged source. Both shared-path symlink
  variants overwrote the marker with the rendered crash report; two default
  instances reused the same log directory.
- Green phase: the same 5 tests pass. The default directory is allocated lazily
  in `TuiBase` with `mkdtempSync`, so ordinary rendering creates no directories.
  Explicit paths still use the existing write path; crash logs survive `stop()`.
- Related TUI checks: `node --test test/tui-crash-log.test.ts test/tui-render.test.ts
  test/tui-alt-screen.test.ts test/terminal.test.ts test/terminal-image.test.ts
  test/container-render-cache.test.ts` from `packages/tui`: 170 passed.
- CLI integration: `pnpm exec vitest --run test/interactive-mode-startup-input.test.ts
  test/interactive-mode-startup-login.test.ts test/interactive-mode-step-login.test.ts
  test/interactive-tui.test.ts test/tui-acceptance-snapshot.test.ts
  test/tui-acceptance-interactions.test.ts test/first-time-setup.test.ts` from
  `apps/cli`: 7 files, 71 tests passed.
- `node --test scripts/render-equivalence.test.mjs`: passed, 82 frames and
  337709 bytes identical between cached and uncached rendering in this worktree.
  The fixture emits `file://` hyperlinks resolved from `process.cwd()`, so byte
  totals vary with the worktree path; the gate compares all three runs in the
  same worktree rather than asserting a historical byte count.
- Independent read-only candidate review found no concrete bypass or regression.
  Its focused crash-log and rendering checks passed 32 tests.
- `npm run check`: initial lint/type errors in the new code/test were corrected;
  final rerun passed. The test uses `afterEach` to match the locked Node types;
  its 5 cases were rerun and passed after that correction.
- First `./test.sh` run stopped in coding-agent: one suite could not resolve
  `@step-harness/agent-core/node`, the theme watcher subprocess could not load
  `pi-tui/dist/index.js`, feedback redaction hit its 30-second timeout, and the
  startup-name subprocess hit its 10-second limit. The coding-agent result was
  2832 passed, 3 failed, 66 skipped, plus the module-resolution suite failure.
- Materialized local test prerequisites without lifecycle scripts or network:
  `./node_modules/.bin/tsgo -p packages/tui/tsconfig.build.json`, then the same
  compiler command for `packages/telemetry`, `packages/providers`, and
  `packages/agent-core`. These outputs are ignored `dist/` artifacts only.
- `pnpm exec vitest --run test/server/create-harness.test.ts
  test/suite/regressions/2791-fswatch-error-crash.test.ts` from coding-agent then
  passed both files, 12 tests.
- Credential-free isolated reruns of `pnpm exec vitest --run test/feedback.test.ts`
  and `pnpm exec vitest --run test/startup-session-name.test.ts` passed 70 and 1
  tests respectively, without timeout or source changes. The original failures
  did not reproduce; feedback completes in 25.12 seconds and startup in 5.76
  seconds. These paths do not construct a default TUI.
- Second `./test.sh` run resolved the missing-module and feedback failures;
  coding-agent finished with 2845 passed, 66 skipped, and only the same
  10-second startup subprocess timeout. No test source or timeout was changed.
- Final full run uses `PATH="$PWD/.artifacts/test-worker-cap:$PATH" ./test.sh`.
  The ignored local `node` wrapper delegates to the same Node executable and
  adds only `--maxWorkers=2` when launching Vitest. The repository runner still
  clears credentials and uses an isolated HOME/TMP; all tests and assertions
  are unchanged. Passed, exit 0. Coding-agent: 264 files / 2846 tests passed,
  7 files / 66 tests skipped. CLI: 74 files / 562 tests passed. Evals: 4 files /
  23 tests passed. All earlier packages and script gates also completed
  successfully. Existing credential/platform skips remain in place; no real
  model API was called. Full output: `.artifacts/mr93-offline-tests-workers2.log`.
- `git diff --check`: passed. Scope is the default log-directory implementation,
  its new regression test, the two requested comments, TUI documentation, and
  this execution record. No dependency, environment contract, or MR !95 edits.
- Verification environment: macOS, Node v26.7.0. The symlink and POSIX permission
  assertions ran without skips. No push or GitLab comment was created.
- Follow-up independent review before the authorized commit: Standards found
  no documented-standard violations; Spec/security found no actionable missing
  requirements, bypasses, or regressions. The independent reviewer reran
  `node --test test/tui-crash-log.test.ts`: 5 passed, no skips. The implementation
  and test files are unchanged from the fully verified version above.
