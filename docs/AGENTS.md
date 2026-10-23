# docs

Inherits the [root rules](../AGENTS.md). This directory maintains repository-wide runtime contracts and topic guides. Package APIs and examples remain in their owning packages.

## Responsibilities and entry points

- `development.md`, `testing.md`: coding conventions, collaboration, failure handling, and validation selection.
- `step-configuration.md`, `step-unified-config-and-mcp.md`: configuration, directories, trust, and MCP startup / write contracts.
- `command-permissions.md`: command analysis and product approvals. `orchestration-lifecycle.md`, `goal-lifecycle.md`: orchestration and goal lifecycles.
- `feedback-report.md`: what a user feedback report carries, its bounds and redaction, and the host integration contract.
- `tui-rendering-pipeline.md`, `step-goal-ui.md`: CLI UI and terminal rendering integration.
- `open-source-status.md`, `THIRD_PARTY_PROVENANCE.md`: public-source boundaries and third-party provenance.
- Other topic / research documents must state their scope in the title and text; they do not automatically define current implementation rules.

## Boundaries and invariants

- Verify paths, exports, package names, defaults, configuration precedence, and commands against current source, manifests, and tests. Do not present old designs, research findings, or proposed work as implemented behavior.
- Root docs explain cross-module contracts. Packages own their SDK, extension, session, and tool guides; avoid duplicate defaults and API definitions.
- Distinguish configuration directories, user / project scopes, trust, missing / invalid / I/O errors, and writes under locks accurately.
- Lifecycle guidance explicitly covers cancellation, failure, retries, recovery, session replacement, and late background events. UI wording alone does not define runtime state.
- Permission guidance follows current presets and risk acknowledgments, including the Full Access exception. Do not describe incomplete analysis as safe or as a matched dangerous rule.
- Use relative links to repository files and resolvable example paths. Update references when source entry points move.
- Do not copy internal execution records, private CI / release procedures, endpoints, credentials, or unpublished implementations. Public examples use fake data and follow the [public boundary](open-source-status.md).

## Validation and documentation

- For documentation-only changes, check every added / modified link, source entry point, and command, then run `git diff --check`.
- Run root `pnpm run check:public-boundary` after staging new files so the tracked-tree check includes them.
- Use relevant module tests for examples involving executable code or protocols. Before submitting a PR, run repository checks required by [CONTRIBUTING.md](../CONTRIBUTING.md).
