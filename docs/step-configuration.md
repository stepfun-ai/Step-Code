# Step configuration files

Step creates the global `~/.step-cli/config.toml` when it first runs.
The project file `<cwd>/.step-cli/config.toml` is optional: a missing file
contributes no project settings and does not produce a startup warning.
Reading or reloading settings does not create the project file or directory.

Trusted projects can override global settings through the project file.
Explicitly saving project settings creates a valid TOML file if necessary.
Malformed TOML and filesystem errors other than a missing file are still
reported; malformed files are not overwritten by settings updates.

The retired `step-settings.json` sidecar is no longer read, written, or covered
by the project trust prompt. A project that still ships one is ignored; move any
settings it holds into the project `config.toml`.

## MCP startup in the terminal

Interactive Step sessions start MCP discovery and connections in the background.
The editor and `/mcp` do not wait for every server to finish initializing.
`/mcp` reports `connecting` until a server's tools are registered, then `connected`
with its tool count, or `failed` when initialization fails. Each server publishes
independently, so a slow server does not delay a ready server's tools.

When startup fails with HTTP 401 or an SDK authentication error, the warning
includes `step mcp login <name>`. Run that command to authenticate, then restart
Step to reconnect the server. The warning preserves the original error details.

Each server publishes its whole catalog in one registry refresh, after yielding to
terminal input, so publication cost does not grow with the number of tools. Tools
becoming available after a model request has started are available to subsequent
requests. Print and RPC sessions still wait for the initial tool catalog before
accepting work.
Closing or replacing a session cancels pending MCP connections and prevents their
late tools or warnings from reaching the new session.
