# packages/providers

Inherits the [root rules](../../AGENTS.md). This package is `@step-harness/providers`; it owns model access, protocol adapters, catalogs, and credential resolution.

## Responsibilities and entry points

- `src/index.ts`, `models.ts`, `models-store.ts`, `types.ts`: public model interfaces, provider registration, catalog storage, and stream types.
- `src/provider/` and `src/dialect/`: separate provider-identity and API-dialect lookups. `src/api/`: protocol adapters such as OpenAI and Anthropic.
- `src/auth/`, `oauth.ts`, `env-api-keys.ts`: credential contracts, resolution, and OAuth. `src/step-provider/`: Step login protocols.
- `src/providers/all.ts`, `faux.ts`, `data/`, and `models.generated.ts`: built-in catalogs, the test provider, and generated snapshots. `src/metadata/`: presentation metadata.
- `scripts/generate-models.ts`, `model-data.ts`, `check-model-data.ts`: generation, structural validation, and offline-data integrity.

## Boundaries and invariants

- Internal dependencies are limited to telemetry. Do not depend on the Agent Loop, coding tools, product permissions, MCP, or CLI. Vendor SDKs and protocol differences stay here.
- Dispatch adapters by `model.api`. Provider identity, dialect `source`, and presentation metadata must not select a protocol implementation.
- Keep legacy identity derivation in `src/dialect/resolve.ts`. Register vendor compatibility quirks in `scripts/adapter-provider-quirks.json`; do not turn quirks into new dispatch mechanisms.
- Preserve explicit-credential overrides, stored credentials, and environment fallback precedence from `src/auth/resolve.ts`. Recheck and persist OAuth refreshes under the credential lock; failures must not silently fall back to environment credentials.
- Stream ordering, tool-call identifiers, cancellation, error settlement, and usage semantics must be consistent across adapters. Retries must not publish duplicate final events.
- The current public build's `builtinProviders()` returns an empty catalog. The product layer registers Step; configuration supplies custom models. Retained adapters do not mean all vendors are enabled by default.
- Do not hand-edit generated catalogs, snapshots, or manifests. Change generator scripts / inputs, then run root `pnpm run generate:models` and `pnpm run check:model-data`. Offline builds use committed data without silently refreshing remote catalogs.
- Pass credentials and telemetry contexts through explicit interfaces. Errors, fixtures, and diagnostics must not expose real tokens or keys.

## Validation and documentation

- Select regressions that do not access real services, such as `pnpm exec vitest --run test/dialect-provider-registry.test.ts test/faux-provider.test.ts`, from this directory. Protocol changes also run the relevant mock / conformance cases.
- Run root `pnpm run check:derived-compat-only`, `pnpm run check:no-provider-dispatch`, and `pnpm run check:metadata-not-in-dispatch`; run the full `pnpm run check` after code changes.
- Use root `./test.sh` for full validation with isolated resources and credentials; do not directly run tests that may activate real providers.
- Update the [package overview](README.md). Product configuration changes also update [models](../coding-agent/docs/models.md) or [custom providers](../coding-agent/docs/custom-provider.md).
