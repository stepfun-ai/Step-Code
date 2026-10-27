# Subagent live list widget (below the editor)

## Background

A foreground `subagent parallel` call currently shows nothing outside the
transcript tool row, and that row goes through the generic collapsed shell
(`subagent` is the only orchestration tool without `renderShell: "self"`), so a
4-lane run rendered as the task prompt plus one settled lane and
`… +198 lines`. During a 2-hour run the three *running* lanes were invisible.

Widgets today only exist for background lanes (`run_in_background`):
`updateLaneWidget` is called from the lane lifecycle, pinned to
`placement: "aboveEditor"`, and emits uncoloured `string[]` because
`laneWidgetLines` uses a stub theme whose `fg` is the identity function. The
blocking path never creates a lane, so it never reaches that code.

Everything else needed already exists and was verified:

- `WidgetPlacement = "aboveEditor" | "belowEditor"`.
- `setWidget(key, content, options)` accepts a component factory
  `(tui, theme) => Component`; `setExtensionWidget` instantiates it with the
  real theme. RPC ignores function content and stdio nulls it, so passing a
  factory is safe on every host (those hosts simply render no widget, which is
  not a regression — today they render nothing for this path either).
- `Component.render(width)` runs on every redraw, and the working-indicator
  already forces ~1s redraws, so elapsed computed at render time ticks without
  a timer.
- Per-record data is live: `record.startedAt`, `record.activeTool` /
  `activeToolArgs` / `activeText`, and `record.usage`, which `usageFromMessage`
  accumulates per streamed message inside `parseJsonEvent`.

`MAX_WIDGET_LINES = 10` truncates only `string[]` widgets; a component widget is
uncapped, so the component must bound its own height.

## Steps

### Step 1 — the component

- **Tool:** add `SubagentListWidget` to
  `packages/coding-agent/src/features/subagent/rendering.ts`.
- One header line (`N/M complete, K running`) plus one line per record:
  status icon, agent name, an activity title, and a right-aligned
  `<elapsed> · ↓<output tokens>` column. Title precedence: `activeTool`
  (+truncated args) > last non-empty line of `activeText` > task summary.
- Elapsed is computed inside `render(width)`; right alignment uses that width.
  Bound the body to a fixed maximum of rows and summarise the remainder.
- **Expectation:** given a details object the component renders aligned rows and
  the elapsed column advances between renders.
- **Rollback:** delete the export; nothing else references it yet.

### Step 2 — drive it from the foreground path

- **Tool:** in `packages/coding-agent/src/features/step-subagent.ts`, wrap the
  `onUpdate` handed to `executeSubagent` in the tool's `execute`. Key the widget
  by the tool call id, place it `belowEditor`, guard on `ctx.hasUI`, and clear it
  in a `finally` so an abort or throw cannot leave it pinned.
- Hold one component instance per call and have the factory return it, so an
  update mutates rather than rebuilds. Do not give it a `dispose`, or
  `setExtensionWidget`'s `removeExisting` would tear down the instance it is
  about to re-add.
- **Expectation:** a blocking `subagent parallel` run shows a live list under the
  editor for its duration and removes it on settle.
- **Rollback:** drop the wrapper; `executeSubagent` is called unchanged.

### Step 3 — tests

- **Tool:** new `packages/coding-agent/test/subagent-list-widget.test.ts`
  covering the component (title precedence, counts, elapsed advancing, token
  formatting) and the extension wiring (widget set during the run with
  `belowEditor`, cleared afterwards, not set when `hasUI` is false).
- **Expectation:** all green.
- **Rollback:** delete the file.

### Step 4 — verify

- **Tool:** the new test plus the existing subagent/workflow suites, then
  `npx tsgo --noEmit` and biome on the touched files.
- **Expectation:** no new findings.

## Out of scope

- `renderShell: "self"` for the in-transcript tool row (separate surface).
- Up/down selection and the child-transcript view (parts B1/B2 of the estimate).
- Background lanes keep their existing `aboveEditor` line widget; changing that
  placement would alter behaviour users already rely on.
- Footer roll-up of child usage.

No destructive operations; no confirmation gate required.

## Result — 2026-09-21

Landed. `SubagentListWidget` in `subagent/rendering.ts`; `withSubagentListWidget`
wraps the blocking branch of the `subagent` tool's `execute` in
`step-subagent.ts`.

Rendered sample at width 100 (identity theme):

```
 subagent 1/4 complete, 2 running, 1 failed
   + review  Audited the cron lock path and found two issues       191s · ↓84.2k
   ~ general run_command: git diff aa674e3^..HEAD -- packages/co…   65s · ↓12.1k
   ~ general Reading extensionHarness in step-schedule.test.ts      58s · ↓201.7k
   x general 429: {"message":"Rate limit reached, please try ag…          109s
```

Two defects found and fixed while building it:

- `truncateText` appends `"\n\n[output truncated]"`, which is correct for a tool
  body and fatal for a single widget row. Replaced with a local `fitLine` that
  flattens to one line and keeps the head for tool rows (the tool name matters)
  or the tail for streamed text (the newest words matter).
- A `WIDGET_MIN_TITLE_WIDTH` floor made rows wider than the viewport at 40
  columns. Removed; the title now takes only the space left, and both header and
  rows pass through `truncateToWidth` as a final clamp. A regression test asserts
  no line exceeds the width at 30/40/60/80/120 columns.

Verification: `subagent-list-widget.test.ts` (8 cases) plus the subagent and
workflow suites — 9 files, 111 tests, all passing. `tsgo --noEmit` clean on the
touched files, biome clean, `check:ts-imports` / `check:layer-direction` /
`check:ui-layer` / `check:coding-agent-entry-freeze` all pass.

### Live terminal acceptance — 2026-09-21

Verified against the built `step` (0.3.1, `step-5-preview`) in a 120x32 tmux
session, in a scratch directory so the repo's other sessions were untouched. The
prompt forced one parallel `subagent` call with three `sleep`-based tasks.

The widget rendered between the editor and the footer status line, confirming
`placement: "belowEditor"` — whose container is mounted there in both the dock
VStack and `mountInteractiveTui` (`interactive-mode.ts:1106-1130`) but which this
is the first code to use:

```
 subagent 0/3 complete, 3 running
   ~ general Run the shell command `sleep 40 && echo lane-alpha` ...          13s
   ~ general run_command: {"command":"sleep 45 && echo lane-beta",...}  13s · ↓150
   ~ general run_command: {"command":"sleep 50 && echo lane-gamma",...} 13s · ↓114
```

Observed over the run: header `0/3 complete, 3 running` -> `2/3 complete, 1
running`; icons `~ ~ ~` -> `+ ~ +`; elapsed 13s -> 65s; tokens accumulating per
lane; and the widget removed once the tool call settled.

The run found one defect that unit tests could not: a settled lane tail-truncated
its text, so a finished row read `…ou the expected output would be:` — cut
mid-word. Tail bias is right while a lane runs (the newest words are the status)
and wrong once it settles (the field then holds a conclusion, which reads from
the front). `recordActivity` now picks the bias from `record.status`, with a
regression test for both directions.

Follow-up from review: the `completed` glyph changed from `+` to `✓`, matching the
`theme.fg("success", "✓")` convention already used in `mcp-import-view.ts`,
`plan-review.ts`, and `interactive-mode.ts`. `visibleWidth("✓")` is 1, so the
column arithmetic is unchanged. `statusIcon` is shared, so the transcript tool row
picked this up too. `failed`/`aborted` still share an ASCII `x`, and `running`
still uses `~`; both were left alone.

Also replaced the root `pi-test.sh` that commit `135ae6dc` deleted with
`step-test.sh`, and repointed the AGENTS.md tmux section at it.
