# Model-managed working context

Step Code uses CLM (`clm-v1`) as its default compression mode when automatic
compaction is enabled. The model edits a validated working view of the
conversation; the canonical session history remains intact. CLM uses the
configured model and retains native summary compaction and provider-overflow
recovery as fallbacks.

## Select a compression mode

No flag or configuration change is needed to use CLM. An existing explicit
`off` or `lightweight-v1` setting is preserved. To use native compaction for one run:

```sh
step --context-projection off
```

Or in `~/.stepcode/config.toml` (project settings use the usual trust rules):

```toml
[compaction]
contextProjection = "off"
```

`clm-v1`, `lightweight-v1`, and `off` are mutually exclusive projection modes.
`lightweight-v1` selects the existing deterministic request projection. `off`
disables working-context projection and retains native automatic compaction.
Remove an explicit mode setting, select `clm-v1`, or use `/clm on` to enable CLM.
The `/clm on` and `/clm off` commands change only the current session.

If `compaction.enabled = false` and no mode is set, CLM is also disabled. An
explicit `contextProjection = "clm-v1"` keeps manual working-context edits
available while automatic maintenance remains disabled. Invalid mode values
are treated as `off`.

## Automatic CLM maintenance

With `clm-v1` and `compaction.enabled = true`, the host checks the working request
size before an ordinary prompt and between completed tool turns. A successful
final response with no queued continuation defers routine maintenance until the
next request. This avoids an unused context-edit/summary call after a completed
task, while explicit maintenance commands and error recovery keep their normal
behavior. By default it uses the original native compact trigger:
`contextTokens > contextWindow - compaction.reserveTokens`. The default reserve
is 16,384 tokens, so a 131,072-token window triggers above 114,688 tokens (87.5%).
With at least 8,000 context tokens and enough editable old text, CLM gets the first
maintenance attempt at that threshold. No `/clm-compact` command,
completed-plan signal, or reminder to the task model is needed.

The maintenance model sees the working conversation, the incoming user request
when present, and a bounded index with short numeric IDs for editable bodies.
When the session, model, working revision, system/tool definitions and canonical
history prefix still match the last actor request, the host reuses that logical
request prefix and appends only the new canonical tail, incoming user request and
maintenance instructions. The model returns JSON `{replacements: [{id, text}]}`;
no project tool calls from this maintenance response are dispatched. Unexpected
tool calls reject the attempt. This keeps the actor's system text and tool
schemas stable instead of changing the prefix for each maintenance call. Provider
serialization and actual cache hits still need to be measured.

Without a proven matching prefix (including cold/resumed sessions), the original
isolated maintenance prompt and private `apply_context_edit` tool remain the
fallback transport. Both transports use the same model-selected edits, current
short-ID map, savings gate, source binding and atomic validator. The host resolves
each offered ID to the complete ID from that request's snapshot, then constructs a draft,
checks it with the normal CLM validator, archives the old view, and resumes the
task with the accepted projection. Project tools never run in this maintenance
request. Unknown, duplicate, protected, or stale selections remain invalid.
This path replaces old plain-text bodies; ordinary/manual CLM edits retain
complete document IDs and can still remove complete old tool groups and add notes.
The index offers at most 32 bodies. Eligibility uses the maximum possible savings
from the bodies actually offered, including the index size limit. If even empty
replacements could not meet the existing savings gate, automatic maintenance is
skipped and the normal native threshold check remains available.

The default maximum is two maintenance requests (one edit plus one correction),
a 90-second wait including authentication, and 8,192 output tokens including
thinking. An automatic edit must save at least 1,024 tokens and 5% of the mirrored
context. Attempts consume a three-completed-turn cooldown, reconstructed from the
active session branch on resume. Failed, aborted, truncated, and parser-resampled
responses do not count as completed turns.

A correction keeps the original task context and includes the rejected edit
draft and error as data. It does not replay the failed maintenance response's
reasoning or signed assistant metadata, leaving more room for a corrected edit.
The first response's complete usage remains accounted for. The task's own
reasoning, protected messages, and canonical transcript are unchanged.

No edit, rejection, timeout, or provider failure falls back to one native compact
attempt at that boundary. Insufficient room for the complete maintenance request
also falls back before sending it. An actual context overflow goes directly to
native recovery.
Cancellation and pending user input interrupt maintenance and suppress fallback.
Each attempt is bound to its original session, source branch, canonical messages,
and working revision. These are checked across authentication, response, and
correction boundaries. If they change before an edit is accepted, the stale
attempt stops with `context-changed` and does not request native fallback on the
new context. Its usage and attempt records retain the source leaf ID; stale
attempts do not impose a cooldown on the new branch. Unrelated metadata appended
to the same branch does not invalidate an otherwise unchanged request.
In the terminal, automatic maintenance shows the compaction indicator; Esc
cancels it and new task input enters the ordinary steering/follow-up queue.

Defaults can be overridden independently:

```toml
[compaction.autoClm]
enabled = true
minContextTokens = 8000
cooldownTurns = 3
maxRequests = 2
timeoutMs = 90000
maxOutputTokens = 8192
minSavingsTokens = 1024
minSavingsRatio = 0.05
```

Leave `softThresholdRatio` unset to stay aligned with native compact. An explicit
`softThresholdRatio = 0.85` requests an earlier trigger at 85%; the native reserve
threshold still takes precedence if it is lower. Existing explicit percentages
remain honored; remove them to restore the inherited threshold.

Setting `compaction.autoClm.enabled = false` retains manual CLM and native
compaction. Setting `compaction.enabled = false` disables automatic CLM and
native compaction; it also disables the implicit CLM working view unless
`contextProjection = "clm-v1"` is explicitly configured. The `/clm-compact` command uses its explicit
maintenance workflow without an additional automatic request.

Maintenance adds a model call and latency. Editing an early prefix can also
reduce cache reuse, and a summary can omit useful details. Provider cache handling
and session affinity remain unchanged: an unchanged token prefix can be reused,
while the edited portion and subsequent tokens may need to be computed again.
CLM does not transplant KV state from the old text onto its replacement.
The savings threshold checks size, not semantic completeness, so actual benefit
requires paired task validation. All returned maintenance usage, including rejected and late
responses, is recorded separately and included once in session totals and the
`Tools/summaries` cost breakdown. An attempt record may initially report missing
usage when it times out; a later usage record with the same attempt ID updates
the total when the provider eventually settles. If the provider never returns
usage, the missing amount remains unknown.

With automatic maintenance enabled, ordinary task requests and context-pressure
notices direct the model to finish task tracking and return its final answer when
the requested work and checks are complete. Routine mirror bookkeeping is not a
prerequisite for completing a task. Explicit `/clm-compact` requests retain the
full editing instructions; automatic maintenance and native summary requests
use their separate instructions and cannot mark project tasks complete.

Transient provider errors use the existing bounded session retry policy. Its
defaults are three retries with a 2,000 ms exponential-backoff base. An explicit
`retry.maxRetries = 1` permits only one retry, so two consecutive 503 responses
still end the run with an error. Retrying a failed assistant response keeps
already completed tool results and does not replay those tools. Exhausted
retries remain errors even when project tests have passed; task tracking and a
final assistant response must be checked separately from functional verification.
After the service recovers, resuming the saved session and sending a continuation
can complete the remaining review and answer without restarting the task.

## Current task state after compaction

When Step task tools are active, ordinary model requests include a fresh,
read-only snapshot of the active task plan. It shows task counts and existing
IDs, statuses, short titles, and open blockers. In-progress tasks appear first;
the snapshot is limited to 24 open rows and 4,096 UTF-8 bytes, with omission
counts directing the model to `task_list` or `task_get` for more detail. IDs are
never shortened into different usable references.

This is request-local task metadata supplied by the existing extension context
hook. It works with both native compaction and CLM, and is not stored as another conversation message or included in editable CLM
mirrors. A safely reused actor prefix may retain its historical snapshot in a
maintenance request; newly appended tool results and user instructions remain
authoritative, and maintenance cannot change task status. It refreshes after task tools run and follows the active plan on resume or branch
navigation. Titles are data; the current user's request determines priorities.
Only explicit task tool calls change task status. The snapshot neither completes
tasks automatically nor creates another agent continuation when a model stops.

## Explicit and ordinary context edits

The model receives a small read-only `CONTEXT_INDEX.md` listing the largest editable
plain-text blocks and their IDs and line locations, alongside the editable
`LIVE_CONTEXT.md`. It inspects the bounded index first and reads/modifies the
current mirror in one tool call. `/clm-compact` includes this bounded index and
an example atomic edit directly in the model request, so it can submit a change
without preliminary full-file reads. The explicit command ends its maintenance
turn as soon as the host accepts the edit; queued user work and later prompts
retain the normal turn policy. This avoids copying a large mirror back into
conversation history and triggering native compaction before an edit can happen.
The host refreshes these files before
each request, the model may edit it using ordinary file or shell tools, and the
host validates the draft after the complete tool batch. An accepted revision
replaces only the history represented in that draft. New assistant responses,
tool results, and steering messages are appended exactly once.

The mirror describes the session-owned working messages. System instructions,
tool definitions, and request-local extension transforms are applied outside it.
Excluded `!!` shell output is omitted. The actual outgoing request, including
system text and tool definitions, is used for the CLM token estimate; reported
provider usage calibrates that estimate without changing historical billing.

Tool reads of the active mirror use a bounded view. A whole-file read, an oversized
range, or a large echo containing the current document's framing returns an index
of at most 4,096 bytes. This also applies to shell output that prints the current
mirror and to symlinks read through the file tool. An explicit range of at most
40 lines can return a short quoted excerpt when the complete view fits 4,096 bytes.
Both `read`'s `offset/limit` and Step `read_file`'s `start_line/end_line` are supported;
character-truncated Step output returns the index instead of an incomplete excerpt.
The view does not invite full-file pagination. Use a focused search for a missing
fact, and the current block IDs for edits.

The guard runs after ordinary tool execution and extension result hooks, before
the result enters conversation history. It preserves tool error flags and usage.
Ordinary project files, including unrelated files named `LIVE_CONTEXT.md`, retain
the normal read behavior. A local atomic read-modify-write can still read the full
file internally and return a short status; accepted edits use the normal validator.

Commands:

| Command | Behavior |
| --- | --- |
| `/clm status` | Show revision, approximate request size, mirror and archive paths |
| `/clm on` / `/clm off` | Enable or disable CLM for this session |
| `/clm diff` | Show the latest accepted edit on the active branch |
| `/clm reset` | Discard the projection and use the current canonical context |
| `/clm-compact [instructions]` | Ask the model to organize its mirror using ordinary tools |
| `/compact [instructions]` | Run the existing native LLM handoff summarizer |

State-changing CLM commands require an idle session. Resetting a projection does
not restore history already summarized by native `/compact`.

## What may be edited

The document has stable per-revision framing, IDs, and protected blocks. The model
can edit old text, remove complete old tool-call groups, and add `role=notes`
blocks with `id=new-<unique>`. Notes can grow as well as shrink.

User messages, application control messages (including goal continuation), native
summaries, and the latest assistant/tool group are protected. Retained messages
stay in their original order. Tool-call arguments, result identities, error flags,
usage, image blocks, and reasoning metadata retain their native structure. Partial
tool-group deletion, stale metadata, forged roles, or changes to protected text
reject the entire draft. A rejection retains the last valid revision.

## Native compaction and recovery

The canonical session JSONL remains the history and usage record. CLM revisions
are custom entries on the current branch. Resume, fork, and tree navigation only
use a revision whose source history matches that branch. The known distinction
between persisted failed provider responses and the live retry context is
reconciled without skipping user messages, tool results, or successful responses.
Custom-message persistence timestamps are normalized for source matching while
their content and control metadata remain part of the identity. When the native
loop resamples a response, its omitted messages are tracked explicitly so later
edits and resume still use the same source history.
Malformed saved message bodies, source hashes, or source-index lists are ignored
before activation, allowing recovery from a previous valid revision or canonical
context.

Native compaction uses its existing source-range selection, 800/800/800
head/tail/salient tool-output serialization, structured handoff prompts,
file/skill tracking, cancellation, and bounded retry flow. When CLM is active,
those ranges contain the edited working messages; new notes are included in the
summary input. The compaction entry also records the projected retained tail, so
old raw tool output does not reappear after compaction. Summary usage remains
part of the normal session totals.

Each accepted edit archives its previous editable view before activation. For
persisted sessions, these archives remain under the session's `live-context`
directory and are not subject to the seven-day cleanup of ordinary tool-output
files. The runtime removes its own mirror on disposal. Paths referenced inside
ordinary tool outputs retain their existing lifetime; archiving a view does not
extend the lifetime of an unrelated file mentioned by that view. Remote tool
backends need access to the mirror filesystem to edit it.

## Validation

The deterministic tests exercise actual AgentSession turns with controlled
provider responses and filesystem edits. They cover valid/rejected edits,
parallel tools, steering, persistence failure, retry/resume, native summary
integration, default selection, explicit overrides, and bounded fallback. Run:

```sh
pnpm --filter @step-harness/coding-agent exec vitest run \
  test/live-context-document.test.ts test/live-context-manager.test.ts \
  test/live-context-read-view.test.ts test/suite/agent-session-live-context-read.test.ts \
  test/auto-clm-options.test.ts test/auto-clm-document.test.ts test/auto-clm-request.test.ts \
  test/auto-clm-runtime.test.ts test/step-tasks-context.test.ts test/step-tasks-extension.test.ts \
  test/suite/agent-session-task-state.test.ts \
  test/suite/agent-session-live-context.test.ts test/suite/agent-session-clm-completion.test.ts \
  test/suite/agent-session-auto-clm.test.ts \
  test/context-projection.test.ts test/suite/agent-session-compaction.test.ts
pnpm --filter @step-harness/providers exec vitest run test/context-estimate.test.ts
```

Task success, wall-clock improvement, and real API cost require paired model
experiments. Compare the same model and tasks under native compaction (`off`),
lightweight projection, and default CLM, including the cost of maintenance and
summary requests. Size validation does not establish semantic losslessness or
a universal quality or speed improvement.

## Upstream attribution

The document framing and canonical hashing are adapted from
[pi-clm 1.0.0](https://github.com/lolipopshock/pi-clm/tree/b84a9d7cbb625cd39539db3bcef72ea9cc89aa89),
which implements ideas from [Context Language Models](https://arxiv.org/abs/2609.37725).
Step's validation, native compaction integration, and automatic maintenance are
implemented locally. No code from the CC BY-NC research harness is included.

The MIT notice for the adapted code is reproduced here so it is included with
source and packaged documentation:

Copyright 2026 Emanuel Casco

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the “Software”), to deal in the
Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
