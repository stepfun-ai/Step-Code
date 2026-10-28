# JSON Event Stream Mode

```bash
step --mode json "Your prompt"
```

Outputs all session events as JSON lines to stdout. Useful for integrating step into other tools or custom UIs.

## Event Types

Wire events use `JsonAgentSessionEvent`. It matches
[`AgentSessionEvent`](https://github.com/stepfun-ai/step-harness/blob/main/packages/coding-agent/src/core/agent-session.ts)
except that streaming message updates omit cumulative snapshots, oversized tool
updates may omit arguments, and the two boundary events carry structure instead
of the messages they close over:

```typescript
type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

type JsonAssistantMessageEvent<T> = T extends { type: "toolcall_start"; partial: unknown }
  ? WithoutPartial<T> & { id: string; toolName: string }
  : WithoutPartial<T>;

type JsonAgentSessionEvent =
  | Exclude<
      AgentSessionEvent,
      { type: "message_update" | "tool_execution_update" | "turn_end" | "agent_end" }
    >
  | (Omit<Extract<AgentSessionEvent, { type: "tool_execution_update" }>, "args"> & { args?: unknown })
  | {
      type: "message_update";
      usage: Usage;
      assistantMessageEvent: JsonAssistantMessageEvent<AssistantMessageEvent>;
    }
  | { type: "turn_end"; messageRole: AgentMessage["role"]; toolResultCount: number }
  | { type: "agent_end"; willRetry: boolean; messageCount: number };
```

`queue_update` emits the full pending steering and follow-up queues whenever they change. `compaction_start` and `compaction_end` cover both manual and automatic compaction.

Other events are the session loop's own
[`AgentSessionEvent`](https://github.com/stepfun-ai/step-harness/blob/main/packages/coding-agent/src/core/agent-session.ts),
passed through unchanged except where the two sections below say otherwise:

```typescript
type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

That is the in-process shape. On stdout, `turn_end` and `agent_end` are narrowed
and the two frame types are omitted — see the two sections below.

## Facts and frames

`--mode json` writes a **record**: frames are excluded, and an event that closes
over messages reports the boundary instead of repeating them.

- **Frames.** `message_update` and `tool_execution_update` are cumulative
  snapshots of work in flight, each superseded by its successor (`message_end`,
  `tool_execution_end`). They are **not written by default**. The test is the
  successor, not the word "progress": `bash_execution_update` is a delta with no
  event that restates it, so it stays.
- **Boundaries that close over messages.** `turn_end` carries the assistant
  message and its tool results, and `agent_end` carries every message of the run
  — all of which already travelled as their own `message_start`/`message_end`
  (a tool result also as `tool_execution_end`). They are written as
  `{ messageRole, toolResultCount }` and `{ willRetry, messageCount }`: what only
  the boundary says is where it fell, not what it contained.

`messageCount` is the length of that run's `messages` array, not a checksum: the
loop can emit more `message_end` events than it lists (a resampled tool-call
leak, a throwing `shouldStopAfterTurn`), so do not use it to detect a truncated
run. A message that never got its `message_end` is the reliable signal.

What the record still repeats, deliberately:

- a **user** message is written on both `message_start` and `message_end` — that
  pair is how a reader frames it;
- a **tool result** is written on `tool_execution_end` (its execution outcome) and
  again in its own `message_start`/`message_end` — three copies in total;
- an **assistant** message's final payload appears once, on `message_end`; its
  `message_start` carries the empty partial message that streaming builds from.

Collapsing any of those changes event-sequence semantics rather than dropping a
duplicate, so it is out of scope here.

A consumer therefore reconstructs a run from `message_end` (messages),
`tool_execution_end` (tool results), and the boundaries for structure. A host
that renders a live view can opt in to frames with `--include-live-events`. That
mode is a debugging aid, not a log format: frames are frequent by design, and a
run redirected to a file will be much larger.

Whether a frame would fit is not the criterion; a written `tool_execution_update`
is still capped at 256 KiB of serialized bytes (an oversized frame keeps the tail
of its text plus a `[live output truncated]` marker, clips `toolCallId`/`toolName`,
and omits `args`/`details`).
Terminal events are never bounded. Extension handlers and in-process subscribers
(`session.subscribe`, the TUI, the SDK) always see the original event; only the
serialized stdout projection is narrowed.

See [tool output retention](tool-output-retention.md#live-events-and-the-persisted-stream)
for why the two are separated.

## Message Types

Base messages from [`packages/providers/src/types.ts`](https://github.com/stepfun-ai/step-harness/blob/main/packages/providers/src/types.ts#L134):
- `UserMessage` (line 134)
- `AssistantMessage` (line 140)
- `ToolResultMessage` (line 152)

Extended messages from [`packages/coding-agent/src/core/messages.ts`](https://github.com/stepfun-ai/step-harness/blob/main/packages/coding-agent/src/core/messages.ts#L29):
- `BashExecutionMessage` (line 29)
- `CustomMessage` (line 46)
- `BranchSummaryMessage` (line 55)
- `CompactionSummaryMessage` (line 62)

## Output Format

Each line is a JSON object. The first line is the session header:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
```

Followed by events as they occur:

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_end","message":{...}}
{"type":"turn_end","messageRole":"assistant","toolResultCount":0}
{"type":"agent_end","willRetry":false,"messageCount":2}
```

`message_update` records are delta-only. They omit both the cumulative `message` field and
`assistantMessageEvent.partial` to keep stream size linear. The top-level `usage` field contains
the latest cumulative provider-reported usage and may remain zero when a provider only reports
usage at completion. Use `contentIndex` and `delta` to assemble live text, thinking, or tool-call
arguments if needed. A `toolcall_start` event also includes the constant-sized `id` and `toolName`
fields. `message_end` contains the final authoritative message.

## Example

```bash
step --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```
