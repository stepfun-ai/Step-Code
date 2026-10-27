---
title: Apply Step CLI sage theme to Step Harness
status: active
---

## Step

Create a development branch from the latest `main`, author a step-harness
`Architecture` section in `step-harness/AGENTS.md` that documents this
repository's real package layout and ownership rules while retaining the
existing harness-specific rules, and add the Step CLI `sage` palette to the
harness TUI theme catalog. The new
`sage` theme must be selectable through the existing theme picker and `/theme sage`
path without changing the current automatic `step-light/step` default.

## Tool

1. Fetch the remote refs and create
   `feat/apply-sage-theme-to-step-harness` directly from the latest
   `origin/main`, leaving the local `main` branch untouched.
2. Add `packages/coding-agent/src/modes/interactive/theme/sage.json`, mapping the
   Step CLI sage colors to the harness theme schema (UI, markdown, syntax,
   thinking, tool, and export colors).
3. Update theme documentation and focused theme tests so the new file is loaded,
   listed, validates, and preserves the existing Step default pair.
4. Write an `Architecture` section in the harness `AGENTS.md` describing this
   repository's real package layers, dependency direction, and ownership rules
   (derived from each package's workspace dependencies), keeping the existing
   harness-specific sections authoritative.
5. Run the focused theme test, `npm run check`, and `git diff --check`.

## Expectation

- `git branch --show-current` reports `feat/apply-sage-theme-to-step-harness` and
  its merge base is `origin/main`.
- `sage.json` loads through `getAvailableThemes()`, appears in the selector, and
  resolves to the Step CLI sage palette without changing `STEP_DEFAULT_THEME`.
- Theme tests, repository checks, and whitespace validation pass.
- `AGENTS.md` documents the step-harness package architecture and ownership
  rules alongside the existing harness-specific commands and constraints,
  without losing any existing rules and without step-cli-specific content.

## Rollback

Delete the new branch-local theme, documentation/test edits, and the merged guidance
from `AGENTS.md`; then remove the branch with `git branch -D
feat/apply-sage-theme-to-step-harness` if the work is abandoned. Do not alter or
force-reset shared remote branches.
