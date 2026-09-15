---
title: Plan review dialog — inline feedback, no Stay, no frame
status: active
---

## Problem

Three complaints about the plan review dialog, all in the same surface:

1. `Stay in plan mode` gives the model nothing. The user either approves or has
   something to say; a choice that returns "keep going, no comment" only burns a
   turn. Escape already covers "not now".
2. `Refine the plan` needs Enter, then opens a separate multi-line editor
   (`ctx.ui.editor`). Two steps and a second dialog for one line of feedback.
   The wanted behavior: moving the cursor onto that row makes the row itself an
   input, typing goes straight in, Enter sends.
3. The dialog is wrapped in the Step rounded purple frame and the footer status
   row (`Bypass · model · cwd · Planning (user)` + token counts) stays visible
   under it, which reads as if the session were still accepting input.

## Decisions taken with the user

- Cursor-on-row is the input; no extra Enter.
- Visual change is scoped to the plan review only. Trust prompts, permission
  confirms, and the login dialog keep the rounded frame.
- The hint row stays but follows the mode: `enter select` on the approve row,
  `enter send` on the feedback row.

## Step

The generic `ctx.ui.select` contract cannot express "one option is an input", so
the plan review becomes its own component behind `ctx.ui.custom`, the way
`step/feedback/consent.ts` and `step-questionnaire.ts` already do it. The
generic selector is left alone, which is what keeps the blast radius at the plan
dialog.

Layout:

```
● Plan ready for review (<path>):
<the whole plan, wrapped, blank lines kept>

──────────────────────────────────────────   <- borderAccent divider
  Execute the plan
▸ Tell Step what to change: <typed text>▌

 ↑↓ navigate  enter send  esc cancel
```

## Tool

1. `packages/tui/src/components/input.ts` — `Input` takes an optional `prompt`
   (default `"> "`), so the feedback row can label itself instead of showing the
   shell caret. Width math moves to `visibleWidth(prompt)`.
2. `packages/coding-agent/src/modes/interactive/components/plan-review.ts` (new)
   — `PlanReviewComponent implements Component, Focusable`, theme and
   keybindings injected (no global `theme` import, matching `consent.ts`).
   Returns `{action:"execute"} | {action:"feedback", text} | {action:"dismissed"}`.
   Enter on an empty feedback row does nothing rather than silently staying.
3. `packages/coding-agent/src/core/extensions/types.ts` — `hideFooter?: boolean`
   on the `custom()` options.
4. `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — honor
   `hideFooter` in the inline `showExtensionCustom` path (clear
   `footerContainer`, restore on close), and give that path the same
   modal-dialog animation hold `mountExtensionDialog` already takes.
5. `packages/coding-agent/src/extensions/plan-mode-tools.ts` — swap
   `ctx.ui.select` for `ctx.ui.custom(... PlanReviewComponent ...)`; delete
   `requestPlanRefinement`'s editor round-trip and send the typed line as the
   follow-up user message; `dismissed` keeps plan mode.
6. `packages/coding-agent/docs/tui.md` — document `hideFooter`.
7. Tests: component behavior (hover-to-input, Enter mapping, empty-input no-op,
   divider present, no frame) and the tool wiring (two options, feedback becomes
   a follow-up message, dismissal keeps plan mode).
8. `npm run check` and `./test.sh`.

## Expectation

- Two rows only. Arrowing to the second row shows a live cursor; typing edits in
  place; Enter sends the text as a follow-up and leaves plan mode active.
- Escape keeps plan mode, unchanged from the dismissed-dialog path today.
- No `╭`/`╯` frame around the plan; one `─` divider in `borderAccent` between the
  plan and the rows.
- The footer row is gone while the dialog is up and back after it closes.
- Other Step dialogs render exactly as before.

## Rollback

Revert `plan-mode-tools.ts` to the `ctx.ui.select` three-option call and delete
`plan-review.ts`; drop `hideFooter` from the types and interactive mode; revert
the `Input` prompt option. Nothing persisted changes, and plan-mode state
transitions are untouched.

## Outcome

Landed as planned. Notes worth keeping:

- `PlanReviewComponent.render` truncates any row wider than the viewport before
  returning. The hint row (`↑↓ navigate  enter select  escape cancel`) is 41
  columns and `TuiMainScreen` throws on an over-wide row, so this is a contract,
  not polish.
- `showExtensionCustom`'s inline path now takes the modal animation hold that
  `mountExtensionDialog` already took. `interactive-mode-status.test.ts` calls
  that method on a hand-built `fakeThis` and needed the new dependency stubbed.
- `ui.custom` is absent on hosts that are not the interactive TUI, but
  `exit_plan_mode` returns earlier for `rpc` and for `hasUI === false`, so the
  remaining mode is always `tui`. No fallback path was added.
- Tests: `plan-review-dialog.test.ts` (8 component cases),
  `step-plan-extension.test.ts` (the harness now mounts the real component
  through a `ui.custom` stub and drives it with keystrokes), and two
  footer/hold cases in `interactive-mode-dialog-animations.test.ts`.

## Rebased onto main (2026-09-14)

Two items from the list above were dropped when this landed on main:

- The animation hold is main's `setWaitingForApproval`, reached through a new
  `waitingForApproval` option on `custom()`, not the `suspendWorkingAnimations`
  counter written here.
- The wrapping / blank-line changes to `ExtensionSelectorComponent` and
  `splitStepDialogTitle` were reverted. They existed only so the plan rendered
  in full through the generic selector, and the plan has its own component now.
  They also regressed main's `approval viewport` test: wrapping a long approval
  title made the dialog taller and pushed Yes/No off a 40x16 viewport.
