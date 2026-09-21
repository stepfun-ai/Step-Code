# Fix StepPage MCP P1 issues

## Step

Gate project-local MCP servers on project trust, drain stdio server stderr, and preserve remote MCP tool errors as failed tool results. Add focused regression coverage.

## Tool

Edit `packages/coding-agent/src/step/mcp.ts` and its tests; run the focused Vitest tests and `npm run check`.

## Expectation

Untrusted project manifests do not spawn commands, noisy MCP stderr cannot block a server, and `isError` responses remain tool failures. All checks pass.

## Rollback

Revert the implementation and test changes in the touched files and remove this plan.
