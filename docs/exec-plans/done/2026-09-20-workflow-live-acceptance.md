# Workflow live terminal acceptance

## Scope

The user explicitly requested actual testing after the automated-only validation
of MR !96. Run the current source CLI in a real terminal, use the native
`isolated-vm` backend and production RPC subagent runner with an existing configured
model, and capture live task counts, task labels, state transitions, and final
completion. Keep the fixture and all runtime artifacts in a task-owned temporary
directory. The authorized live smoke includes the required native dependency
setup and bounded real model requests. Preserve existing user sessions and
credentials. Continue using the same MR; do not merge it.

## Execution

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| Inspect runtime, native loading, and configured model | File reads, safe environment/config metadata inspection | Identify the exact CLI entry, native dependency failure, and usable existing credential source without exposing secrets | Read-only |
| Prepare native dependency and isolated fixture | Existing package's build tooling with Node 22.19.0; task-owned directories | Native module loads and the workflow registration gate enables the production runtime | Remove only task-owned build artifacts; preserve installed dependency source and user configuration |
| Run native workflow regressions | Explicit package-local test files with native backend enabled | Previously skipped native VM cases execute and pass | No product mutation |
| Run the real CLI and model-backed workflow | Unique tmux terminal, three small fixture tasks, maxConcurrency 2, bounded timeout and token budget | Observe live running/queued task rows, transitions before completion, successful real child results, and final completed state | Stop only this run's process group and remove only task-owned fixture resources |
| Inspect failures and repeat only the affected check | Logs, native journal, captured terminal, bounded edits if needed | Any runtime defect is reproduced, fixed, and verified | Revert only newly authored changes |
| Record evidence and update MR !96 | Execution record, artifact hashes, existing MR description | Clearly state exact command, model, native runtime, observations, limits, and CI state | No merge or release |

## Progress

- [x] Confirmed production runner uses independent RPC subagent processes.
- [x] Native runtime available and native regression tests executed.
- [x] Real CLI run with live task transitions and successful final output captured.
- [x] Evidence recorded for MR !96 verification update.

## Acceptance result — 2026-09-20

Passed on source commit `ceeb6d9db8c6a4e0b011b33ed9ce1de5a4d1d127`.
The actual terminal run used Node 22.19.0, native `isolated-vm@6.0.1`, and the
configured `stepcode-anthropic/claude-opus-5` model through the production RPC
subagent runner. No VM or agent runner was injected.

- Run: `wf_42138e2887c34336`; workflow elapsed time: **21.680 seconds**.
- Three independent RPC child processes, with at most two running at once.
  Each child made two model requests and one successful `read_file` call.
  The parent made two model requests and invoked `workflow` exactly once.
- Captured actual terminal transitions:
  `2 running / 1 queued / 0 of 3 completed` →
  `2 running / 0 queued / 1 of 3 completed` →
  `1 running / 0 queued / 2 of 3 completed` →
  `0 running / 0 queued / 3 of 3 completed`.
  Every state displayed Numbers, Settings, Words, and their assigned file tasks.
- Final status `completed`, `ok: true`, three calls, no workflow cache hits,
  and no schema retries. Results were `{sum: 140}`,
  `{enabled: true, regionCount: 2, retries: 3}`, and `{redCount: 3}`.
  `Ctrl+O` expanded task descriptions and the final JSON result.
- All three fixture files retained their original contents. The task-owned
  terminal and its child processes were closed after capture.
- Native regression command, executed from `packages/coding-agent` with
  `NODE_OPTIONS=--no-node-snapshot` and Node 22.19.0 on `PATH`:
  `pnpm exec vitest --run test/workflow-vm.test.ts test/workflow-runtime.test.ts test/workflow-registration.test.ts`.
  **35 passed, zero skipped**, including previously unavailable native VM cases.
- Existing CI pipeline `876427` on the tested source commit passed.

## Reproduction and evidence

Artifacts are under
`/data/tmp/step-harness-workflow-live-20260920.dkjaz7/`:

- `fixture/live-check.js` and the three input fixtures.
- `launch.py`, `source-loader.mjs`, and `prompt.txt`: exact current-source
  launch and parent request. The launcher reads the existing managed credential
  into the child environment; neither the test config nor the evidence contains
  a copied credential.
- `terminal.raw.ansi`, `frames/`, `terminal-history.txt`, and
  `terminal-{running,one-completed,two-completed,completed,expanded}.png`.
  The PNGs render actual `tmux capture-pane` frames; they are not mock UI fixtures.
- `progress-timeline.jsonl`, `process-timeline.json`,
  `fixture/.step-cli/workflows/runs/wf_42138e2887c34336/`, and the four transcripts
  under `state/sessions/`.
- `acceptance-summary.json` and `SHA256SUMS`: machine-checked results, frame
  references, process witnesses, usage, and evidence hashes.

The prompt requested `workflow` with `scriptPath: "live-check.js"`,
`maxConcurrency: 2`, `budget: 60000`, and `agentTimeoutMs: 120000`.
The model output limit was 2048 tokens per response. The fixture script used
three labeled `agent()` calls in `parallel()`, with a `read_file`-only tool
profile and a single schema attempt, then validated the three returned values.

A source-only checkout needs the TypeScript resolver in **both** parent and
RPC children: the child invocation reuses the entry script, while its Node
process does not inherit the parent's `process.execArgv`. The test launcher
therefore supplies a narrowly scoped source resolver through `NODE_OPTIONS`.
It changes module resolution only; VM execution, subagent transport, model
requests, event handling, and terminal rendering use production code.
On Node 22, keep `--no-node-snapshot` when loading the native VM. All settings,
sessions, workflow files, and terminal resources must use a task-owned directory.

The workflow reports 211 budget tokens under its current input-plus-output
accounting. Provider transcripts also report prompt-cache usage: all eight
model responses total 51,601 tokens including cache reads/writes. The 211 value
must not be described as the entire model workload or billing total.

This run verifies the current-source interactive CLI with a small real workflow.
It does not cover a packaged binary, large fan-out, or live provider failure and
cancellation scenarios. No product code changes were needed after this test.
