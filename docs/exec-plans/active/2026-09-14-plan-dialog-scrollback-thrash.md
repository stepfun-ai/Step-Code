---
title: Stop scrollback thrash when a tall dialog pushes the status row off-screen
status: active
---

## Problem

In regular (main-screen) TUI mode the plan-review dialog (`exit_plan_mode` ->
`ui.select`) is mounted inline into `editorContainer` and carries up to 2000
characters of plan preview, so it is typically 40+ rows tall. Once the dialog
plus the rows under it reach the terminal height, every document row above it —
the working status row and the running tool row — sits above the visible
viewport.

`TuiMainScreen.doRender()` answers a change above `previousViewportTop` with
`fullRender(true)`, which writes `\x1b[2J\x1b[H\x1b[3J` (clear screen, home,
**clear scrollback**) and rewrites the whole document. Two 200 ms clocks keep
running while the dialog waits for the user — `WorkingStatusIndicator`'s
`Loader` and `StepToolSpinnerClock` — so the terminal's scrollback is destroyed
and rebuilt 5-10 times per second. The terminal's own scrollbar flickers, and
any user scroll position is wiped on the next frame.

Measured on a 100x40 virtual terminal (200-line transcript, 1 status row,
N-row dialog, 1 footer row), changing only the status row:

```
dialogHeight=38  fullRedraw=0  clearedScrollback=false  bytesWritten=45
dialogHeight=40  fullRedraw=1  clearedScrollback=true   bytesWritten=5984
```

`PI_DEBUG_REDRAW=1` names it: `fullRender: firstChanged < viewportTop (200 < 202)`.

A previous attempt (`2026-09-07-step-plan-tui-flicker.md`) only slowed the Step
spinner from 80 ms to 200 ms; it reduced the rate but not the mechanism.

## Step

Two changes, independent and both wanted:

1. **`packages/tui`** — a change that lies entirely above the viewport is
   invisible; only scrollback would show it. Stop paying a screen+scrollback
   wipe for it. Clamp `firstChanged` to `previousViewportTop` and repaint the
   visible rows through the existing differential path. Scrollback keeps the
   stale copy of those off-screen rows, which is the deliberate trade.
   Keep `fullRender(true)` when a kitty image block straddles the clamp point,
   since repainting from the middle of an image block corrupts it.

2. **`packages/coding-agent`** — while a modal dialog owns the editor slot the
   agent is blocked on the user, so both animation clocks are advancing a
   progress story that is not progressing. Suspend the working status indicator
   and pause `StepToolSpinnerClock` for the lifetime of the dialog; resume on
   unmount.

## Tool

- `packages/tui/src/tui-main-screen.ts`: replace the
  `firstChanged < prevViewportTop` full-redraw branch with an off-screen-only
  early return plus a clamp, guarded for kitty image blocks.
- `packages/coding-agent/src/modes/interactive/components/step-spinner.ts`: add
  `pause()` / `resume()` that stop and restart the interval without losing
  per-tool start times.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`: add a
  modal-dialog suspension depth wired into `mountExtensionDialog` (inline form)
  and `showExtensionEditor` / `hideExtensionEditor`; make
  `showWorkingStatusIndicator()` a no-op while suspended.
- Regression tests: `packages/tui/test/main-screen-offscreen-change.test.ts`
  (node:test) and `packages/coding-agent/test/step-spinner.test.ts` (vitest).
- `npm run check`.

## Expectation

- A status-row change under a 40-row dialog writes tens of bytes and emits no
  `\x1b[3J`, instead of ~6 KB and a scrollback wipe.
- Visible rows still repaint correctly when the change straddles the viewport
  top, and kitty image content is unchanged.
- With the plan dialog open the spinner and status row hold still; both resume
  when the dialog closes and the session is still streaming.
- `npm run check` clean; the new tests and the existing TUI render, spinner, and
  status tests pass.

## Rollback

Both changes are additive and isolated. Revert
`packages/tui/src/tui-main-screen.ts` to the unconditional `fullRender(true)`,
drop `pause()` / `resume()` from `StepToolSpinnerClock`, and remove the
suspension depth and its two call sites in `interactive-mode.ts`. No persisted
state, config, or protocol shape changes.

## Follow-up: show the whole plan in the review dialog

Same dialog, separate defect reported in the same session. The review truncated
the proposal three ways:

1. `readPlanPreview()` cut the file at 2000 characters and appended
   `... (truncated, full plan in file)`. The same string is what headless and rpc
   callers get, and those callers are the ones told to gate approval externally.
2. In Step presentation `splitStepDialogTitle()` dropped every blank line and
   trimmed leading indentation, so the plan rendered as a wall with no paragraph
   breaks and no list nesting.
3. `renderStepDialogFrame()` cut any row wider than the frame, so long plan lines
   lost their tails silently.

Changes:

- `plan-mode-tools.ts`: `readPlanPreview` -> `readPlanContents`, cap removed.
- `step-dialog.ts`: `splitStepDialogTitle` takes `keepBlankLines`, which keeps
  interior blank lines and indentation (leading/trailing blanks still trimmed).
  The default is unchanged, so the other Step dialogs keep their compact titles.
- `extension-selector.ts`: the Step render wraps the heading and each body line
  to the frame's content width instead of letting the frame cut them, and asks
  for `keepBlankLines`.

Cost to accept: the review dialog is now as tall as the plan (a 5.8 KB plan
renders 127 rows at width 100), and the headless/rpc tool result carries the
whole plan back into context.

Tests: `step-plan-extension.test.ts` ("the review select shows the whole plan,
however long"; the headless case now asserts the tail is present) and
`step-overlay-components.test.ts` ("shows a document-sized selector title in
full, wrapped and with its blank lines").

## Rebased onto main (2026-09-14)

Main landed `fix/tui-long-session-input-freeze` (4d8584c) in the meantime, which
already solves part 2 and solves it better:

- `StepToolSpinnerClock.setPaused(paused)` freezes the animation *and* shifts
  `runningSince`, so the approval wait is kept out of the reported tool
  duration. `WorkingStatusIndicator.setWaitingForApproval` freezes the working
  row the same way, and `InteractiveMode.setWaitingForApproval` drives both.
- So the `pause()` / `resume()` pair and `suspendWorkingAnimations()` written
  here were dropped in favor of that mechanism; `showExtensionCustom` now takes
  a `waitingForApproval` option that calls into it.

Part 1 still applies: main kept the unconditional `fullRender(true)` for
`firstChanged < prevViewportTop`. The clamp was re-applied on top of main's
incremental renderer, with the image scan gated on `kittyScanEnabled` and
`previousKittyImageIds` updated under the same gate as main's other early exits.
