---
title: Keep the editor on the bottom row across /feedback
status: ready-for-review
---

# Keep the editor on the bottom row across /feedback

## Step

Stop the `/feedback` wizard from stranding the editor above the bottom row.

An extension select or input dialog replaces the editor inside the rendered
document, so the document grows by the dialog's extra rows. Once the transcript
is taller than the terminal, that growth scrolls the screen, and the shrink on
dismissal cannot scroll it back — cancelling a page left the editor about eight
rows above the bottom with blank rows under it. The consent page already
rendered as an overlay and did not drift, so the three pages of one wizard
disagreed on where the editor ended up.

Give the select and input dialogs the same overlay rendering the consent page
uses, and put every `/feedback` page on it.

## Tool

- `packages/coding-agent/src/core/extensions/types.ts` — add `overlay?: boolean`
  to `ExtensionUIDialogOptions`, documenting when to reach for it.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — factor the
  show/hide paths into `mountExtensionDialog()`, which returns the unmount call.
  The overlay branch anchors `bottom-center` at full width with a bottom margin
  equal to the rendered height of the below-editor widget and footer containers,
  so the dialog lands on the rows it would have taken inline and the footer stays
  visible. The inline branch keeps the previous editor-container swap. Also call
  `hideExtensionSelector()` / `hideExtensionInput()` before showing a new dialog:
  the old component was previously dropped without dispose, leaking its countdown
  timer, and as an overlay it would have stranded a dialog on screen.
- `packages/coding-agent/src/step/slash-commands.ts` — pass `{ overlay: true }`
  from every `/feedback` page (category select, comment input, upload-logs
  select).
- Tests: `packages/tui/test/tui-shrink.test.ts` asserts the last viewport row is
  still the editor after an overlay is shown and hidden over an
  already-scrolled transcript; `packages/coding-agent/test/step-slash-commands.test.ts`
  asserts each `/feedback` page requests an overlay.
- `npm run check` plus the two test files above.

## Expectation

Every `/feedback` page composites onto rows the document already occupies, so
the rendered document keeps its length, the editor holds the bottom row through
the whole wizard, and cancelling any page leaves no blank rows. Consent-page
behavior is unchanged; dialogs that do not pass `overlay` keep the inline
rendering. `npm run check` and the TUI + slash-command tests pass.

## Rollback

Revert the branch commit. The change is additive behind an opt-in `overlay`
flag, so dropping it restores the inline dialog path with no state or config
migration to undo.
