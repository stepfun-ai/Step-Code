# StepPage MCP port

## Step

Load installed declarative MCP plugins in Step Harness, start their stdio
servers, expose their tools to the agent, and inject the logged-in Step API key
as `STEPFUN_API_KEY` without persisting a second copy.

## Tool

Add the MCP SDK dependency and a Step MCP extension. Discover installed plugin
manifests under the Step plugin directory, connect declared stdio servers on
session start, register remote tools, and close them on session shutdown. Keep
the existing `steppage` manifest and installer contract.

## Expectation

An installed `steppage` plugin starts `steppage-mcp`, exposes its deployment
tools, and receives the Step login key when no explicit key is configured.
Connection failures remain non-fatal and are reported in the UI. `npm run
check` and focused MCP tests pass.

## Rollback

Remove the new MCP extension, dependency, tests, and this plan. Existing plugin
manifest discovery and slash commands remain usable without the bridge.
