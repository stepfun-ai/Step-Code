# Direct extension installation — 2026-11-05

Scope: user's explicit Install click or import file selection starts installation without an additional browser confirmation modal, for plugins and skills. Do not change uninstall/MCP configuration dialogs or runtime tool approvals.

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| Add no-dialog installation regression | browser test | old popup behavior reproduced; requested direct install fails before change | retain evidence |
| Remove plugin/skill install confirmation helpers/calls | precise edits | click/pick immediately performs validated install; busy/success/error/conflict states retained | reverse only these edits |
| Update tests/docs, check and build | commands/files | four install/import flows don't emit dialogs; fingerprint and archive validation still exercised | keep live app and user configuration unchanged |

The existing backend two-stage validation/fingerprint contract is retained. `confirmed: true` now represents the explicit install/import action, not a second dialog. This does not disable runtime permissions, automatically install external applications or clear existing installations.

## Completed / validation
- Removed confirmation helper functions and calls from plugin-actions.ts and skill-actions.ts. Validation remains automatic before installation; busy/success/failure and duplicate handling unchanged.
- Added regression first: old code failed because one dialog appeared. Fixed and verified plugin/skill catalog installs and file imports all complete without dialogs; stale test navigation was corrected by leaving the first detail page before the second case.
- Focused install/import/error regressions: 5 passed. Full market/management Chrome: 31 passed, 0 skipped. Uninstall and MCP save dialogs still exercised by existing tests.
- Host/client typechecks and `npm run check`: exit 0; no unrelated formatter changes (0 restored). Existing informational lint diagnostics and Vite chunk-size warning retained. Full log `/tmp/stepcode-direct-install-check.log`.
- Desktop build `build.mjs --ensure-web` and `git diff --check` passed. Ignored Web/desktop artifacts refreshed; live user window not forcibly restarted and installed application untouched.
- Changed: `apps/web/client/src/features/settings/plugin-actions.ts`, `skill-actions.ts`, `apps/web/test/e2e/extension-management.e2e.mjs`, `extension-market.e2e.mjs`, `docs/plugin-market.md`, `skills-connectors.md`, and this record.
- No real-user installations, deletion, dependency execution or Git mutations in this turn.
