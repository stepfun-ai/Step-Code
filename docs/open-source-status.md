# Open-source repository status

This branch is the public source view of StepCode. It contains the product
source, public tests, local build tooling, and the workflows needed to validate
contributions. It intentionally does not contain private repository automation
or release publication credentials.

## Public boundary

The following responsibilities stay outside this repository:

- creating protected release tags;
- uploading binaries, manifests, or model catalogs to object storage;
- publishing release announcements through private services;
- private observability implementations and private endpoint values;
- internal execution plans and repository-only release instructions.

The public tree may still build a bundle locally. `infra/release/release-bundle.mjs`
only creates local archives, checksums, manifests, and rendered installer
templates; it does not upload or publish them.

## Boundary checks

`pnpm run check` includes `scripts/check-public-boundary.mjs`. The check scans
the tracked source view for private CI/release paths, private hostnames,
object-store SDKs, and private CI variables. Its `--self-test` is included in
`pnpm run test:scripts`, so the detection logic is exercised in CI as well as
when it is run directly.

When adding a release or CI integration, keep its public/local part in this
tree and place credentials, protected tag operations, and publication steps in
the separate release environment. Do not reintroduce private paths or values
to make a local check pass.
