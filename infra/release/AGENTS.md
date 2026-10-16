# infra/release

Inherits the [root rules](../../AGENTS.md). This directory provides local release bundles and installer templates; see the [public-source boundary](../../docs/open-source-status.md).

## Responsibilities and entry points

- `release-bundle.mjs`: version normalization, local builds, versioned archives, SHA256SUMS, manifest / latest metadata, and installer-template rendering.
- `release-targets.json`: Darwin / Linux / Windows targets for arm64 / x64.
- `install.sh`, `install.ps1`: templates that resolve versions, download, verify, and install using an injected release base URL.
- Builds use root `scripts/build-binaries.sh`; tests live in root `scripts/release-bundle.test.mjs`.

## Boundaries and invariants

- This repository generates local artifacts only. Do not add uploads, protected tags, private CI, object-store SDKs, credentials, or internal publication services.
- When changing targets, check `release-targets.json`, the bundle's `TARGETS`, build scripts, and both installers together. Do not assume these files are generated from a single source.
- Use existing build identity for Step version / channel / commit, independently of compatibility-package versions. Keep version formats, archive names, manifest URLs, and checksums consistent.
- Preserve `tar.gz` for macOS / Linux and `zip` for Windows, with actual `step` / `step.exe` output names.
- Replace `__STEP_RELEASE_BASE_URL__` through template rendering. Tests use fake URLs; do not embed private addresses or credentials.
- Preserve platform detection, verification, failure cleanup, and PATH / installation-directory handling. Download or checksum failures must not report installation success.
- Packaging cleanup is limited to explicit artifact directories and the current temporary build directory. Installer updates follow existing target-directory handling without expanding into user configuration or unrelated files.

## Validation and documentation

- Run root `node --test scripts/release-bundle.test.mjs`.
- Check all six archive names with `node infra/release/release-bundle.mjs --version 0.1.0 --base-url https://release.example.test/stepcode --dry-run`, without starting actual publication.
- Run `bash -n infra/release/install.sh` for the shell template. Validate PowerShell changes on the corresponding platform and report any untested platforms.
- Update installation / local-build guidance; stage new files before running `pnpm run check:public-boundary`.
