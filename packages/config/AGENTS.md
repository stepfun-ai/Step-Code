# packages/config

Inherits the [root rules](../../AGENTS.md). This package is `@step-harness/config`; its current implementation provides product-neutral startup configuration migrations.

## Responsibilities and entry points

- `src/index.ts`: public migration functions and option types.
- `src/migrations.ts`: migrate legacy credentials to `auth.json`, move sessions and managed binaries, migrate keybindings, and report deprecated extension directories.
- `test/migrations.test.ts`: migration and repeated-startup behavior in temporary directories.

## Boundaries and invariants

- Do not depend on other workspaces. Callers explicitly supply `agentDir`, `configDirName`, and the keybindings migrator; do not obtain them through a reverse dependency on coding-agent.
- Step identity, default directories, TOML reads and writes, model selection, themes, and resource resolution belong in coding-agent. Do not move those product policies here merely because this package is named config.
- Migrations operate only on the supplied global directory and corresponding project directory, never another product's default paths.
- Preserve existing-target handling, legacy-file markers, and credential-file permissions. Repeated execution must not overwrite already migrated user data.
- Inject product keybinding rules through `KeybindingsMigrator`; this package handles file reads and migration orchestration.
- Keep startup messages and interactive waits at existing call boundaries. The host decides whether protocol modes display messages or wait for input.
- Do not add silent deletion or broaden cleanup on migration failure. Distinguish skippable legacy formats from actual data loss that must be reported.

## Validation and documentation

- Run `pnpm exec vitest --run test/migrations.test.ts` here; run root `pnpm run check` after code changes.
- Migration changes cover first startup, repeated execution, existing targets, malformed inputs, and explicit non-default directories. Tests must not use real user configuration.
- Update the [package overview](README.md); update [configuration guidance](../../docs/step-configuration.md) when Step startup or storage behavior changes.
