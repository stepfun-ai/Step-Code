# packages/telemetry

Inherits the [root rules](../../AGENTS.md). This package is `@step-harness/telemetry`; it provides backend-neutral telemetry contracts and reference implementations.

## Responsibilities and entry points

- `src/index.ts`: `TelemetryContext`, `TelemetrySpan`, serializable schemas, and type inference helpers.
- `src/noop.ts`: shared `NOOP_TELEMETRY_CONTEXT`. `src/memory.ts`: in-process reference implementation.
- `src/testing/`: the `@step-harness/telemetry/testing` entry point and `createTelemetryAdapterConformance` contract.
- `test/telemetry.test.ts`, `test/conformance.test.ts`: schema, reference implementation, and observable adapter behavior.

## Boundaries and invariants

- Do not depend on other workspaces or telemetry backends. Do not embed exporters, network delivery, global current-span state, or business state.
- Propagate contexts explicitly through parameters. Business packages define their own domain schemas; provider / session business rules do not belong here.
- `startSpan` invokes the business callback synchronously and exactly once, then waits for settlement. Preserve business return values and rejection reasons; convert synchronous throws to Promise rejections as specified by the existing contract.
- Recording methods are synchronous, passive, and non-throwing. Backend recording failures must not prevent business execution; ignore failed records atomically and ignore writes after settlement.
- Keep attribute merging, ignored `undefined` values, and last-write-wins status semantics consistent with conformance. Do not alter span lifecycles through premature settlement.
- No-op retains no names, attributes, or events. The in-memory implementation is a local / test reference with unbounded, process-local storage, not production persistence or a global cache.
- Schemas remain serializable, with type inference preserving name-to-attribute relationships. Update documentation and type tests when changing required fields, enumerations, or sensitivity / cardinality annotations.
- Private adapters, exporters, and endpoints stay in separate integration environments. Public contracts must not carry credentials or real sensitive business samples.

## Validation and documentation

- Run `pnpm exec vitest --run test/telemetry.test.ts test/conformance.test.ts` here; run root `pnpm run check` after code changes.
- Adapter-contract changes validate both no-op and in-memory references, including synchronous throws, asynchronous rejections, recording failures, and post-settlement writes.
- Update the [package overview](README.md). Consumers maintain domain-schema documentation, such as the [agent-core schema](../agent-core/docs/telemetry-schema.md).
