# Subagent → workflow nesting guard + rpc turn watchdog

## Background

A `subagent parallel (4 tasks)` run blocked its parent for 78 minutes and burned
~2.9M tokens while the footer reported 17k.

Observed tree (PIDs from the live incident):

```
83540 main                       CPU 15:14  ← blocked in the subagent tool
├ 87207 lane subagent-0bc4402c   CPU 0:18   ← blocked in the workflow tool
│ └ 39757 wf_ab3e05af3db544da-11            ← workflow agent, leaf
└ 87208 lane subagent-a86f785a   CPU 0:21   ← blocked in the workflow tool
  └ 39566 wf_7025a79cd671426b-1             ← workflow agent, leaf
```

`wf_ab3e05af3db544da` fanned out 8 agents at once; 7 died inside 50s with
`429: concurrency reached, current: 6, limit: 5`, then were re-run serially at
8–25 minutes each.

Two independent defects produced this.

**1. `subagent → workflow` is not gated.** `rpc-adapter.ts` sets the
`STEP_DISABLE_WORKFLOW` kill switch only when `input.workflowAcl` is present:

```ts
[CHILD_MARKER]: "1",                                           // unconditional
...(input.workflowAcl ? { STEP_DISABLE_WORKFLOW: "1" } : {}),  // conditional
```

`workflowAcl` is a permission payload (baseCwd / readOnly / writable), not a
depth marker. The `subagent` tool's runner never passes one, so its children are
misread as top-level, inherit the parent's enabled workflow env, register the
`workflow` tool, and fan out again. `subagent → subagent` is correctly blocked
(`CHILD_MARKER`, checked at `step-subagent.ts:446`) and `workflow → workflow` is
correctly blocked; only the cross-tool path is open — and workflow is the larger
multiplier. 4 lanes × 8 agents = up to 32 concurrent streams against a limit of 5.

**2. No turn-level timeout anywhere.** `createSubagentRpcSession().runTurn()`
settles only on `agent_settled`, a failed prompt ack, child `close`, or child
`error`. The three existing timers (`CHILD_EXIT_SIGTERM_MS`,
`CHILD_EXIT_SIGKILL_MS`, `ABORT_SETTLE_GRACE_MS`) all start only *after*
`closeStdin()`/abort. A child that stays alive and never emits `agent_settled`
strands its parent forever. `executeSubagent` then waits on `Promise.all`, so one
stranded lane blocks the whole tool.

Fix 1 stops the bleeding; fix 2 is the backstop.

## Steps

### Step 1 — extract a testable child-env seam and close the nesting hole

- **Tool:** edit `packages/coding-agent/src/features/subagent/rpc-adapter.ts`.
  Add exported `buildSubagentChildEnv(input)`; set `STEP_DISABLE_WORKFLOW: "1"`
  unconditionally alongside `CHILD_MARKER`; keep the existing ACL ternary
  (its `undefined` branch correctly clears an inherited value — Node's `spawn`
  skips `undefined` env values).
- **Expectation:** `spawn` receives `STEP_DISABLE_WORKFLOW === "1"` for every
  child regardless of `workflowAcl`. `workflow → workflow` behavior is unchanged.
- **Rollback:** restore the conditional spread; single-hunk revert.

### Step 2 — regression test for the env contract

- **Tool:** new `packages/coding-agent/test/subagent-child-env.test.ts`
  asserting both branches (with and without `workflowAcl`), plus that
  `WORKFLOW_ACL_ENV` is cleared when no ACL is passed.
- **Expectation:** test fails against the pre-fix code, passes after.
- **Rollback:** delete the file.

### Step 3 — rpc turn inactivity watchdog

- **Tool:** edit `rpc-adapter.ts`. Track last child stdout/stderr activity per
  turn; if nothing arrives for `SUBAGENT_TURN_IDLE_TIMEOUT_MS`, abort the turn
  and settle it as failed with a diagnostic message.
- Reset the timer on every stdout chunk. The child forwards `message_update`
  deltas over rpc, so a live generation continuously resets it; only genuine
  silence trips it.
- Default generous (30 min) because a long `run_command` is silent while it runs
  and the bash tool's own timeout is agent-supplied and effectively unbounded.
  Override via `STEP_SUBAGENT_TURN_IDLE_TIMEOUT_MS`; `0` disables.
- **Expectation:** a child that goes silent settles as `failed` instead of
  hanging; `executeSubagent` returns and the parent turn completes.
- **Rollback:** remove the timer wiring; the other settle paths are untouched.

### Step 4 — watchdog test

- **Tool:** extend the new test file with a fake child that acks the prompt then
  goes silent.
- **Expectation:** `runTurn` rejects/settles within the injected timeout.
- **Rollback:** delete the test.

### Step 5 — verify

- **Tool:** `pnpm exec vitest --run test/subagent-child-env.test.ts` and the
  existing workflow/subagent suites from `packages/coding-agent`; then
  `npm run check` at the repo root.
- **Expectation:** all green, no new check findings.
- **Rollback:** n/a.

## Out of scope

- Footer token roll-up for child processes (`footer.ts:276` counts only the main
  session's own entries). Real defect, separate change.
- A process-tree-wide concurrency semaphore matched to the provider limit.
- Deeper retry budgets for `rate_limited` (currently 3 × 2/4/8s, hopeless against
  a concurrency limit that clears in minutes).

No destructive or irreversible operations; no confirmation gate required.

## Follow-up: built-in agent selection guidance

The same incident showed a second, softer problem. All four review lanes were
dispatched to `general`, whose `tools: undefined` means no tool filter, so four
prompts that said "Do NOT edit files — review only" ran with write access for
several minutes. The built-in `review` agent already has a read-only whitelist
and would have been the right pick.

The cause was missing information rather than ignored guidance: at the point of
choosing an agent the caller saw only `Built-in agent names are exactly
"general", "explore", "review", and "planner"` — four bare names, no access
levels. Per-agent descriptions existed but were reachable only through
`formatStepAgentCatalog`, which runs on the unknown-agent error path.

Changes:

- Rewrote the four built-in `description` fields to lead with access level.
- Added `formatBuiltinAgentGuidance()`, derived from `BUILTIN_AGENTS`, and used
  it for the tool description line. Deriving removes the drift risk between the
  hardcoded name list and the array, and puts capability information where the
  choice is made. The "names are exact, the parenthetical is not a name" warning
  is preserved — `BUILTIN_AGENT_ALIASES` exists because models pass descriptive
  forms as names.
- Switched `formatStepAgentCatalog` to a `" | "` joiner; the new descriptions
  contain semicolons, which made the old `"; "` joiner ambiguous.

This is model guidance, not enforcement. The hard guarantee against re-fan-out
remains the unconditional `STEP_DISABLE_WORKFLOW` in `buildSubagentChildEnv`.

Not done (offered, declined for now): a leaf-agent notice appended to every
child's system prompt via `--append-system-prompt`, which would reach the actual
decision-maker — the lane that reasoned "I'll spawn agents for: 1...8" made that
call inside the child, where the `subagent` tool description is never shown.
