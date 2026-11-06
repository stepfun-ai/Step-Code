# Plugin CLI preparation — 2026-11-05

Scope: attempt automatic installation of evidence-backed CLI dependencies during plugin installation; report CLI readiness and first-use configuration separately from plugin-file success. Preserve existing installations, other agents' skills, credentials and global shell profiles. Unknown commands/installers must not execute.

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| Add product-owned dependency preparer with fixed package recipes | code + injected offline tests | known CLIs probe/install/verify; unknown names don't execute; timeout/network/unsupported platform have value-free reason codes | revert only these modules |
| Install to private agent tool directory and expose via existing managed bin PATH | code + isolated smoke | no sudo/global npm/project lock changes, no user command overwrites, existing binaries reused | remove only test scratch artifacts |
| Attach result and first-use guidance to install/list responses and UI | code/tests | UI never says CLI ready when preparation failed; auth/config remains user-owned | restore response/UI changes |
| Check/build and document | tests/commands | status branches and preserved plugin/skill flows pass | keep installed app and live drafts untouched |

## Evidence / decisions
- Existing shell tools prepend `<agentDir>/bin`; use that instead of changing global PATH or profiles.
- Known npm sources from supplied code: `dingtalk-workspace-cli` (stable 1.0.66 in CHANGELOG), `@larksuite/cli@1.0.98`, `@wecom/cli@1.3.4`. Installer recipes are fixed, never taken from imported package shell strings.
- npm runs with scripts ignored, isolated empty npm config and a minimal environment. Only fixed binary installer entrypoints may run. DWS's `DWS_NO_SKILLS=1` guard must exist before its installer runs, to prevent other-agent skill writes. Lark installer only prepares the binary; WeCom uses npm platform binaries.
- macOS/Linux private launcher installation is supported initially; unsupported cases explicitly return setup-needed status rather than silently changing system configuration.
- Probe only known CLI version flags; never run authentication checks or read credentials. First-use auth guidance: dws auth login, lark-cli auth login, wecom-cli auth init; gh/glab reuse existing commands or report manual setup.
- Test execution is injected/offline by default. Real registry smoke uses scratch HOME and is not a user-global installation.

## Completed / validation
- Added fixed private CLI preparer, value-free readiness/reason states, bounded installer/version execution, minimal environment and isolated npm config. DWS's binary-only guard enforced. Known versioned caches can repair their launcher without downloading. Unknown commands do not execute; user executables are not overwritten.
- Catalog/ZIP installs attach preparation results after file publication; failure preserves files. Existing plugin prepare API and lightweight list inspection added. Host process-local PATH includes managed bin for shell/MCP/new terminal resolution; no global PATH/profile edits.
- UI no longer always requests separate CLI installation. Ready/installed results retain first-use auth guidance; incomplete results show neutral setup-required plus reason. Management/detail provide fixed copyable setup commands and a no-dialog Prepare CLI retry action. No automatic credential/auth checks or login.
- Core focused plugin tests: 42 passed across dependencies (6 cases), install/state/discovery. Web targeted plugin/settings tests: 17 passed. Full Chrome market/management: 33 passed, 0 skipped; ready/failure screenshots inspected under `/tmp/stepcode-plugin-cli-preparation`.
- Real scratch-HOME installs: dws, lark-cli and wecom-cli all returned installed after version verification. DWS launcher removal/recovery returned ready without reinstalling. Temporary HOME directories cleaned; actual user CLI/configuration/other-agent skills unchanged.
- `npm run check`: exit 0, Web 949 total / 946 passed / 3 existing skips, Desktop 72 passed; type/boundary/build/runtime checks passed. Existing informational lint diagnostics and Vite chunk-size warning remain. No unrelated formatter edits (0 restored); full log `/tmp/stepcode-cli-preparation-check.log`.
- Desktop build --ensure-web and git diff --check passed. Ignored core/Web/Desktop outputs refreshed. Running user desktop was not forcibly stopped; the new backend requires File → Restart Server (or restart the development app), not just renderer reload.

## Changed files
- Core: `packages/coding-agent/src/step/plugin-dependencies.ts`, `plugin-install.ts`, `plugins.ts`, `step/index.ts`, `src/index.ts`, `test/step-plugin-dependencies.test.ts`.
- Host: `apps/web/src/plugin-market.ts`, `settings.ts`, `server.ts`, `openapi.yaml`.
- Client: `state/types.ts`, settings `plugin-actions.ts`, `PluginDependencyStatus.tsx`, `PluginsPage.tsx`, `index.tsx`, `extension-management.css`; market `ExtensionMarketDetail.tsx`; `i18n/extension-management-messages.ts`.
- Tests/docs: `apps/web/test/plugin-market.test.ts`, `e2e/extension-management.e2e.mjs`, `docs/plugin-cli-preparation.md`, `plugin-market.md`, and this record.
- Commands created temporary real-install smoke scripts/logs/screenshots under `/tmp`. No publishing, Git mutation, installed app replacement, global dependency install or auth grant.
