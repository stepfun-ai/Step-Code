# First-run theme picker

Add a Claude-Code-style theme selection screen that runs once on the first
interactive launch — after the startup login and the MCP import offer — with a
live preview under the list. Enter confirms and drops the user into the REPL.

## Context

- `apps/cli/src/ui/interactive-mode.ts#run()` already sequences the first-run
  screens: `stepMcpImport` (pre-`init()`), `init()`, `onStartup` (update check),
  `maybeRunStartupLogin()`, then the REPL.
- Theme application and persistence belong to `InteractiveThemeController`
  (`preview`, `setThemeSetting`) and `SettingsManager.setTheme` (writes
  `theme = "..."` into `~/.step-cli/config.toml`).
- Step ships `dark`, `light`, `sage`, `step`, `step-light`; its default setting
  is the auto pair `step-light/step` (`STEP_DEFAULT_THEME`).

## Steps

1. **Step** Pure option model + hosted screen for the picker.
   **Tool** New `packages/coding-agent/src/step/theme-prompt.ts`
   (`buildStepThemeOptions`, `runStepThemePrompt`) and
   `packages/coding-agent/src/step/theme-prompt-view.ts` (`StepThemePromptView`),
   following the `mcp-import` view/flow pair.
   **Expectation** `buildStepThemeOptions(["step","step-light","dark"], "step-light/step")`
   yields Auto / Dark / Light first, then the remaining themes; the view renders
   the list plus a syntax-highlighted diff preview.
   **Rollback** Delete both files.

2. **Step** Interactive-mode wiring, gated to a genuine first run.
   **Tool** Add `stepThemePrompt` to `InteractiveModeOptions`
   (`packages/coding-agent/src/modes/interactive-contract.ts`), add
   `maybeRunStepThemePrompt()` to `apps/cli/src/ui/interactive-mode.ts`, call it
   in `run()` in the pre-`init()` phase right after the MCP import offer (a
   picker mounted after `init()` flashes the logo and input box first), and
   supply the hook from `apps/cli/src/main.ts`. The confirmed setting is written
   through the settings manager before `init()` builds the theme controller, so
   the session opens in the chosen theme.
   **Expectation** With no `theme` in `config.toml` a bare `step` shows the
   picker after login/MCP import with no UI painted behind it; Enter persists the
   choice and enters the REPL in that theme, and Escape persists the default. A
   second launch (either way, `theme` is now set), a launch with an initial
   prompt, a resumed session, and `step login` all skip it.
   **Rollback** Revert the three files.

3. **Step** Tests + changelog.
   **Tool** `packages/coding-agent/test/step-theme-prompt.test.ts` (option model,
   view rows), `apps/cli/test/interactive-mode-theme-prompt.test.ts` (gate and
   persistence), root `CHANGELOG.md` under `[Unreleased] / Added`.
   **Expectation** Both test files pass; `npm run check` is clean.
   **Rollback** Revert the test files and changelog entry.

## Side effects

The picker writes `theme` into `~/.step-cli/config.toml` on every exit —  the
confirmed option, or the product default when dismissed. That key is the only
state the flow keeps: no separate "asked already" flag, so deleting the line is
what asks again. Nothing else is touched.
