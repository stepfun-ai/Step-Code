# npm distribution for StepCode

Goal: `npm i -g @stepfun/stepcode` installs the same standalone `step` binary that
`install.sh` installs, published to the internal npm registry (`STEP_NPM_REGISTRY`, artifactory
`npm-public`) automatically after the prod TOS upload of a release tag.

## Design

- `@stepfun/stepcode` (main): `bin/step.js` Node launcher + `optionalDependencies`
  on six platform packages pinned to the same version.
- `@stepfun/stepcode-<os>-<cpu>` (`darwin-arm64`, `darwin-x64`, `linux-arm64`,
  `linux-x64`, `win32-arm64`, `win32-x64`): `os`/`cpu` restricted; the extracted
  release archive lives under `vendor/` so the archive's own `package.json`
  (read by the runtime) is not replaced by the npm manifest.
- Source of truth is the prod release on TOS: the npm job downloads the six
  archives listed in `<version>/manifest.json`, verifies SHA-256, extracts, packs,
  and publishes. No rebuild; npm bytes equal installer bytes.
- Launcher spawns the binary with `STEPCODE_INSTALL_METHOD=npm`. The updater treats
  that (or an executable path inside `node_modules/@stepfun/stepcode-*`) as
  npm-managed: `step update` and the startup prompt print the npm command instead
  of overwriting files inside `node_modules`.
- Publish order: platform packages first, main package last. Already-published
  versions are skipped so a retried job is idempotent.

## Steps

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| 1. `infra/release/npm-packages.mjs` (download/verify/extract/stage/publish, `--dry-run`) | edit | `--dry-run` stages 7 dirs and `npm pack --dry-run` lists `vendor/step` with exec bit | delete file |
| 2. `infra/release/npm/launcher.js` + README template | edit | launcher resolves platform package, forwards argv/stdio/exit code/signals | delete files |
| 3. npm-managed detection in `packages/coding-agent/src/step/local-update.ts` + tests | edit | vitest for local-update/update-command pass | revert file |
| 4. `.gitlab-ci.yml` `release_npm_publish` (stage publish, needs prod upload, on_success, `NPM_TOKEN`) | edit | job appears only on tag pipelines after prod upload | revert job |
| 5. README / README.zh-CN install section | edit | npm install documented | revert |
| 6. `npm run check` | bash | clean | fix |

## Setup

- Masked CI variable `NPM_TOKEN` with deploy rights on `STEP_NPM_REGISTRY`
  (2026-10-08: set from xuyunfang's personal artifactory token; replace with a
  service-account token).
- Backfill an existing release from a branch pipeline with
  `STEP_NPM_PUBLISH_VERSION=vX.Y.Z` (`release_npm_backfill`, CDN-only, no TOS).
- First publish: backfill v0.1.2.

## Status (2026-10-08)

- Steps 1-6 implemented. `node --test scripts/npm-packages.test.mjs` 3/3 pass;
  coding-agent `step-local-update` + `step-update-command` 20/20 pass; offline
  `--dry-run` (`npm pack --dry-run`) produces all 7 packages.
- `npm run check`: biome and all guard scripts pass; `tsgo` reports only the
  pre-existing `features/workflow/vm.ts` errors (quickjs deps not installed locally).
- Not verified: CI runner egress to registry.npmjs.org (unreachable from the dev
  machine), and the first real publish. Move to `done/` after the first tag publishes.
