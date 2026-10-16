# apps/cli

Inherits the [root rules](../../AGENTS.md). This package is `@step-harness/cli`; it owns Step's process entry points and application host.

## Responsibilities and entry points

- `src/main.ts`, `src/index.ts`: top-level composition and public entry point. `src/bun/stepcode.ts`: standalone binary entry point.
- `src/args/`: argument definitions and mode selection. `src/commands/`: top-level commands. `src/bootstrap/`: environment, configuration, and extension composition.
- `src/modes/`: routing for interactive, print, JSON, RPC, and SDK stdio, reusing coding-agent execution capabilities.
- `src/ui/`: interactive terminal host, runtime, and view; also read the [UI rules](src/ui/AGENTS.md).
- `src/version.ts`, `assets/`: host version and terminal visual assets.

## Boundaries and invariants

- argv, TTY detection, process exit, signals, and stdout/stderr routing belong here. Agent Loop, session persistence, permission policies, and provider adapters belong in lower layers.
- Inject UI capabilities into coding-agent through hooks; `packages/**` must not import CLI.
- Non-UI code enters UI only through `#ui` / `#ui/index` or an equivalent public entry point, never deep UI internals. Use `#*` aliases only within this app.
- Keep JSON, RPC, and SDK stdio stdout limited to protocol output. Send diagnostics through the prescribed stderr / diagnostic channel; do not mix in startup banners.
- Keep startup waits specific to interactive, print, and RPC modes, especially background MCP connection in interactive mode versus waiting for the initial catalog in non-interactive modes.
- Use existing build identity and version resolution. Do not add independent version constants or infer product tags from package versions.

## Validation and documentation

- Run root `pnpm run check:layer-direction` and `pnpm run check:ui-layer`; run the full `pnpm run check` after code changes.
- Run `pnpm exec vitest --run test/package-command-paths.test.ts` here; select further regressions from `test/` for mode or startup changes.
- For manual TUI checks, run root `./step-test.sh --no-env` and explicitly supply isolated user-resource directories. The script removes listed environment credentials but does not isolate local login or configuration. Validate built artifacts with the actual built binary.
- Update [configuration](../../docs/step-configuration.md), the [rendering pipeline](../../docs/tui-rendering-pipeline.md), or coding-agent mode documentation as applicable.
