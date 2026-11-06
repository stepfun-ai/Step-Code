# Reference-only extension trials — 2026-11-05

## Scope
Trial opens a fresh conversation with exactly the selected plugin/skill/connector reference chip and an empty message body. It must not prefill explanatory text, send a prompt, install/enable resources or alter permissions. Preserve existing work and ordinary plus/slash selection semantics.

| Step | Tool | Expected result | Rollback |
| --- | --- | --- | --- |
| Seed the existing draft-local staged-reference cache through a public composer action | precise edits | new draft owns one reference; main body remains empty; inline rewrites unaffected | reverse only these edits |
| Pass typed resource identity from all trial entries | precise edits | skills use actual skill names, connectors actual server names, plugins installed display names; disabled resources guarded | restore old call signatures |
| Add browser regression and update contract docs | tests/edits | all types, repeated trials, chip removal and no request mutations verified | retain evidence; no Git reset |
| Check/build desktop artifacts | commands | typechecks/tests pass; new client is available after reloading the running desktop window | keep installed app and live drafts untouched |

## Investigation
Old trial helper wrote only a generated sentence via promptDraftRequest. Reused draft-local stagedPicks instead. All entries now pass typed actual resource identity, guard disabled resources, create a fresh draft, seed one reference and clear any old prefill request. Eventual user-typed tasks retain the normal reference serialization.

## Validation / completion
- Added browser regression first: old behavior failed with zero reference chips. After the fix, management, catalog and live detail trials pass for plugins/skills/connectors, repeated trials, actual installed aliases and chip removal, with empty body and no mutations.
- Full browser regression: 59 passed, 0 skipped (market, management, draft isolation / inline rewrites). Reference-only screenshot inspected at `/tmp/stepcode-reference-only-trial/trial-reference-only.png`.
- `npm run check`: exit 0; Web 948 total / 945 passed / 3 existing skips; Desktop 72 passed; typechecks, boundary guards, Web build and runtime smoke passed. Four pre-existing lint infos and Vite chunk-size warning remain; no unrelated formatter edits (0 restored).
- Desktop `node scripts/build.mjs --ensure-web`: passed; regenerated ignored desktop main/preload outputs. The running developer window was not forcibly restarted, to avoid losing in-progress draft input; Cmd+R reloads the new client.
- `git diff --check`: passed. No installed application replacement, Git mutation, actual extension changes or model send.

## Changed files
- `apps/web/client/src/features/composer/actions.ts`
- `apps/web/client/src/features/settings/extension-trial.ts`, `ExtensionRowMenu.tsx`
- `apps/web/client/src/features/market/MarketEntryActions.tsx`, `ConnectorMarketDetail.tsx`
- `apps/web/test/e2e/extension-management.e2e.mjs`
- `docs/plugin-market.md`, `docs/skills-connectors.md`, and this record.

Commands also generated ignored Web/desktop build artifacts and temporary check scripts/logs/screenshots under `/tmp`.
