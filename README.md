<p align="center">
  <strong>Step CLI</strong>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/stepfun-ai/step-harness"><img alt="GitHub" src="https://img.shields.io/badge/source-open%20source-222?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

# Step CLI

## Feedback privacy

Feedback submission is disabled until `STEP_CLI_FEEDBACK_ENDPOINT` is supplied
by the host or release configuration. When submitted, the consent preview lists
the identity fields included in the report: `deviceId`, `uid`, `username`,
`channel`, `version`, `platform`, and `commit` (fields not available are shown
as unset). The fields are used to correlate a report with its client build and
account context; session bundles and diagnostics are shown separately before
submission.

Step CLI is the Step product built on the Pi runtime. The product entrypoint,
defaults, OAuth provider, harness facade, and TUI presentation are Step-owned;
the `@earendil-works/pi-*` packages remain the vendored runtime implementation
boundary so upstream-compatible imports continue to resolve.

* **[@step-harness/coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@step-harness/agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@step-harness/providers](packages/providers)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about Step:

* You can ask the agent to explain itself

## Runtime Packages

| Package | Description |
|---------|-------------|
| **[@step-harness/telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@step-harness/providers](packages/providers)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@step-harness/agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@step-harness/coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@step-harness/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
pnpm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
pnpm run build         # Refresh model data, then build all packages
pnpm run build:offline # Rebuild using existing model data without network access
pnpm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
pnpm step            # Run the Step CLI entrypoint from sources
```

Standalone Step binaries can update themselves from the published release
manifests:

```bash
step update          # Install the latest stable release
step update 0.4.0    # Install an exact stable release
step upgrade         # Alias for step update
step upgrade 0.4.0   # Install an exact release through the alias
```

Updates download and verify the platform archive directly. They do not require
`curl` or `wget`; npm/pnpm/source installations must be updated through the
tool that provided them.

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "step-${VERSION}-source.tar.gz"
cd "step-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The source archive includes the generated provider model data used for the release. `--offline-model-data` builds with that snapshot instead of refreshing it from live provider catalogs. The script still installs dependencies, builds the monorepo, compiles the Bun executable, and stages its runtime assets. Package maintainers who provide dependencies separately can pass `--skip-install --skip-deps`.

## Distribution and supply-chain hardening

We treat pnpm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during resolution, and `link-workspace-packages=true` / `prefer-workspace-packages=true` so range-specified internal packages link to local workspace source under pnpm.
- `pnpm-lock.yaml` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `pnpm run check` verifies pinned direct deps and native TypeScript import compatibility. `pnpm install --frozen-lockfile` guards lockfile drift.
- Release artifacts are standalone Step binaries and platform installers; this repository does not publish npm packages.
- `pnpm run release:local` is retained for internal runtime smoke tests and dependency validation, not for distribution.
- Internal build and smoke-test installs use `--ignore-scripts` where supported.
- CI installs with `pnpm install --frozen-lockfile --ignore-scripts`, and a scheduled GitHub workflow runs `pnpm audit --prod`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT
