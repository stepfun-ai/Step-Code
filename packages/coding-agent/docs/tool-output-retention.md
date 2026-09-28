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
