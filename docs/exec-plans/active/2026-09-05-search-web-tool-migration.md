---
title: Migrate Step search_web tool
status: active
---

# Migrate Step `search_web` tool

## Step

Add the old Step CLI remote MCP `search_web` capability to the current Step tool profile. Use the logged-in Step credential or search-specific environment variables, select the MCP endpoint from the persisted Step login profile, keep the tool read-only, compact remote results, and add focused tests without changing the existing configuration migration surface.

## Tool

- Add `@modelcontextprotocol/sdk@1.27.1` to `packages/coding-agent` and refresh the npm lock/shrinkwrap without lifecycle scripts.
- Add the Step search tool and Streamable HTTP MCP invocation in the Step tool profile.
- Route `platform_oversea` login credentials to `api.stepfun.ai`, route `step_plan` and `platform_cn` to `api.stepfun.com`, and retain the test endpoint only for an unknown profile/default.
- Wire `getStepAuthPath()` from the Step entrypoint and add the tool to the Step names, prompt guidance, and read-only permission set.
- Add fake-invoker tests for credential precedence, MCP arguments/headers, result compaction, failures, and profile registration.

## Expectation

The Step session exposes `search_web`; it calls `stepsearch.web_search` with `{ query, n: 10 }`, selects the endpoint matching the persisted login profile, never embeds a search key, uses `STEP_API_KEY` or the logged-in `auth.json` credential as fallback, and passes the focused tests plus `npm run check`.

## Rollback

Revert only the search tool, profile/prompt/permission wiring, tests, and dependency metadata generated for this change. No user data or configuration files are migrated.
