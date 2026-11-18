# Saved-task execution for embedding hosts

This opt-in API separates execution of a saved task from schedule management.
It does not change the default CLI cron delivery path.

## Host contract

Import `CronExecutionScope`, `renderCronExecution` and `createStepCronExtension`
from `@step-harness/coding-agent`. Own one scope per independently admitted
session, and pass it as `executionScope` when creating the cron extension.

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

`begin` rejects overlapping runs and empty identities. Cleanup is idempotent:
an old release function cannot unlock a later execution. The scope is runtime
authorization, not persisted session state; resuming history does not re-enter
it merely because an old message contains the execution wrapper.

## Stable prefix, enforced writes

The tool list, order, descriptions, schemas and system prompt stay unchanged
when entering or leaving the scope. Like plan mode, this is a permission
restriction, not a missing capability. `cron_list` remains usable. The three
cron write tools reject at execution before approval and again after an approval
awaits, using the session identity captured before the await. A remembered tool
call or broad permission preset cannot bypass these checks. Ordinary user runs
can manage schedules again after release; user slash commands are separate from
model tool calls. While the scope is held, these tool checks also reject a user
run incorrectly admitted into the same session: the safe failure is rejection,
not permission to modify schedules. The host must hold admission until cleanup.

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
Missing or removed
skills are skipped so delivery still proceeds. A leading skill command only
expands once in the normal input path, so multiple saved skills cannot be
represented as command prefixes.

Task/skill bodies and identity attributes are XML-escaped to preserve their
wrappers. Skill blocks declare `encoding="xml"`, so the shared parser decodes
the loaded text and location once for instruction retention; unmarked blocks
keep their existing literal interpretation. The assignment explains that entities denote literal characters, not
entity-encoded task outputs. Saved task and skill files are unchanged. Hosts
should present the saved plain prompt separately from this model-facing wrapper.
HTML exports use their existing generic custom-message presentation when the
host marks the assignment for display; they do not provide specialized scheduled
assignment or multi-skill folding. Sending encoded blocks as ordinary user text
also does not opt the HTML renderer into the new parser format.
