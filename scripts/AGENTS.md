# scripts

Inherits the [root rules](../AGENTS.md). This directory owns repository checks, builds, generation, and local development helpers.

## Responsibilities and entry points

- `check-*.mjs`: dependency, layer, entry-freeze, protocol-dispatch, public-boundary, credential, and commit checks; use root `package.json` to verify how they are invoked.
- `workspace-registry.json`, `adapter-provider-quirks.json`, `__baseline__/`: workspace registration, adapter compatibility exceptions, and frozen baselines.
- `build-binaries.sh`, `build-coding-agent-bundle.mjs`, `package-workspaces.mjs`: platform binaries, product bundles, and package outputs.
- Helpers such as `diff-model-catalog.mjs` and `generate-thinking-capabilities.mjs`: catalogs and capabilities. Model-snapshot generators live in providers' `scripts/`.
- `*.test.mjs`, `guard-self-tests.test.mjs`, `__fixtures__/`: script regressions and guard self-tests. `smoke/`: controlled terminal validation.

## Boundaries and invariants

- Extend existing scripts and root commands rather than create parallel check systems. Resolve paths from script / repository locations and support documented invocation directories.
- Fix implementations when guards fail. Do not broaden exemptions, remove fixtures, or refresh baselines to conceal boundary violations. Justify legitimate rule changes and cover both valid and invalid cases.
- Distinguish real source scans, tracked-tree / staged checks, and synthetic self-tests. New files must not escape validation because they are not yet tracked.
- Register new workspaces in all three sources. Keep exact dependency versions and lockfiles consistent with dependency changes; respect existing commit checks and do not skip hooks.
- Put temporary experiments in temporary directories and persistent outputs in established locations such as `dist/` / `.artifacts/`. Clean up only directories you created and can verify ownership of.
- Use structured subprocess arguments and check exit statuses. Separate protocol stdout from diagnostics; never log real credentials or complete sensitive environments.
- Public release tooling provides only existing local build capabilities. Do not add private uploads, endpoints, or protected-tag operations here.
- Check task scope before dependency installs, remote catalog refreshes, or publication commands. Documentation / guard tasks must not also modify user resources or generate large unrelated outputs.

## Validation and documentation

- Run root `pnpm run test:scripts`. Guard changes also run the corresponding real scan and `--self-test`; code changes run the full `pnpm run check`.
- For shell changes, run `bash -n <script-path>`, then offline fixtures / dry-runs to verify actual arguments and failure paths.
- Keep root commands, CI, and [contribution requirements](../CONTRIBUTING.md) consistent. Update the relevant rules when changing layers or public boundaries.
