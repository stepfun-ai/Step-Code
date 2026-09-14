# Update Step Harness to v0.3.4 and audit WSL issue reports

## Scope

Update `/data/ai_code_base/step-harness` to the upstream `v0.3.4` release and
audit the four issue screenshots stored in the approval UI fix checkout. The
audit must distinguish defects already fixed by the release from regressions
that still need a source change, with attention to WSL terminal and streaming
behavior.

| Step | Tool / path | Expectation | Rollback |
| --- | --- | --- | --- |
| 1 | `git fetch` and inspect refs/status | `v0.3.4` resolves to the verified upstream release; target checkout is clean before update | Stop without changing the checkout if tracked edits or divergence appear |
| 2 | Fast-forward/update target checkout to `v0.3.4` while preserving an explicit ref to the old HEAD | Target directory reports the release commit and retains no unrelated edits | Restore only the target branch/ref to the recorded old commit if the update fails |
| 3 | Read issue screenshots and inspect subagent, approval UI, and Anthropic SSE paths | Each symptom has a concrete source-level explanation and WSL-specific risk is identified | Keep the release checkout unchanged if evidence does not establish a fix |
| 4 | Run focused offline tests and checks available on the release checkout | Relevant tests pass or failures are classified as environment/baseline issues; no provider calls are made | Do not weaken tests or alter dependencies to conceal failures |
| 5 | If a remaining defect is proven, add a minimal regression and fix with changelog/docs updates | The failing symptom is reproduced and fixed with targeted validation | Revert only task-owned edits; leave unrelated worktrees untouched |

## Acceptance

- The target checkout is on upstream `v0.3.4` (`fe15383` at plan creation).
- The issue audit names the affected paths, trigger, and observed behavior for
  each screenshot.
- Validation commands and their exact outcomes are recorded in the handoff.
- No commit, push, release publication, credential change, or live provider
  request is performed unless separately requested.

## Audit findings

- The WSL/Linux bundle reproduces an invalid model-selected agent name:
  `general-purpose` is reported as unknown although the built-in role is named
  `general`. It also contains repeated `Anthropic stream ended before
  message_stop` failures. The session cwd is `/home/xyzclx`.
- The Windows bundle identifies `C:\Users\admin` as both host and cwd. Its
  main session is `0.3.4` (`fe153835`, `win32`) and its telemetry also contains
  a resumed `0.3.2` process (`81b024b9`) with the same device/session context.
  The old process is consistent with the Windows updater's child-process
  relaunch behavior and the captured `step.exe.old` files; this is an
  operational cleanup/check item, not proof that it caused the stream errors.
- The Windows main session has four model requests ending in the same missing
  `message_stop` error. They all returned HTTP 200 with `streamed: true` and
  were classified as `transport_error`; durations were 174178, 199028, 171610,
  and 176326 ms. A same-provider/model child request lasted about 358887 ms
  and ended normally, so a universal 180-second limit is not established.
  The likely fault boundary remains the StepCode/Anthropic-compatible endpoint,
  gateway, proxy, or an incomplete upstream SSE response. The client correctly
  rejects EOF after `message_start` and must not turn it into a tool call.
- The Windows main session only issued `where`/`dir` capability probes for
  PDF tools before the failures; it did not reach a confirmed Edge PDF render.

### Screenshot coverage

| Screenshot filename suffix | Symptom | Finding / status |
| --- | --- | --- |
| `660975eb-fe87-453c-ae03-7638fc125ffg.jpg` | Repeated `run_command` rows | Terminal redraw remains a hypothesis. The supplied bundles do not contain the screenshot's exact `for c in pandoc ...` command, so they cannot prove whether those rows represent redraws or repeated calls. v0.3.4 already clamps tool rows and removes embedded CR/LF in `tool-execution.ts:68`; focused row/spinner tests pass. Actual WSL/Windows terminal behavior remains unverified. |
| `c848fc84-0fc4-48d1-bf6b-d0f14371bfcg.jpg` | `background_done` / `completed` carrying `Invalid parameters` | Background mode validation previously ran after creating a lane. The local patch rejects missing/conflicting modes before lane creation. |
| `82d645c0-fe63-46af-9d6c-3e3659f8dbfg.jpg` | `Unknown agent: general-purpose` | Descriptive role spelling did not match the canonical catalog name. The local resolver handles this spelling with exact custom names taking priority. |
| `c000f72f-93b7-4172-b6b7-d7b02fc8283g.jpg` | Missing `message_stop` and exhausted retries | Confirmed in both bundles. No evidence ties the transport/protocol failure to the approval UI. |

### Review of the supplied Anthropic analysis

The supplied `issue/分析-Anthropic-stream-ended-before-message_stop.md`
correctly identifies an incomplete response and the retry classification.
Its attribution to a universal ~180-second upstream timeout is stronger than
the evidence supports:

- The second request lasted 199028 ms, not ~175 seconds; the same Windows
  bundle includes a normal 358887 ms response in child
  `subagent-3ae040b1-db5d-4381-813c-54602f2c1932` (27341 output tokens).
- The first bundle has the same error at approximately 135151 and 123515 ms,
  followed by a user-aborted retry. Its internal session ID is
  `5a05fff8-707b-4485-b682-9c1d41d9de39`, different from the archive filename.
- Timeout must be traced through the product caller, not only the adapter.
  `core/sdk.ts` passes an effective timeout from `retry.provider.timeoutMs` or
  `httpIdleTimeoutMs`; the latter defaults to 300000 ms. The same idle setting
  configures Undici's header/body timeouts in `core/http-dispatcher.ts`.
  The standalone Anthropic SDK default is 600000 ms only when no caller
  override is supplied. Its fetch timer is cleared when fetch returns the
  Response. The bundle lacks the effective timeout configuration and does not
  establish a 180-second client timeout.
- `usage.output = 0` is consistent with not receiving a final nonzero usage
  update. Usage is read from `message_start` and `message_delta`; `message_stop`
  itself is not a usage payload. The saved messages cannot recover raw SSE
  framing, inter-chunk idle gaps, or the component that closed the connection.
- Old-version metrics are consistent with the Windows update parent waiting
  for its new child. The failed model requests all carry v0.3.4 context.

For upstream correlation, the four failed Windows response IDs are:

| Completion time (UTC, 2026-09-11) | Duration ms | Response ID |
| --- | ---: | --- |
| 05:38:56.465 | 174178 | `chatcmpl-1a337393256354d0548e24e2100529eb-91e88473` |
| 05:42:17.563 | 199028 | `chatcmpl-3bc1ddfd858ab2912d3cf24d9cf06374-a3c3d96d` |
| 05:45:13.258 | 171610 | `chatcmpl-7f32c1f8869d89f88644ad696f1e0c04-be4b0a2d` |
| 05:48:17.718 | 176326 | `chatcmpl-f117f06f7d32fe46014a2174b370ebed-90a6b7fe` |

Compare those with the successful child response
`chatcmpl-c621ac5cfb5f3efad45ed415b078639e-8ac68597`, completed at
05:34:00.351 UTC. Investigate end-event emission/translation and per-route
idle/max-duration limits before changing retry counts. A captured raw SSE tail
and frame timing would distinguish a missing terminal event from an idle
timeout. For redraw investigation, the existing `PI_TUI_WRITE_LOG` switch can
capture the actual terminal output of a bounded reproduction.

### Practical recovery and root-fix decision

For the failing report task, use `/thinking low` in the existing session, then
ask it to reuse existing research/files, write one report section per tool call,
and run PDF conversion only after the sections are complete. This is a
workaround to reduce long responses; it has not been verified against the
user's live endpoint. Repeated retries of the unchanged long request already
failed here, so increasing retry counts is not the first change to make.

The permanent fix depends on the failing request's raw stream:

| Raw evidence | Correct change |
| --- | --- |
| Model/compatibility upstream ends before completing content or tool arguments | Correct the producer failure/cancellation or the route's idle/deadline handling. Where idle timeout is confirmed, forward SSE ping/heartbeat promptly and ensure proxy buffering does not hide it. A heartbeat cannot extend a hard maximum request duration. |
| Upstream completes normally with closed content blocks, final stop reason and usage, but compatibility output omits the final event | Fix the compatibility stream's normal-success path to emit `message_stop` before closing; never add a success event in a generic EOF/error cleanup. |
| A valid final event reaches the client body but the parser fails to recognize it | Save the framing/chunk boundary as a regression fixture and fix the client decoder. |

Acceptance requires the same report request to finish, its tool arguments to be
complete, the PDF to be produced, and deliberately truncated streams to remain
failures. The current session bundle alone cannot select one of those fixes.

## Source changes made for the confirmed defects

- `step-subagent-agents.ts` exports exact-first resolution and accepts the
  descriptive spellings `general-purpose`, `general purpose`, and
  `general_purpose` for built-in `general`.
- `subagent/execute.ts` and `workflow/agent-runner.ts` use that resolver. The
  project-agent trust prompt resolves aliases before checking the project role.
- `step-subagent.ts` documents the canonical built-in names and returns
  malformed background parameters on the originating call without creating a
  detached notification lane.
- `step-subagent-events.test.ts` covers alias resolution, exact custom-name
  precedence, project trust for single/parallel alias calls, and malformed
  background calls. `step-integration.md` documents the contract.

## Validation

- `tsgo --noEmit`: passed.
- Targeted Biome check for all five changed source/test files: passed.
- Coding-agent focused UI/subagent/permission tests: 9 files, 153 tests passed
  before the final additions; the final subagent file passed 15 tests.
- `step-subagent-events.test.ts`: 15 tests passed after the final additions.
- Anthropic SSE parsing tests: 6 tests passed.
- Workflow/update/subagent tests: 5 files, 49 passed, 2 skipped.
- `check:pinned-deps`, `check:shrinkwrap`, `check:install-lock:coding-agent`,
  browser smoke, and package-scoped relative-import checks passed.
- The repository-wide `npm run check` remains blocked by pre-existing
  `.claude/worktrees/*/biome.json` nested-root configuration errors. The broad
  relative-import scan likewise traverses those worktrees and was stopped;
  package-scoped checks passed.
