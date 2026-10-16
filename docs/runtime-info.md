# Runtime diagnostics example

`packages/coding-agent/examples/extensions/runtime-info.ts` is an opt-in extension
for inspecting the active runtime and the output-token ceilings seen at provider
request construction. Loading it alone produces no diagnostics and does not
inspect requests. It registers `/runtime-info` and its own `--runtime-info` flag;
there is no built-in runtime diagnostics flag.

## Usage

Run these commands from the repository root with `step` on your path, or replace
`step` with `pnpm step` when running from source.

```sh
step -e ./packages/coding-agent/examples/extensions/runtime-info.ts
```

Enter `/runtime-info` to display a snapshot and enable automatic reports for the
current session. Subsequent `/runtime-info` commands show fresh runtime values
and the most recent applicable request observation. `/runtime-info off` silently
stops reporting and clears that observation. Command opt-in ends on session
replacement or reload.

For headless inspection without submitting a model prompt:

```sh
step --no-session --print \
  -e ./packages/coding-agent/examples/extensions/runtime-info.ts \
  '/runtime-info' 2>runtime-info.log
```

The command uses the existing extension command path. It does not call a model,
resolve credentials, append conversation entries, start an execution turn, or
change model settings. Before an observed request, its request limits are unknown.

To enable reports from startup, including during an otherwise normal task:

```sh
step --mode json \
  -e ./packages/coding-agent/examples/extensions/runtime-info.ts \
  --runtime-info 'Explain the project structure' \
  >events.jsonl 2>runtime-info.log
```

That normal task can call a model. Adding `--runtime-info` only observes the work
already requested. The flag opts in again at every session start, including new,
resumed, forked, and reloaded sessions. `/runtime-info off` disables reports until
the next opt-in or session start when the flag is set.

The example uses the existing extension loader and type-only API imports. The
examples' native TypeScript loading behavior is unchanged; no loader flags,
transpilation setup, or dependency installation are added by this extension.

## Reports

TUI and RPC modes use `ctx.ui.notify`. Print and JSON modes emit one JSON line to
stderr per report, at most 2 KiB including the newline. The extension does not
write to stdout, so JSON events remain separate. Stderr may also contain other
CLI diagnostics; the extension's JSON objects have `"type":"runtime-info"`.

Automatic reports occur on session start, context preparation, provider request
construction, model/thinking changes, successful compaction, and tree navigation.
The schema is fixed; unavailable or rejected values are `null`:

```json
{
  "type": "runtime-info",
  "event": "before_provider_request",
  "model": {
    "id": "example-model",
    "provider": "example-provider",
    "api": "openai-responses",
    "contextWindow": 128000,
    "configuredMaxTokens": 32000
  },
  "thinkingLevel": "medium",
  "contextUsage": { "tokens": 96000, "contextWindow": 128000, "percent": 75 },
  "lastRequest": {
    "max_output_tokens": 4096,
    "max_tokens": null,
    "max_completion_tokens": null
  }
}
```

`model` describes the resolved `ctx.model`; `configuredMaxTokens` is its
`maxTokens` metadata. It is not a prediction of the next request's limit.
`thinkingLevel` is the effective level exposed by the runtime, restricted to
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. It is not provider
reasoning content or an inferred reasoning budget.

`contextUsage` comes from `ctx.getContextUsage()` and retains its estimation and
availability limits. In particular, usage can be unknown after compaction until
a later response. The extension neither tokenizes messages nor substitutes zero
for unknown usage.

`lastRequest` holds only these positive safe-integer fields, read directly from
the payload at `before_provider_request`:

| Resolved API | Allowed request fields |
| --- | --- |
| `openai-responses` | `max_output_tokens` |
| `anthropic-messages` | `max_tokens` |
| `openai-completions` | `max_tokens`, `max_completion_tokens` |

The values include adjustments already made by the provider adapter, such as
context clamping or a protocol minimum. They describe requested ceilings, not
output actually produced or a guarantee about how much text a provider returns.
If both completion fields are present, both are shown without choosing precedence.
Other APIs and absent, nested, inherited, accessor, nonnumeric, nonfinite,
nonpositive, fractional, or unsafe-integer values remain unknown. No request cap
is inferred from configured `maxTokens`.

A `null` `lastRequest` means there is no applicable observation. An object with
null fields means a request hook was observed but those fields were unavailable
or unsupported. New context preparation, model/thinking changes, compaction,
tree navigation, session start, shutdown, and explicit disable discard old
observations. Live session/model identity is also checked before reporting. A
runtime change between context preparation and request construction invalidates
that pending request observation.

## Privacy and API limits

The extension constructs reports from an explicit primitive allowlist. Model,
provider, and API identifiers must be at most 128 ASCII characters drawn from
letters, digits, `.`, `_`, `:`, `/`, and `-`, starting with a letter or digit;
URL-shaped identifiers containing `://` are rejected. Invalid identifiers are
omitted as `null`, rather than truncated or converted from objects.

It never prints headers, credentials, endpoints, prompts, message bodies,
reasoning content, arbitrary payload fields, session IDs, or session paths.
Request objects are neither enumerated nor serialized, and their getters and
`toJSON` methods are not invoked. Only the small current observation is kept in
memory; there is no persistence, telemetry collector, network client, environment
inspection, or automatic installer.

`before_provider_request` handlers run in extension load order. The ceiling is
what this extension saw at its hook position; a later handler or transport may
still alter the request. Load the example after payload-rewriting extensions
when practical. The hook does not provide a request ID, request model, session
ID, or a final-wire-payload callback, so this is a runtime snapshot, not a wire
trace. It cannot correlate concurrent custom provider calls or recover limits
from requests made before opt-in, skipped hooks, or previous sessions. It does
not intercept traffic or reconstruct requests to fill those gaps.
