# Settings

Step uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.stepcode/agent/settings.json` | Global (all projects) |
| `.stepcode/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options. To save startup model defaults interactively, use `/model` and press Enter on the desired model. To save the startup thinking level, use `/effort` and press Enter.

## Project Trust

On interactive startup, step asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` or `.claude/skills` and has no saved decision for the folder or a parent folder in `~/.stepcode/agent/trust.json`. Trusting a project allows step to load `.stepcode/settings.json` and `.stepcode` resources, install missing project packages, and execute project extensions.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.stepcode/agent/settings.json`, or change it with `/settings`.

`step config` and package commands use the same project trust flow, except `step update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.stepcode/agent/trust.json` only; the current session is not reloaded, so restart step for changes to take effect.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Startup provider (e.g., `"anthropic"`, `"openai"`; saved with Enter in `/model`, or edited manually) |
| `defaultModel` | string | - | Startup model ID (saved with Enter in `/model`, or edited manually) |
| `defaultThinkingLevel` | string | - | Startup thinking level (saved with Enter in `/effort`, or edited manually): `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` |
| `modelThinkingLevels` | object | - | Per-model startup thinking levels keyed by `"provider/modelId"`; configure from `/settings` → Default thinking level per model or edit manually |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `showCacheMissNotices` | boolean | `false` | Show transcript notices for significant prompt-cache misses and compaction or branch-summary usage |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level. Anthropic, Google, and Bedrock use these natively. OpenAI-compatible models use them when `compat.thinkingTokenBudgetField` (or `supportsThinkingTokenBudget`) is set. |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `externalEditor` | string | `$VISUAL`, then `$EDITOR`, then Notepad on Windows or `nano` elsewhere | Command for Ctrl+G external editor; takes precedence over environment variables |
| `quietStartup` | boolean | `false` | Hide startup header |
| `defaultProjectTrust` | string | `"ask"` | Fallback project trust behavior: `"ask"`, `"always"`, or `"never"`. Global setting only |
| `collapseChangelog` | boolean | `false` | Show condensed changelog after updates |
| `enableAnalytics` | boolean | `false` | Opt-in analytics data sharing. |
| `trackingId` | string | - | Analytics tracking identifier, generated when `enableAnalytics` is turned on |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `outputPad` | number | `1` | Horizontal padding for user messages, assistant messages, and thinking (0 or 1) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `showHardwareCursor` | boolean | `false` | Show the terminal cursor while TUI positions it for IME support |
| `tuiMode` | string | `"regular"` | Interactive TUI mode: `"regular"` or experimental `"fullscreen"`. Changes from `/settings` apply immediately; `--tui-mode` overrides this setting at startup |
| `fullscreenExitOutput` | string | `"transcript"` | Fullscreen exit output: `"transcript"` prints the final transcript and resume hint, while `"resume-hint"` restores the previous screen and prints only the resume hint. Has no effect in regular TUI mode |
| `fullscreenScrollbar` | string | `"auto"` | Fullscreen transcript scrollbar: `"auto"` shows it temporarily while scrolling, `"always"` reserves the rightmost column and keeps it visible, and `"hidden"` hides it. Has no effect in regular TUI mode |
| `fullscreenCopyOnSelect` | boolean | `true` | Automatically copy selected text in fullscreen mode. When disabled, selections stay highlighted and `Ctrl+X` copies the active selection |

For VS Code, include `--wait` so step resumes after the editor exits:

```json
{
  "externalEditor": "code --wait"
}
```

### Network

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `httpProxy` | string | - | HTTP proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY`. Global setting only. |

```json
{
  "httpProxy": "http://127.0.0.1:7890"
}
```

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |
| `compaction.contextProjection` | string | `"clm-v1"` | CLM working view; `off` selects native compaction, `lightweight-v1` selects deterministic projection |
| `compaction.autoClm.enabled` | boolean | `true` | Attempt bounded CLM maintenance before native compaction |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.rateLimitMaxRetries` | number | `3` | Independent 429 retry budget per model request (0 disables, maximum 20); does not consume schema or other transient retries |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | `0` | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs`, the request fails immediately with an informative error instead of waiting silently. Set it to `0` to disable the limit.

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are explicitly needed. Setting it above `0` can make SDK/provider retries handle out-of-usage-limit errors before Step sees them, which may block the agent until the provider quota resets in some circumstances.

Temporary 429/concurrency errors retry the current model request, preserving completed tool calls. They honor `Retry-After` when available; otherwise delays grow from 1 second to at most 30 seconds with jitter. Cancellation interrupts the wait. Explicit billing/quota exhaustion is not retried. `retry.enabled: false` disables both session retry budgets.

### Workflow concurrency and failures

The harness does not pattern-match requests such as `开10个子agent` / `launch 10 subagents`; the model decides whether they call for the `subagent` tool's parallel mode or a workflow, and whether the message is a request at all. The `subagent` tool accepts batches larger than its concurrent window (up to 1000 by default) and queues the excess. Its children and workflow nodes take slots from the same process-wide admission window, so running both at once cannot exceed the host ceiling, and a 429 seen by either lowers it for both.

The workflow ceiling is `max(1, min(16, CPU count - 2))`. Model-authored `maxConcurrency` can only lower this ceiling. Set `STEP_WORKFLOW_CONCURRENCY_LIMIT=8` to impose a lower trusted provider limit (for example, a backend allowing eight simultaneous requests). The effective ceiling is the minimum of the machine and configured limits; the final result reports requested, effective, and current concurrency.

Rate limits are recognized from the provider's structured classification (HTTP 429 or a rate-limit error code), never from text: error messages, agent output, and node labels that mention "429" or "rate limit" are not treated as congestion, and a 429 whose error code reports exhausted quota or billing (`insufficient_quota`, `GoUsageLimitError`, HTTP 402) is terminal. Temporary 429s reduce the admission cap by 25% (minimum one), once per congestion epoch. New nodes wait during backoff; running nodes keep their slots and retry their current request. Four successful responses allow a one-slot recovery when work is queued. Concurrent workflows share a process-wide host window, in addition to each run's lower limit. This conservatively covers all model overrides; it is not a cross-process/account-wide quota lock.

A node's own retry honors the server's `Retry-After` verbatim, however large, including when the provider's own `maxRetryDelayMs` cap rejected the wait. The admission cooldown that follows a 429 is capped at 30 seconds, because that window is process-wide and its queue time is excluded from node timeouts: an unbounded server delay would otherwise stall unrelated workflows with no error and no timeout. The cap reduction above, not the cooldown length, is what protects the provider.

`parallel()` accepts both lazy functions (`parallel(items.map(x => () => agent(String(x))))`) and eager promises (`parallel(items.map(x => agent(String(x))))`). Always await or return the operation. Invalid entries reject the batch. A script error or an early return with unfinished calls cancels running and queued nodes and waits for cleanup before publishing the terminal state; production child processes retain their shared slots until they exit. The UI shows concurrency clamping as a Notice, and script failure/cancellation separately.

Node timeouts cover model requests, tool execution, and retries **after admission**, not time waiting in either queue. Tokens a node reports after it is cancelled or timed out (within the cleanup grace) are still charged to the budget. The deadline is armed per schema attempt, so a node retried for schema mismatches can take up to three times `agentTimeoutMs`. For experiments that report sleep durations or random choices, generate, capture and print all required values in one command, then require structured output with `agent(..., {schema})`. An empty sleep output is not evidence of the chosen duration. See [Workflow experiments](workflow-experiments.md).

Failed nodes are retained in the journal and final `failures` list even if the script catches errors or filters `parallel()`'s null results. Final status is `partial_failed` for mixed outcomes and `failed` when all nodes fail; both are error tool results with successful output preserved. `summary.completed` counts successful/cached nodes, not attempted calls. Request retry counts (`rateLimitRetries`) are separate from schema `attempt`.

A callback that catches an agent-node failure and rethrows a **new** error is counted twice, as one failed node and one callback failure, because the node-failure marker travels with the original error object. Rethrow the caught error itself to keep a single count. The shared admission window covers concurrent workflows. When the last one finishes, a window that was never throttled is discarded; a window that was lowered or is cooling down after a 429 is remembered for 60 seconds, so back-to-back workflows do not restart at the full ceiling straight after a 429. After that it starts fresh.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"auto"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, `"websocket-cached"`, or `"auto"` |
| `httpIdleTimeoutMs` | number | `300000` | HTTP header/body idle timeout in milliseconds, also used by providers with explicit stream idle timeouts. Set to `0` to disable. |
| `websocketConnectTimeoutMs` | number | `15000` | WebSocket connect/open handshake timeout in milliseconds for providers that support WebSocket transports. Set to `0` to disable. |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `terminal.showTerminalProgress` | boolean | auto | Show an OSC 9;4 busy indicator on the terminal tab while the agent works or compacts. Unset enables it in Otty and Ghostty only, outside tmux/screen; set `true` to force it in other terminals that support OSC 9;4, `false` to disable |
| `terminal.hyperlinks` | boolean or `"auto"` | `"auto"` | Override OSC 8 hyperlink support (advanced, JSON-only) |
| `terminal.images` | string or boolean | `"auto"` | Override image protocol support with `"kitty"`, `"iterm2"`, `false`, or `"auto"` (advanced, JSON-only) |
| `terminal.trueColor` | boolean or `"auto"` | `"auto"` | Override truecolor support (advanced, JSON-only) |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max. Applies to `@file` attachments, `read`, and images returned by tools |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

Changing terminal progress in `/settings` applies immediately. Disabling it clears any active indicator and stops its keepalive; agent and compaction completion always clear progress even if the setting changed during the operation.

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows); supports a leading `~` for the home directory |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

Windows paths in JSON must use forward slashes or escaped backslashes:

```json
{
  "shellPath": "C:/Program Files/Git/bin/bash.exe"
}
```

```json
{
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
}
```

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. User-scoped npm packages install under `~/.stepcode/agent/npm/`; project-scoped npm packages install under `.stepcode/npm/`. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

### Tools

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultTools` | string[] | - | Built-in tools enabled initially. When omitted, Step uses its standard defaults |

`defaultTools` selects the built-in tools enabled at startup. Extension and SDK custom tools remain enabled. Available built-ins are `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`:

```json
{
  "defaultTools": ["bash", "edit", "write"]
}
```

On Windows, select `powershell` instead of `bash`, or include both:

```json
{
  "defaultTools": ["read", "powershell", "edit", "write"]
}
```

An empty array starts with no built-in tools while preserving extension and SDK custom tools. `--tools` replaces this behavior with a strict allowlist for all tools, `--no-tools` disables all tools, and `--no-builtin-tools` disables the built-in defaults. `--exclude-tools` filters the resulting list. A project `defaultTools` array replaces the global array.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".stepcode/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `STEP_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.json.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |
| `markdown.mermaid` | string | `"streaming"` | Mermaid rendering mode: `"off"`, `"final"`, or `"streaming"` |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.stepcode/agent/settings.json` resolve relative to `~/.stepcode/agent`. Paths in `.stepcode/settings.json` resolve relative to `.stepcode`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["step-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "step-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "modelThinkingLevels": {
    "anthropic/claude-sonnet-4-20250514": "high"
  },
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["step-skills"]
}
```

## Project Overrides

Project settings (`.stepcode/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.stepcode/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .stepcode/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```

### Model-managed context

`compaction.contextProjection` defaults to `clm-v1` when automatic compaction is
enabled. It also accepts `off` (native compaction) and `lightweight-v1`
(deterministic request projection); explicit settings remain unchanged.
Default CLM maintenance inherits native compaction's
`contextWindow - compaction.reserveTokens` threshold and falls back to native
compaction if no valid useful edit can be accepted.

`compaction.autoClm.enabled = false` disables automatic CLM maintenance while
retaining the working view, manual edits, and native compaction.
`compaction.enabled = false` disables automatic compaction and implicit CLM.
An explicit `contextProjection = "clm-v1"` retains manual CLM with automatic
compaction disabled. See [Model-managed working context](context-management.md)
for commands, maintenance bounds, cache behavior, and recovery.
