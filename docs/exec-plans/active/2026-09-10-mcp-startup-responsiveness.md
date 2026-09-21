# MCP startup responsiveness

This is the startup-specific execution and verification record. The current
overall scope, decisions and remaining acceptance work are maintained in
[the unified config/MCP plan](2026-09-09-unified-step-config-mcp.md), updated
2026-09-10. This record does not imply the entire config/OAuth feature is complete.

## Step
Move TUI MCP discovery and connection out of the awaited session_start path.
Publish each server independently, yield between dynamic tool registrations,
and cancel pending connections on shutdown. Keep headless startup awaiting tools.

## Tool
Update the Step MCP extension and connection cleanup; use controlled slow MCP
fixtures to test startup, publication, cancellation and terminal input latency.
Run focused tests and npm run check; document the runtime timing contract.

## Expectation
TUI accepts input and /mcp while a server initializes. Fast servers publish
without waiting for slow peers. Tool registration yields for input processing.
Shutdown prevents late tools/notifications and closes pending connections.

## Rollback
Revert only this change's MCP lifecycle edits, tests and documentation, preserving
the ongoing TOML/OAuth work and staged changes.

## Verification
The awaited session_start barrier and per-tool synchronous Step prompt rebuilds
(including git symbolic-ref/status) were identified in the startup path. Codex's
connection manager spawns individual startup tasks and its join summary separately.

Focused regression tests cover background TUI startup, independently ready peers,
yielding during publication, cancellation and unchanged headless waiting. Five
test files pass (37 tests); npm run check passes.

A real PTY running the source CLI against a local stdio MCP delayed tools/list by
4 seconds and then returned 140 tools. Continuous input probes measured maximum
echo latency of 6.6 ms while waiting and 162 ms after catalog publication began.
No model requests or external MCP calls were made for this verification.

An isolated profile of 140 Step prompt rebuilds in this worktree took 3972 ms
synchronously, explaining why the previous uninterrupted registration loop froze
keyboard echo. This profile measures the prompt path, not total CLI startup time.
