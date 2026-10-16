# packages/agent-core

Inherits the [root rules](../../AGENTS.md). This package is `@step-harness/agent-core`; it owns the generic Agent runtime.

## Responsibilities and entry points

- `src/agent-loop.ts`: the single Agent Loop. `src/agent.ts`: state, steer / follow-up, and execution control.
- `src/types.ts`, `src/stream-fn.ts`, `src/proxy.ts`: runtime types and model-stream interfaces.
- `src/harness/`: context, sessions, compaction, resources, and generic tools; also read the [harness rules](src/harness/AGENTS.md).
- `src/node.ts`: Node entry point. `src/search/`: generic search capabilities.

## Boundaries and invariants

- Internal dependencies are limited to providers and telemetry. Do not depend on coding-agent, config, contracts, CLI, or TUI.
- Do not introduce vendor SDKs, Step defaults, CLI argument parsing, or UI objects. Products compose capabilities through stream, tool, environment, and resource interfaces.
- All product modes share this loop. New entry points must not copy the tool-call loop or message state machine.
- Preserve tool-call/result pairing, event ordering, cancellation propagation, steer / follow-up timing, and the distinction between errors and normal completion.
- Generic session context and persistence contracts belong in the harness. Product session adapters may compose them; client caches must not become authoritative state.
- Pass telemetry contexts explicitly. Disabling telemetry must not change business return values, errors, or execution order.

## Validation and documentation

- Select relevant cases from `test/` and run `pnpm exec vitest --run <test-path>` here.
- Run harness regressions with `pnpm exec vitest --run --config vitest.harness.config.ts <test-path>`; fixtures must not access real model services.
- Update the [harness documentation](docs/harness.md) for generic runtime or session-contract changes. Product lifecycle changes also update the relevant root `docs/` guidance.
