# Step configuration files

Step creates the global `~/.stepcode/config.toml` when it first runs.
The project file `<cwd>/.stepcode/config.toml` is optional: a missing file
contributes no project settings and does not produce a startup warning.
Reading or reloading settings does not create the project file or directory.

Trusted projects can override global settings through the project file.
Explicitly saving project settings creates a valid TOML file if necessary.
Malformed TOML and filesystem errors other than a missing file are still
reported; malformed files are not overwritten by settings updates.

The retired `step-settings.json` and `settings.json` files are no longer read,
written, or covered by the project trust prompt. A project that still ships one
is ignored; move any settings it holds into the project `config.toml`.

There is no automatic import from the pre-pi `config.json` layout. `models.json`
and `auth.json` keep their own formats — they hold model definitions and
credentials, not settings — and a stale Step endpoint recorded in `models.json`
by an older release is still repaired in place at startup.

## Mandatory command approval

Permission presets and tool overrides cannot automatically approve commands
matched by the built-in command rules. In particular, `rm` with both recursive
and force options requires confirmation for every target, including `./build`
and `/tmp/cache`. Bypass, auto, and autopilot still ask for each call. Read-only
mode blocks it, and runs without an approval channel cannot execute it even
with `nonInteractiveApproval = "allow"`.

See [command permissions](command-permissions.md) for matching behavior and
how to extend the built-in rules.

## Environment and shell commands

`STEP_CODING_AGENT_DIR` selects the agent directory for CLI and SDK callers.
`STEP_CODING_AGENT_SESSION_DIR` selects session storage unless `--session-dir`
is supplied. These names are fixed; the application display name does not select
another environment namespace.

The shared runtime defaults to the `step` display name. `STEPCODE_APP_NAME`
can override the name when launched through the Step entrypoint; it does not
select commands, providers, or storage paths. Step keeps using `.stepcode`,
while shared runtime callers retain their existing storage defaults. Extension
manifest keys and package import aliases remain compatible with existing plugins.

The CLI sets `AI_AGENT=step`. Shell tools inherit the shell environment and any
explicit spawn-hook changes, without injecting session, model, or reasoning
metadata. Extensions can read that metadata from their context instead.

Terminal capabilities use automatic detection and the `terminal` settings;
`showHardwareCursor` and `terminal.clearOnShrink` default to false. There are no
environment overrides for these settings, experimental tool sampling, startup
timing, raw terminal write logs, or redraw logs. Provider cache retention defaults
to `short` and remains configurable per SDK request through `cacheRetention`.

The renderer accepts an explicit crash-log directory from its host. Standalone
Step screens pass the Step agent directory; generic TUI callers default to the
system temporary directory. Rendering equivalence tests select the uncached
renderer through a test-process argument.

## First-run theme prompt

The first interactive launch asks which theme reads best in the terminal, after
the startup login and the MCP import offer. Like that offer, it runs before the
main UI is built and owns the screen while it does, so the logo and the input
box are not painted and then replaced a frame later. Moving through the list
applies the highlighted theme immediately, and a small sample below the list
shows the syntax and diff colors. The chosen setting is written before the UI is
built, so the session opens in the theme just chosen.

Escape answers too: it takes the product default (`step-blue`, a single bright-blue
palette) and writes that. The picker lists it first as `step-blue (default)`.
The violet palettes remain available as `step-violet` and `step-violet-light`.
So the `theme` key
in the global `config.toml` is the whole record — there is no separate "we asked
you" flag, because every way out of the screen leaves a theme behind. A config
that already has a `theme`, written here or through `/settings` or by hand, skips
the prompt; deleting that line asks again. `/theme` changes the theme later, and
launches that already carry work (an initial prompt, a resumed session) skip the
prompt entirely.

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
