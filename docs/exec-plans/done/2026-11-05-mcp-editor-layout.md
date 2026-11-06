# MCP editor UI cleanup — 2026-11-05

Scope: remove developer-facing template/source evidence from the editor header and repair the Form/JSON control layout. Preserve actual validation/save/authorization flows and all unrelated work.

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| Reproduce long header + narrow switch | isolated browser test | old UI fails evidence visibility and/or equal one-line buttons | retain regression |
| Remove evidence rendering; constrain editor heading/control flex sizing | precise JSX/CSS edits | no development note; both labels remain horizontal, aligned, within header at tested widths | reverse these small changes |
| Run layout/save regressions, typechecks and project check; rebuild | commands/screenshots | functional save and responsive screenshots pass | keep installed/running app untouched |

Root cause: the long evidence paragraph shares a flex row with a shrinkable segmented control; neither the text column nor the control had explicit sizing/nowrap rules. Removed evidence JSX only, and added text min-width/flex plus fixed-size nowrap control rules, scoped to settings editors. Actual save, validation and risk confirmation are unchanged.

## Completion
- Regression added first and failed on the old visible README/template explanation.
- Two focused Chrome regressions passed: clean editor and horizontal/equal-height controls within header bounds at 1440/900/760/600 widths, Form/JSON state preservation and actual save request path.
- Clean layout screenshot inspected: `/tmp/stepcode-mcp-editor-clean/mcp-editor-clean-layout.png`.
- Host/client typechecks passed. `npm run check` exit 0; existing lint informational diagnostics and Vite large-chunk warning remain. Full log `/tmp/stepcode-mcp-layout-check.log`; unrelated formatter changes restored: 0.
- `git diff --check` and desktop `build.mjs --ensure-web` passed. Web/desktop ignored build outputs refreshed; running user window not forcibly restarted.
- Changed: `apps/web/client/src/features/settings/McpEditor.tsx`, `settings.css`, `apps/web/test/e2e/extension-management.e2e.mjs`, and this record. No backend behavior changes, no application replacement, no user configuration/Git mutation.
