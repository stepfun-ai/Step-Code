# Scheduled-task execution

A fired scheduled task is one execution of an existing task, not a request to
schedule it again. `createStepCronExtension` delivers every job it fires this
way, and embedding hosts that admit saved tasks themselves use the same pieces:
`CronExecutionScope` and `renderCronExecution`, both exported from
`@step-harness/coding-agent`.

## Default delivery

Each `fire` delivery carries a fresh `runId`, also recorded as the job's
`lastRunId` for host-bound (schema v2) records. The extension:

1. appends a displayed `step-cron` custom message whose stored content stays
   `[cron] <prompt>`, with `details` (`kind: "fire"`, `id`, `runId`, `prompt`
   and the schedule fields). Transcript, tree, search, HTML export and RPC
   clients therefore present the saved prompt as before;
2. projects that message for the model through its `context` handler, replacing
   the content with `renderCronExecution` built from `details`. The projection
   is deterministic, so every request in the run carries the same assignment.
   Only messages whose content is still `[cron] <prompt>` are projected:
   earlier messages without `kind: "fire"` and host-written assignments pass
   through unchanged. Compaction and branch summaries, maintenance requests and
   side questions read the stored `[cron] <prompt>`;
3. enters its own scope for the session before sending and releases it on
   `agent_settled` (full settlement, after retries and compaction recovery) or
   `session_shutdown`. The idle gate admits a job only when no run is active
   and no user input or decision is pending, so the message starts a new run.
   If sending throws or the session is still idle afterwards (the message was
   queued behind a decision), the scope is released at once.

While the scope is held, `cron_create`, `cron_update` and `cron_delete` reject
in that session. Input the user sends during the fired run joins that run and is
subject to the same rejection; schedules can be changed again once it settles.
Reloading extensions mid-run starts a fresh extension with no held scope. A
missed one-shot notice is a report, not an execution, and is not scoped.

## Host-owned admission

A host that admits saved tasks itself passes its own scope as
`executionScope`. The extension then gates writes with that scope and does not
enter or release it; the host owns both.

1. Wait for session startup and admit the scheduled input only while idle, with
   no pending user messages or user decisions. Do not apply this scope to a
   user run already in progress.
2. Call `scope.begin(session.sessionId, runId)` and retain its release function.
3. Append `renderCronExecution(job, runId, discoveredSkills)` as the scheduled
   message, using the normal session execution path.
4. Keep the scope and admission held through full settlement, including retries
   and compaction recovery. Release in `finally`, on success, failure or
   cancellation. `agent_end` alone is not full settlement. A host using
   `sendCustomMessage` must await `waitForIdle()` as well before releasing.
5. On session replacement or shutdown, settle/cancel the old run before
   releasing it. Recreated extensions must receive the same active scope until
   that execution is settled. A new session has its own authorization.

`begin` rejects overlapping runs, naming the active session and run, and empty
identities; in the default path an overlapping fire is reported as a delivery
failure and retried. Cleanup is idempotent: an old release function cannot
unlock a later execution. The scope is runtime authorization, not persisted
session state; resuming history does not re-enter it merely because an old
message contains the execution wrapper.

## Stable prefix, enforced writes

The tool list, order, descriptions, schemas and system prompt stay unchanged
when entering or leaving the scope. Like plan mode, this is a permission
restriction, not a missing capability. `cron_list` remains usable. The three
cron write tools reject at execution before approval and again after an approval
awaits, using the session identity captured before the await. A remembered tool
call or broad permission preset cannot bypass these checks. User slash commands
are separate from model tool calls.

This avoids cache invalidation caused by changing the tool/system prefix. It
does not guarantee a cache hit: provider policy, retention, model changes,
compaction and other context changes still matter. Run identity and task text
are appended messages, never part of the system or tool definitions.

## Assignment contents

The wrapper names the task and run, states that this is one execution of an
existing task and forbids schedule changes. Real cron expressions emit `cron`;
explicit intervals emit `interval-hours`; absolute one-shot times emit
`run-at-ms` (epoch milliseconds), not their fallback cron expression.

Selected readable skills are expanded as leading individual blocks before the
assignment. The shared compaction collector retains every block's full decoded
instructions and file location, even when the generated summary omits them.
Missing or removed skills are skipped so delivery still proceeds. A leading
skill command only expands once in the normal input path, so multiple saved
skills cannot be represented as command prefixes. The default delivery path
has no skill catalog and expands none.

Task/skill bodies and all wrapper attributes are XML-escaped to preserve their
wrappers. Skill blocks declare `encoding="xml"`, so the shared parser decodes
the loaded text and location once; unmarked blocks keep their literal
interpretation. Only encoded blocks chain: after an unmarked block, the rest of
the message is user text even if it resembles another skill, so ordinary skill
invocations retain exactly one block. The assignment explains that entities
denote literal characters, not entity-encoded task outputs. Saved task and
skill files are unchanged. The HTML export parser accepts the same encoded form.
