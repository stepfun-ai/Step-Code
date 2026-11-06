# Skills and connectors — 2026-11-05

## Scope
Continue the plugin work with real skill catalog installation/import, connector configuration templates and management/trial, current catalog synchronization, folded plugin-source groups and live reference state. Excludes telemetry and P2 automated intake/testing. Preserve existing staged and untracked changes; no publishing, external dependency execution or real-user installation during tests.

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| Add bounded skill archive preparation and atomic installation in coding-agent | file edits + scratch tests | valid root SKILL.md and resources installed only after fingerprint consent; bad ZIP/name/description/conflicts rejected | undo only this session's new modules/edits |
| Package current 36 skills and update 15 connector templates | explicit packaging script | OpenTUI removed, Cangjie current entry, six local custom design skills added; only evidence-backed MCP configurations; unresolved local paths stay visibly required | restore catalog/resource snapshot |
| Add authenticated skill preview/import/install APIs | Host adapter + scratch HOME tests | no writes during preview; correct provenance and installed status; standalone markdown and ZIP handled | remove new routes |
| Connect skill UI and MCP templates/menus/folding | React edits + Chrome fixtures | no false success; templates open editable form/JSON, placeholders cannot be saved; trial exits settings and disabled resources cannot be referenced | restore precise UI edits |
| Validate and document | unit tests/typechecks/browser/project checks | report outcomes and external dependency/auth prerequisites accurately | keep evidence; no Git reset |

## Decisions
- Connector catalog entries configure the existing user MCP registry, not a new extension type. Templates require explicit user save/consent; local project paths, external applications, CLI dependencies and credentials remain user configuration.
- Skill packaging keeps SKILL.md, scripts/references/assets and explicitly referenced resource directories; repository caches and unrelated example projects are excluded with logs. Source packages remain unchanged. Copied frontmatter may be normalized to valid YAML, with this recorded in catalog notes.
- Existing ZIP reader is reused with explicit bounded skill limits (larger file count for Cangjie docs). Plugin limits remain unchanged.
- Provenance is verified against bundled content and is presentation metadata, never license/security certification. The six design skills are locally supplied custom resources; don't claim upstream certification from folder names.

## Status
Completed and verified. Current catalog: 29 plugins / 36 skills / 15 connectors. Original local source packages were not changed.

## Validation
- `npm run check`: exit 0. Web 948 total / 945 passed / 3 pre-existing skips; Desktop 72 passed. Host/client/root typechecks, boundary guards, Web build and runtime smoke passed. Four pre-existing lint infos and Vite chunk-size warning remain; no unrelated formatter changes (restored 0 files).
- Focused core Vitest: 9 passed across skill install, plugin install and plugin state.
- Focused Web tests: catalog, skill/plugin installation and settings passed; final full Web check includes all five new skill tests, including numeric/boolean-like names.
- Chrome market/management E2E: 27 passed, 0 skipped in sequential execution. Parallel run initially had 2 timeouts (navigation/file chooser); explicitly closed a leftover test menu and reran both failed tests and full suite successfully.
- Compiled artifact smoke passed: skill catalog installation/provenance, disable/delete, Markdown import, MCP declaration add/list/delete; no MCP process launched.
- Portable skill resource: 47,332,184 bytes, copied exactly to the compiled Web output. SVG retains referenced libraries/resources while explicitly excluding unrelated repositories; Cangjie retains 7566 files. Mermaid copied frontmatter was normalized, original unchanged.
- `git diff --check`: passed. Browser screenshots inspected for skill installed/disabled state and collapsed plugin-source groups.
- Commands generated ignored core/Web `dist`, curated skill JSON and updated catalog JSON; temporary scripts/logs/screenshots under `/tmp/stepcode-skills-*` and `/tmp/stepcode-built-skills-*`. Scratch HOME and Vite caches cleaned. No real-user extension changes, publishing, branch/stage/commit changes, credentials or external MCP execution.

## Changed paths
- Core: `packages/coding-agent/src/step/skill-install.ts`, `plugin-archive.ts`, `plugin-install.ts`, `step/index.ts`, `src/index.ts`, `test/step-skill-install.test.ts`.
- Host: `apps/web/src/skill-market.ts`, `settings.ts`, `server.ts`, `openapi.yaml`, `package.json`.
- Resources/scripts: `apps/web/resources/skill-market.json`, `scripts/package-skill-market.mjs`, `scripts/package-connector-templates.mjs`, `client/src/features/market/catalog/catalog.json`.
- Settings client: `skill-actions.ts`, `SkillInstallButton.tsx`, `index.tsx`, `SkillsPage.tsx`, `McpPage.tsx`, `McpEditor.tsx`, `ExtensionSourceGroups.tsx`, `ExtensionCreateMenu.tsx`, `extension-management.css`.
- Market client: `MarketEntryActions.tsx`, `MarketRowActions.tsx`, `extension-market-data.ts`, `ExtensionMarketPage.tsx`, `ExtensionMarketAdd.tsx`, `ConnectorMarketList.tsx`, `ConnectorMarketDetail.tsx`.
- State/i18n: `client/src/state/types.ts`, `store.ts`, `i18n/extension-management-messages.ts`.
- Tests: `apps/web/test/skill-market.test.ts`, `market-catalog.test.ts`, `e2e/extension-market.e2e.mjs`, `e2e/extension-management.e2e.mjs`.
- Documentation: `docs/skills-connectors.md` and this record.
