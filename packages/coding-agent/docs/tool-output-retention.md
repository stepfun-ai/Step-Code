# Tool output retention

Coding-agent bounds the combined text in each final tool result to 2,000 lines
and 50 KiB, including its truncation notice. This applies to built-in, MCP and
extension tools, text replaced by `tool_result` hooks, validation errors and
blocked calls. Accepted `message_end` tool-result replacements are checked again
before session persistence and model replay. Images are preserved separately. Tool details, usage, error
status and termination hints retain their existing contracts.

An oversized result keeps a prefix and a `Full output:` path. The complete text
from all text blocks, joined by newlines, is saved before the preview is
published. Individual oversized lines may leave no complete line in the
preview; the full file remains readable with the normal file tools. A producer's
`truncated` metadata does not disable this final bound. Results that exceed the
limits by at most 8 lines and 1 KiB are left unchanged: built-in tools truncate
to the same limits and then append a notice and, for bash, an exit status, and
that tail must not be cut again. If a producer already lost content before
returning, this file contains only what it returned.

Artifacts live in `tool-output` under the session directory. If the session has
no storage directory, the configured agent directory (or its default) is used.
Paths in tool results are absolute JSON-quoted strings, so spaces and line breaks
in directory names do not change the notice's structure. New artifact directories are private and
files are created with exclusive creation and owner-only permissions. Each
retention operation makes a bounded best-effort pass over expired owned files;
files older than seven days may be removed. Cleanup skips unrelated names,
directories and symlinks, and a cleanup failure does not fail the tool.

If complete output cannot be saved, the result reports an output-processing
error. It states that the tool may already have run and that effects should be
checked before repeating a state-changing call. Image blocks remain available even if text retention fails. Existing denial and
termination policy remains in force. Small results create no artifact and are unchanged.

This bounds final model-facing text, not streaming progress updates or arbitrary
typed `details` payloads. No new permission bypass or external upload is added.

## Live events and the persisted stream

A session event is either a **fact** or a **frame**:

- `message_update` and `tool_execution_update` are frames. Each is a cumulative
  snapshot of in-flight work, and each one's successor (`message_end`,
  `tool_execution_end`) carries the authoritative value. A reader that skips
  every frame can still reconstruct the run exactly.
- Everything else is a fact.

The classification lives in `core/session-event-durability.ts` and is an
allowlist of frames, so a future event type is a fact unless someone says
otherwise. `--mode json` and `--mode rpc` write only facts. A host that renders a
live view — the subagent parent reading a child's pipe, a debugging session —
passes `--include-live-events`.

That is what keeps a redirected stdout log bounded by the number of facts rather
than the number of streamed tokens: a harness redirecting `--mode json` to a file
gets no progress frames at all.

A record also drops the payload a **boundary** only repeats. `turn_end` and
`agent_end` close over the messages of a turn and a run, and those messages
already arrived as their own `message_start`/`message_end` (a tool result also as
`tool_execution_end`), so the projection writes `{ messageRole, toolResultCount }`
and `{ willRetry, messageCount }` instead of repeating the arrays. Projecting the
same runs both ways, the two boundaries were **40.2%** of the record for a
100-task batch (713,553 -> 426,615 bytes) and **51.6%** for a 20-task batch with a
40,000-character answer (278,463 -> 134,739 bytes).

It is not an exactly-once record. A tool result still travels on
`tool_execution_end` plus its own `message_start`/`message_end` (3), a user
message on both of its pair (2), and an assistant message's final payload once
(1 — its `message_start` is the empty partial). Those are the begin/end pair and
the execution outcome, so removing them changes sequence semantics rather than
dropping a duplicate.

The classification and that projection meet in one function,
`toJsonEvent(event, { includeLiveEvents })` in `modes/json-event.ts`, which returns
`undefined` for a frame the caller did not opt into. Transports write
`if (projected)` rather than filtering first, because two decision points drift
apart; `check:session-event-transports` fails the build when the projection is
called outside a known transport, when a transport's call does not state the
option, or when the classification is referenced outside the projection.

Producers still bound what a frame contains, because a frame is a replacement
snapshot and re-sending accumulated state wastes the consumer's own budget:

- The subagent tool's live projection drops `messages` entirely, keeps a short
  tail of streamed text and tool output, and clips a `{previous}`-expanded task
  at both ends.
- One live roster is capped by bytes; the records that do not fit are counted in
  `omittedResults` so a renderer can still report the real task count.
- `agent-core` keeps at most one frame in flight per tool: a frame arriving while
  another is being delivered replaces it, so a slow consumer cannot make the loop
  accumulate one pending promise per token.

The terminal tool result is a summary, not a transcript: it carries `activeText`
(bounded at 50,000 characters), the failure diagnostics, and `sessionId` /
`sessionFile` for the child's own history. It does not carry `messages`.
The 128 KiB shared field budget keeps small task, output, and diagnostic floors
for every record and divides remaining bytes fairly. Floors add O(records × small)
bytes, so later tasks still render their identity, output, and failure reason.

The JSON/RPC stdout projection also caps an opted-in `tool_execution_update` at
256 KiB of serialized bytes, including JSON escaping and the envelope. Oversized
frames keep a text tail with `[live output truncated]`, drop `args`/`details`, and
clip ids and tool names. Other events, including terminal results, are untouched;
in-process subscribers do not pass through this wire backstop.

These payload bounds are a **stopgap**, not the target design. They exist because
progress currently rides the same session-event stream as facts; once it has a
channel of its own, the roster cap and `omittedResults` can be deleted. See the
follow-up section of
`docs/research/2026-10-27-subagent-live-update-amplification/README.md`.
