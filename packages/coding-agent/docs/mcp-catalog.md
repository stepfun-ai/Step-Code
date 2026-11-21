# MCP catalogs and tool discovery

Step publishes each MCP server's complete tool catalog after connecting. It follows every `tools/list` cursor, including cursors on empty pages and empty-string cursors. A repeated cursor fails the listing instead of looping. The server's `startup_timeout_sec` covers connection and initial pagination together; shutdown cancels pending discovery. No partial catalog is registered.

The interactive TUI starts before discovery finishes. Each server publishes independently after yielding to the event loop. Print, JSON, and RPC session binding waits for initial discovery to settle. Registering one server's catalog refreshes the tool registry once, regardless of its tool count.

For every catalog, `enabled_tools` is an allow list when present, and `disabled_tools` takes precedence. These filters apply before registration, including during refreshes. Registered names keep the existing `<server>__<sanitized-tool>` convention; calls use the server's original tool name.

Step listens for `notifications/tools/list_changed` from the start of the connection. Bursts are coalesced, with one listing in progress per server and a pending follow-up when notifications arrive during that listing. A successful refresh replaces the server's registered tools in one batch, adding new names, updating definitions, and removing names that disappeared. An empty successful catalog removes all of that server's tools. Pagination or output-schema preparation failures leave the previous catalog and tool count intact and produce a warning; a later notification can retry.

A closed connection removes its tools and changes its status to failed. Session shutdown removes its MCP registrations and closes the clients. Results that settle after cancellation or connection closure cannot publish a catalog. Calls already in progress retain their captured tool definition when a live catalog is updated or a tool is removed. This behavior does not add an automatic reconnect policy.

## Tool exposure

Every server tool is registered as `<server>__<sanitized-tool>`. A server's `exposure` in `config.toml` decides how the model reaches it:

| `exposure` | Behavior |
| --- | --- |
| `deferred` (default) | Registered but not declared. `find_tools` loads the matches, which become callable on the next turn. |
| `direct` | Declared like any other active tool, for small and frequently called servers. |
| `hidden` | Registered but unreachable; left out of the tool catalog. |

The optional `description` becomes the one-line summary in the `mcp_servers` system-prompt section, which lists the servers whose tools are deferred and names `find_tools` as the way to reach them. Without that section the model cannot know the servers exist, because neither `find_tools` nor the declared tool list names them.

```toml
[mcp_servers.github]
url = "https://api.githubcopilot.com/mcp/"
description = "GitHub issues and pull requests"
# exposure = "direct"
```

## find_tools

`find_tools` ranks the deferred tools plus the active ones by intent, tool name, description, and parameter names, and activates the deferred matches so the next request declares them. Activation is recorded on the tool result, so it survives resume and fork on that branch. Removed tools disappear from search. Each match includes its callable name, description, and JSON parameter schema.

The optional `ExtensionContext.getActiveTools()`, `getAllTools()`, and `setActiveTools()` accessors supply the catalog and activation through the runner's existing session actions. Direct SDK callers whose context provides only `getToolCatalog()` get the ranked answer without activation, and hosts with neither retain the builtin Step catalog fallback.

Extensions can replace part of their own catalog with the existing batch API:

```ts
pi.registerTools(nextDefinitions, { remove: previousNames });
```

Removal affects only the calling extension's registrations. Names supplied in both lists receive the new definition. The registry refreshes once after the batch, so callers see the finished replacement. Removing a winning extension definition can reveal another extension or builtin definition under the existing precedence rules. Empty batches and removal of names the caller does not own do not refresh the registry. Stale extension APIs reject the operation.

MCP input schemas pass unchanged through registration to the existing agent-core/provider argument-validation boundary. The regression tests exercise integers and bounds, nested required properties, additional properties, nullable enums, array constraints, `anyOf`, `oneOf`, `allOf`, and local `definitions`/`$defs` references. Provider coercion and optional-null handling still apply; preserving JSON Schema does not make validation a strict, non-coercing JSON Schema validator. Format and dialect support remain those of the installed validator. In particular, an unregistered custom format is retained in the schema but is not thereby enforced.

Both session tools and the one-shot remote MCP client use the same catalog and call adapters. With MCP SDK 1.27.1, `client.listTools()` replaces its cached output validators and task metadata for each page, and `client.callTool()` reads those mutable validators after receiving a response. Step stages pages with the public `client.request()` and `ListToolsResultSchema` instead. Each callable definition captures its own output validator using the SDK's public `AjvJsonSchemaValidator`, with isolated schema-ID scope. A failed refresh or a later schema using the same `$id` cannot change an older call's validation. Successful schema-bearing calls must return matching `structuredContent`; error results may omit it. Output-schema support remains that of the SDK's default validator, without a blanket guarantee for arbitrary dialects or external references.

Tools declaring required task execution continue to fail before sending a normal tool call, with an explicit task-execution error. This adapter does not implement the SDK's experimental task execution protocol. The SDK version remains 1.27.1.

Focused regressions are in `src/step/mcp-catalog.test.ts`, `src/step/mcp-startup.test.ts`, and `test/extensions-tool-catalog.test.ts`. They use a real HTTP/SSE MCP peer, the installed SDK, real session registry actions, provider argument validation, and the agent loop.
