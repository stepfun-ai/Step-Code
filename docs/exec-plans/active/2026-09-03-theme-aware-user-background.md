---
title: Theme-aware user message background
status: complete
---

## Step

Make Step user message bars follow the active light or dark theme, using a
muted Morandi-style background and a matching foreground/Markdown palette.

## Tool

Update the built-in Step theme JSON files, remove the forced light Markdown
palette from the dark Step user-message component, and adjust focused tests.
Run the focused theme tests and `npm run check`.

## Expectation

Dark Step renders a dark gray user bar with light text; light Step renders a
light warm gray user bar with dark text. Theme switching and 256-color output
continue to use the active theme.

## Rollback

Revert the theme JSON, component, test, changelog, and this plan file if the
focused tests or full check expose a regression.
