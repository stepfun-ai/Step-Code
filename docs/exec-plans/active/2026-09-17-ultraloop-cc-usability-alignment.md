# Ultraloop usability alignment with Claude Code ultracode

Owner: youwang + Claude. Branch: `feat/ultraloop-cc-usability`.

## Problem

Ultraloop's surface diverges from Claude Code's ultracode in ways that hurt
day-to-day use. Concretely observed:

1. Users coming from Claude Code type the keyword `ultracode`; ultraloop does
   not recognize it, so the opt-in silently fails.
2. `pipeline()` in the VM is a serial for-loop (item N+1 starts only after
   item N finished every stage), while the tool description already promises
   Claude Code semantics ("threads each item through the stages
   independently"). Wall-clock = sum of all chains instead of the slowest
   chain. Stage callbacks also receive only `(value)`, not
   `(prev, originalItem, index)`, so later stages cannot label work.
3. `parallel()` is `Promise.all` fail-fast: one failed agent rejects the whole
   wave and loses every sibling result. Claude Code resolves failed thunks to
   `null` so scripts `.filter(Boolean)`.
4. No `+500k`-style per-turn token target; budget must be passed as an
   explicit tool parameter the model has to remember.
5. The tool result does not return the persisted script path, so the
   documented edit-and-resume loop requires knowing the run-dir layout.

## Steps

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| Rewrite VM `pipeline`/`parallel` to CC semantics (concurrent chains, `(prev, item, index)` stage args, null-on-error, 4096 caps) | edit `src/features/workflow/vm.ts` | new vm tests pass; existing values `[6, 9]` unchanged | revert file |
| Accept `ultracode` keyword alias; parse `+500k`-style budget directive into shared per-turn state | edit `src/features/workflow/ultraloop-opt-in.ts` | detect tests for both keywords + directive pass | revert file |
| Wire shared turn state between opt-in and workflow extensions | edit `src/features/step-capabilities.ts`, `step-workflow.ts` | workflow run picks up turn budget when no explicit `budget` param | revert files |
| Return persisted `scriptPath` in `WorkflowRunResult` | edit `runtime.ts`, `types.ts` | extension test asserts scriptPath under `.step-cli/workflows/runs/<id>/script.js` | revert files |
| Align tool description / promptGuidelines / system-prompt keyword list | edit `step-workflow.ts`, `src/step/system-prompt.ts` | text mentions ultracode alias, null-on-error, concurrent pipeline, `+500k` | revert files |
| Tests + changelog | edit `test/workflow-*.test.ts`, `CHANGELOG.md` | targeted vitest green; `npm run check` green | revert files |

Deferred (documented in MR only): background workflow execution with
completion notification (needs host async-task infra), live progress TUI,
output-only budget accounting parity.

No destructive or publishing side effects; all changes are code edits on a
feature branch.
