# Plugin market and management — 2026-11-05

## Scope
Make plugin catalog installation, ZIP import, management, trial and composer references functional. Preserve existing staged/untracked work. Skills/connectors are affected only as plugin contributions. No remote publishing, dependency installation, credentials or third-party executable runs.

## Steps
| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| Create bounded package reader and installer in coding-agent | file edits + isolated unit tests | malformed ZIP, traversal, links, duplicates, oversized archives and invalid manifests fail before publication; existing installations survive | remove only this session's new modules and revert its precise edits |
| Generate portable curated plugin resource from local converted packages | reviewed packaging script | 29 packages include declared skills/commands/MCP and associated resources, notices; no local absolute paths or runtime download dependency | remove generated resource and script |
| Add authenticated preview/confirmed-install endpoints | server/settings edits + scratch-HOME tests | immutable fingerprint consent, real disk install, explicit conflicts and safe dependency warnings | restore this session's route changes |
| Connect frontend install/import and management references | component edits + browser fixtures | success only after API response, cancel/failure preserve state; disabled plugin excluded from picks; trial leaves settings | restore precise UI edits |
| Document and validate | focused tests, typechecks, npm run check | report focused outcomes and unrelated baseline failures without overwriting user changes | retain report; no Git reset |

## Decisions / limits
- Installation copies resources and does not install external CLI dependencies; MCP reconciliation occurs only after explicit consent. Dependencies, environment and external service availability remain visible requirements.
- Catalog payloads are generated from locally supplied converted packages. This is not a license, security or quality certification and does not publish them.
- Full product check contains formatter writes and build steps; inspect pre/post Git state and preserve unrelated work.
- ZIP support is bounded store/deflate, single plugin root, regular files only; unsupported/encrypted/ZIP64 archives receive explicit errors.

## Progress
- Completed: bounded ZIP validation, manifests/usable skill entries/MCP config validation, fingerprint consent, atomic installation with stale-recoverable proper-lockfile locks.
- Completed: portable 29-plugin resource generated (77,490,368 bytes) and copied byte-for-byte to the Web build. No source absolute path is required at runtime; third-party license and service readiness remain release checks.
- Completed: real plugin installation/import UI, errors/cancel/conflicts, source grouping, disabled-reference filtering, projection invalidation, trial leaving settings, removal/reinstall state.

## Verification
- `npm run check`: exit 0. Web unit tests: 943 total / 940 passed / 3 skipped; Desktop tests: 72 passed. Typechecks, boundary guards, client build and Web runtime smoke passed.
- Root lint retains 4 pre-existing informational diagnostics in migration/session-import code; Vite retains the large-chunk warning. No errors, no unrelated formatter changes (backup wrapper restored 0 files).
- Plugin core focused Vitest: 7 passed (ZIP errors, concurrent/stale locks, publication, parent-level state).
- Plugin/settings/origin/slash focused Web tests: 29 passed, including actual ZIP preview/install and removal/reinstall in scratch HOME.
- Chrome market/management fixture E2E: 24 passed / 0 skipped. The original new install test had an asynchronous dialog race; fixed the wait and reran the whole suite successfully.
- Compiled artifact smoke: real curated Lark installation, Market provenance, 28 discovered skills, disable and uninstall passed; no MCP service started.
- `git diff --check`: passed. Existing staged/untracked user changes and provider data change preserved. No Git mutation, publishing or real-user plugin installation.
- Commands generated ignored `packages/coding-agent/dist` and `apps/web/dist`, the curated resource, temporary test scripts/logs under `/tmp`, and screenshot directories `/tmp/stepcode-plugin-live-{market,management}`. Test scratch HOME and Vite caches were cleaned.

## Changed paths
- Core: `packages/coding-agent/src/step/plugin-archive.ts`, `plugin-install.ts`, `step/index.ts`, `src/index.ts`, and `test/step-plugin-install.test.ts`.
- Host: `apps/web/src/plugin-market.ts`, `server.ts`, `settings.ts`, `openapi.yaml`, `package.json`, `resources/plugin-market.json`, `scripts/package-plugin-market.mjs`.
- Client settings: `PluginInstallButton.tsx`, `plugin-actions.ts`, `PluginsPage.tsx`, `ExtensionRowMenu.tsx`, `extension-removal.ts`, `extension-trial.ts`, `actions.ts`, `index.tsx`.
- Client market: `MarketEntryActions.tsx`, `MarketRowActions.tsx`, `ExtensionMarketAdd.tsx`.
- Client composer: `PlusSubPanels.tsx`, `SlashMenu.tsx`, `slash-groups.ts`; also `state/types.ts`, `i18n/extension-management-messages.ts`.
- Web tests: `plugin-market.test.ts`, `client-slash-groups.test.ts`, `e2e/extension-market.e2e.mjs`, `e2e/extension-management.e2e.mjs`.
- Documentation: `docs/plugin-market.md` and this execution record.
