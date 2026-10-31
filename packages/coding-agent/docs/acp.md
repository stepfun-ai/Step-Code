# ACP mode

`step --mode acp` runs StepCode as an [Agent Client Protocol](https://agentclientprotocol.com/) v1 agent over stdio. The wire format is newline-delimited JSON-RPC 2.0, the same framing family as RPC mode, but the method names and payloads follow ACP.

Use this mode when an ACP client (an editor, desktop shell, or another agent host) needs to drive StepCode directly.

## Starting

```bash
step --mode acp
```

The process speaks ACP on stdin/stdout. Diagnostics and extension notices go to stderr, so stdout stays a clean JSON-RPC channel. `@file` arguments are rejected in ACP mode, just like RPC mode.

stdin is never read as a piped prompt in this mode, for the same reason as RPC mode: it is the JSON-RPC transport. Draining it would swallow the protocol stream, and a client that keeps the pipe open for the whole session would hang startup on a read that waits for `end`.

## Methods

| Method | Direction | Notes |
|--------|-----------|-------|
| `initialize` | client → agent | Negotiates protocol version, capabilities, and auth methods. |
| `authenticate` | client → agent | Completes the API-key method. The terminal method is run by the client. |
| `logout` | client → agent | Removes the stored Step credential and account session. |
| `session/new` | client → agent | Creates a session. The `cwd` must match the agent working directory. |
| `session/load` | client → agent | Loads an existing StepCode session by ACP `sessionId`, which is the StepCode session id, and replays the stored conversation as `session/update` before answering. |
| `session/resume` | client → agent | Reattaches to a session without replaying history. There is no `replayFrom` switch: the protocol makes replay `load`'s job and forbids it here. |
| `session/list` | client → agent | Lists sessions, optionally filtered by `cwd`. |
| `session/delete` | client → agent | Deletes a session file. The active session cannot be deleted. |
| `session/close` | client → agent | Cancels the active turn and frees the session, keeping it on disk. |
| `session/prompt` | client → agent | Sends one user turn. Supports text, images, resource links, and embedded resources. |
| `session/cancel` | client → agent | Notification that cancels the active turn. |
| `session/set_mode` | client → agent | Switches the permission tier. |
| `session/set_config_option` | client → agent | Changes the model, or the reasoning level when the model has one. |
| `session/set_model` | client → agent | Alias for the model half of `session/set_config_option`. Outside the v1 schema. |
| `session/fork` | client → agent | Copies a session's history into a new session and makes it active. Outside the v1 schema. |
| `session/update` | agent → client | Streaming notification for message chunks, thought chunks, tool calls, plans, mode and config changes. |
| `session/request_permission` | agent → client | Tool approval request. Offers allow-once, allow-always, reject-once, and reject-always. |
| `elicitation/create` | agent → client | Asks the user a structured question when an extension needs input. |

`session/prompt` responds only after the turn finishes, with `stopReason` set to `end_turn` or `cancelled`.

Every optional session method is advertised in `initialize` through `sessionCapabilities`. ACP gates those methods behind their capability, so a client that follows the spec will not call one that is not advertised.

## Session identity

`session/new` and `session/load` return the StepCode session id as the ACP `sessionId`. A later `session/load` can restore that id after a client restart. Loading a session whose recorded `cwd` does not match the request `cwd` is rejected.

## Prompt content

The baseline accepts:

- `text`
- `image` with base64 `data` and `mimeType`
- `resource_link`, rendered into the prompt as `[[name]](uri)`
- `resource` with inline `text` or a base64 `blob`, rendered with its contents so the model does not have to fetch it

`promptCapabilities.embeddedContext` is `true` because `resource` blocks are accepted.

A turn that fails is reported as a JSON-RPC error, not as `stopReason: "end_turn"`. A failed model call does not reject the engine's `prompt()`; it is recorded on the assistant message, and ACP v1 has no error stop reason (its `StopReason` covers `end_turn`, `max_tokens`, `max_turn_requests`, `refusal` and `cancelled`). Answering `end_turn` would tell the client the agent replied when it did not, so the error channel carries the engine's message instead. The failed assistant message stays in the session, so a client can still resume it.

## Permissions

Tool approval uses ACP `session/request_permission`:

- `allow_once` approves the pending tool call.
- `reject_once` rejects it.
- `allow_always` approves it and stops asking for the rest of the session.
- `reject_always` rejects it and stops asking for the rest of the session.
- A cancelled request rejects it.

The two `always` answers are the scope the protocol offers, so they are honoured as one flag per session rather than as a per-tool rule the protocol has no way to express. They are cleared when the active session changes, because carrying an allow across a switch would approve tool calls in a session whose user never consented to them. When both are somehow set, the rejection wins: a contradictory pair must not read as consent.

## Elicitation

`elicitation/create` is used when an extension asks the user something that a yes/no approval cannot express. Only the `form` mode is implemented; URL-based elicitation needs a client that can open a browser and report completion, which the baseline does not assume.

The client decides how much of this surface exists. A client that advertises `clientCapabilities.elicitation.form` gets real dialogs:

- extension `select()` offers the actual options, and returns the one the user picked.
- extension `input()` asks for free-form text.

A client that does not advertise form elicitation keeps the previous behavior: `select()` falls back to an allow/reject approval and returns the first option when approved, and `input()` resolves as dismissed. Both are honest about what the protocol can carry rather than guessing an answer.

## Authentication

`initialize` advertises the methods this agent can offer:

- `step_login`, type `terminal`, only when the client advertises `clientCapabilities.auth.terminal`. The client runs `step login` itself as an interactive process, which is the only way the browser flow can happen. The protocol forbids passing this method to `authenticate`.
- `step_api_key`, which the agent completes through elicitation. It asks for the account profile and the key, then writes the credential to the same store `step login` uses, so a later process finds it without asking again.

`logout` removes the stored credential and the account session. Sessions already running keep their in-memory credential until they end, because the protocol makes no promise about them and pulling it mid-turn would fail a turn that is already streaming.

When the active model is a Step model and no credential exists, `session/new`, `session/load`, and `session/resume` fail with the ACP `auth_required` error instead of letting the turn fail on the first request. Only the Step provider is gated, and only on the credential sources this product owns: `STEP_API_KEY` and the stored credential. Gating on the runtime provider snapshot would reject sessions before the first availability refresh has run, which is a startup race rather than a missing credential.

## Session modes

Modes are the Step permission tiers, which are what ACP modes describe: a named policy that changes tool availability and how much the agent may do without asking.

| Mode | Meaning |
|------|---------|
| `ask` | Ask before modifying files or running commands. |
| `approve-for-me` | Routine actions run automatically; only potentially unsafe actions and key decisions ask. |
| `full-access` | Also runs detected dangerous commands without confirmation. |

`session/set_mode` runs the same extension command the TUI runs, so the policy stays in one place. That also keeps the full-access risk confirmation, which the extension routes back through `session/request_permission` like any other approval. The current mode is reported in `session/new`, `session/load`, and `session/resume`, and a change emits a `current_mode_update` notification.

## Session config options

`session/set_config_option` exposes the selectors the session can actually change:

- `model`, category `model`. Values are `<provider>/<modelId>`. The list comes from the models the runtime can reach, so a client never offers a model that cannot be selected.
- `thinking`, category `thought_level`, only when the active model supports reasoning.

An option this session cannot change is rejected rather than accepted and ignored. The current values are reported in the session lifecycle responses, and a change emits a `config_option_update` notification.

## MCP servers

**Scope: local debugging.** `session/new` and `session/load` accept the client's `mcpServers` list. The servers are connected for that session and their tools are exposed to the model like any other MCP server, on top of the ones already in `config.toml` and plugin manifests.

This is a local debugging surface, not a second configuration path. A stdio ACP session shares one machine and one filesystem with its client, so what a client hands over is a server the user is trying out on this machine. Durable configuration stays in `config.toml` and plugin manifests, and `/mcp` plus the session status view remain the way to inspect what is actually connected.

- stdio servers (`command`, `args`, `env`) are the protocol's mandatory transport and are always accepted. In ACP v1 a stdio config carries no `type` field, so an absent `type` is read as stdio rather than rejected.
- `type: "http"` servers (`url`, `headers`) are accepted; `initialize` advertises `mcpCapabilities.http: true`.
- `type: "sse"` servers (`url`, `headers`) are accepted; `initialize` advertises `mcpCapabilities.sse: true`. The protocol marks the transport deprecated and ACP v2 removes it, but it still defines it and clients still send it, so it is connected through its own transport rather than reported and dropped. Which transport a `url` uses is read from the `type` the client named, never guessed from the URL, which cannot be told apart from a streamable-HTTP one. Headers are applied to both legs, because the stream request and the POSTs are separate. OAuth is not wired for SSE: the streamable-HTTP path owns that, so an SSE server that needs it fails at startup instead of half-working.
- A client server replaces a `config.toml` entry of the same name, so a stale global entry can be overridden per session. Plugin servers are namespaced `<pluginId>__<name>`, so they never collide with a client's names.
- A session that sends no servers starts with none of the previous client's servers.
- The unstable `acp` transport type and entries that cannot start are reported on stderr rather than dropped silently, so a missing server is visible.

## Client filesystem

`fs/read_text_file` and `fs/write_text_file` are client-side methods: the agent asks, the client answers. They are bridged into this mode's `read`, `write`, and `edit` tools, gated on what the client advertised in `clientCapabilities.fs`.

The two directions are gated independently, because ACP gates them independently. A client that offers only reads gets a bridge with only reads; writes stay local rather than failing.

Why a round-trip through the client is worth it, when the client and the agent share one filesystem:

- A client read returns the editor's buffer, including changes the user has not saved. A local read returns whatever is on disk, which for an unsaved file is the older content.
- A client write lets the client track what the agent changed, so it can show a diff or mark the file touched.

Images are the exception and stay local. The method is named `read_text_file`, so an image routed through it would come back as text and the tool would lose the bytes it needs to attach. Image paths are detected and read from disk.

Only an explicit `methodNotFound` read error falls back to the local file, with a notice on stderr. Every other read failure propagates rather than replacing the editor's current buffer with potentially stale disk content. A failed write has no fallback either: writing the same bytes once where the client can see it and once where it cannot is worse than one visible failure.

## Client terminals

`terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, and `terminal/release` are bridged into this mode's `bash` tool, gated on `clientCapabilities.terminal`. Commands then run in the client's terminal, so the user sees them where they already are.

Two details are worth knowing:

- ACP takes a program plus arguments, while the agent's command pipeline is a shell string. The resolved shell config supplies the program and its flags and the string rides as the final argument, so the client runs the same command line the local path would have.
- ACP has no push channel for terminal output, so the agent polls `terminal/output` while a command runs. Output is emitted as it appears; a buffer the client truncated from the front is not re-emitted, because that would duplicate output the accumulator already holds.

Execution falls back to the local shell only before the command starts:

- No client terminal is installed, which is every non-ACP run and every ACP client that did not advertise `terminal`.
- The resolved shell feeds the command over stdin. ACP has no channel for that, so it cannot be expressed.
- The client explicitly answers `methodNotFound` to `terminal/create`.

Any other create failure propagates instead of running the command outside the client's terminal. Once `terminal/create` has been answered the command is running, and no later failure is retried locally either. Re-running a command that already deleted a file or pushed a commit is not a fallback, it is a second side effect.

## Still not in this mode

`elicitation/complete` is not implemented: it reports which option a form field resolved to, and only a client that renders forms can answer it.

`additionalDirectories` is validated on `session/new`, `session/load`, and `session/resume` and reported on stderr when it cannot be honoured, but it does not expand the session's filesystem scope yet. A stdio session's tools resolve every path against one working directory, so extra roots would need path resolution re-plumbed through every tool. Reporting it beats staying silent, which would leave the client believing it had granted workspace roots the agent cannot reach.

`session/fork` and `session/set_model` are outside the ACP v1 schema. They are implemented because clients that talk to agents which carry them will send them. Their responses mirror `session/new` and `session/set_config_option` respectively, because there is no spec shape to follow.

## Relationship to RPC mode

ACP mode reuses the same `AgentSessionRuntimeHost` as RPC mode. Session persistence, extensions, compaction, tool execution, and provider behavior are shared. Only the protocol surface is different. RPC mode remains the lower-level JSONL channel for process integration.
