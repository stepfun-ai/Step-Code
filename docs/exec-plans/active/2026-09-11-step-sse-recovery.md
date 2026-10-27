# Reduce repeated SSE failures during large Step tool calls

## Problem and scope

The owner reports that the inference service buffers large tool arguments for
JSON repair and that ALB/WAF can close the response during the resulting idle
period. Step then reports `Anthropic stream ended before message_stop`.
Implement client-side mitigation without depending on a serving change.

The existing retry loop removes the failed assistant message and resends the
original context. Add Step-only guidance to generate large files incrementally,
plus a request-context recovery note after a recognized incomplete stream. Use
the existing extension context hook and session history; Pi retains retry
budgets, cancellation, tool execution, and incomplete-response rejection.
Prompt guidance cannot guarantee model compliance or keep an upstream response
alive. Do not change timeout defaults, truncate tool arguments, or fabricate a
successful terminal event.

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| Isolate this patch from MR !56 | Create `fix/step-sse-recovery` worktree from verified v0.3.4 and move this plan there | Original checkout and MR branch remain clean | Leave unrelated worktrees untouched; remove only task-owned changes if needed |
| Add Step prompt and recovery projection | Edit Step system prompt and register a small context extension | Retry sees one focused recovery instruction; no duplicate loop or durable synthetic user input | Remove only the new hook and prompt guidance |
| Verify retry behavior offline | Package-local Vitest with suite harness/faux provider | Recovery context changes; incomplete calls never execute; retry limits and later turns remain correct | Correct the implementation without weakening assertions |
| Document and check | Update Step integration contract; run `npm run check` and focused existing tests | Reviewable scoped diff and explicit validation outcomes | Revert only task-owned edits; report any baseline check failures |

## Acceptance

- Large-file guidance applies to Step write/execute sessions.
- A recognized missing-terminal-event failure adds bounded guidance to the
  next retry context, even when no tool delta reached the client.
- Failed tool arguments remain non-executable and absent from retry input.
- Successful turns, new user prompts, session changes, unrelated errors, and
  disabled/exhausted retries do not acquire stale recovery messages.
- No live model calls, commits, pushes, deployment, or MR publication in this
  implementation pass.

## Implementation and validation

- Worktree: `/data/ai_code_base/step-harness-sse-recovery`, branch
  `fix/step-sse-recovery`, base `fe153835` (v0.3.4). The original MR !56
  checkout remains clean.
- Step's default prompt recommends incremental file generation with roughly
  100 lines or a few kilobytes of generated arguments per response. These
  are soft planning targets, not limits or truncation rules.
- `registerStepStreamRecovery` projects a hidden note after a retryable
  `stream ended before/without` error. It derives eligibility from the latest
  message on the active session branch and asks for one smaller call (roughly
  50 lines or a few kilobytes). No second retry loop, timeout setting, API
  parser change, or persisted synthetic user message was introduced.
- New suite: 8 tests passed after the final source change. It exercises the
  actual Step extension registration, failed-call non-execution, preservation
  of prior successful work, removal of failed arguments from retry input,
  completely buffered input, note lifetime, bounded/disabled retries,
  unrelated errors, and cancellation.
- Existing retry/event suite: 14 passed. Existing Step extension and system
  prompt suites: 29 passed. Anthropic SSE parser suite: 6 passed.
- Full `npm run check` passed in the isolated worktree: Biome, pinned
  dependencies, relative imports, shrinkwrap, install lock, TypeScript, and
  browser smoke. Final `git diff --check` passed.
- `./test.sh` completed the repository suites but failed 12 pre-existing
  `packages/session-backends/sqlite-node` FTS5 tests with
  `Error: no such module: fts5`; 75 tests in that package passed and the
  failure is in the native test environment, outside this patch. The focused
  coding-agent and Anthropic suites above remain green.
- Initial tests could not load ignored provider catalog JSON in the new
  worktree. Reused installed dependencies and copied the existing offline
  provider data from the v0.3.4 checkout; no network/model calls were needed.
  An initial `findLast` use failed the repository's target library check and
  was replaced with supported array operations before final validation.
- Not measured: live endpoint failure rate, model compliance with the prompt,
  or native Windows/WSL reproduction. The tests establish client behavior,
  not elimination of upstream timeouts.
