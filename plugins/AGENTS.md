# plugins

Inherits the [root rules](../AGENTS.md). This directory contains public built-in plugin declarations; coding-agent owns runtime implementations.

## Responsibilities and entry points

- `playwright/step.plugin.json`, `steppage/step.plugin.json`: built-in plugin identity, MCP services, and provisioning declarations.
- `packages/coding-agent/src/step/plugins.ts`: manifest parsing, marketplaces, installation, contribution discovery, and the binary's embedded `BUILTIN_MARKETPLACE_FILES`.
- `packages/coding-agent/src/step/mcp.ts`, `mcp-environment.ts`, `path-containment.ts`: service connections, tool publication, effective environments, and resource path boundaries.
- Supported skill, agent, command, entry, and MCP declaration fields are defined by `StepPluginManifest` and its parsers.

## Boundaries and invariants

- Keep declarations and resources here, not a new Agent Loop, plugin loader, or permission policy. Also read the [coding-agent rules](../packages/coding-agent/AGENTS.md) when changing product integrations.
- Built-in plugin changes update both physical manifests and embedded copies / marketplace entries in `BUILTIN_MARKETPLACE_FILES`. Check source-launch and binary behavior.
- Use parser-supported fields for IDs, resource paths, commands, arguments, environments, and provisioning. Do not describe unsupported fields as effective configuration.
- Contribution paths use existing containment checks. Do not bypass plugin roots with absolute paths, `..`, or symlinks; project contributions follow the project trust gate.
- Resolve environment variables against the effective MCP launch environment. Declare required variable names without hardcoded tokens. An installed manifest does not mean its executable or valid credentials are ready.
- Built-in preinstallation preserves user uninstall markers and provisioning lifecycles. Manifest refreshes must not resurrect plugins the user uninstalled.
- Publish MCP catalogs through existing batch registration and session lifecycles. Canceled / shut-down sessions must not register late tools into new sessions; calls still pass through product permissions and output-retention boundaries.
- Public plugin declarations must not carry private endpoints, internal resources, user configuration, or real credentials.

## Validation and documentation

- From `packages/coding-agent`, run `pnpm exec vitest --run test/step-plugins.test.ts`; MCP integration changes also select corresponding mock regressions.
- Check JSON syntax, supported fields, and consistency between both forms of built-in declarations. Tests must not connect to real MCP services or automatically download / run installers.
- Run root `pnpm run check` after product-code changes. Stage new files before running `pnpm run check:public-boundary`.
- Update [MCP catalogs](../packages/coding-agent/docs/mcp-catalog.md) and [Step integration](../packages/coding-agent/docs/step-integration.md).
