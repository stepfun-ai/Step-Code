# Offline Session Import

`SessionImportService` discovers and imports local Codex and Claude Code history
without starting either source agent or invoking a model. The Web settings page
uses this same service. This is history migration, not restoration of source
processes, approvals, credentials, filesystem checkpoints or hidden reasoning.

## Lifecycle

Construct the service with an explicit `agentDir`, optional `sessionRoot`, and
an optional `onPersisted` index notification callback. Hosts must call `close()`
and await it before closing their index.

1. `scan({ codexRoot?, claudeRoot?, includeArchived? })` returns opaque
   candidate IDs and per-source errors. Default roots honor `CODEX_HOME` and
   `CLAUDE_CONFIG_DIR`; otherwise they are `~/.codex` and
   `~/.claude/projects`. Codex archives and child sessions are excluded by
   default. Claude has no universally recognized archive flag; only explicit
   supported metadata is interpreted, never inactivity.
2. `preview(candidateId)` reads a stable snapshot and returns its fingerprint,
   bounded text excerpt, counts and compatibility warnings. It retains an
   immutable, in-memory copy of the reviewed messages and embedded attachments.
   It does not create or open a target session.
3. `start([{ candidateId, fingerprint, cwd }])` accepts at most 100 selections
   and returns a job. `cwd` must resolve to an existing absolute directory.
4. `getJob(id)` and `listJobs()` return durable, per-session outcomes.
   `cancel(id)` stops remaining work between sessions; poll for settlement.

A scan replaces prior preview capabilities; submitted jobs retain their own
reviewed snapshots and selection copies. Import uses exactly the reviewed
snapshot, even if the source continues writing or its attachments change.
Preview again to include later source changes. Unsubmitted previews expire after
15 minutes or host restart and can be evicted under cache pressure. The cache
holds at most 256 MiB of serialized UTF-16 data; submitted snapshots are pinned
until their jobs settle. Expired or evicted previews require another preview,
never an implicit re-read at import time.
An identical source ID and snapshot generates the same target ID, so
reimport never overwrites an existing target, including one continued in StepCode.
A changed snapshot generates a new copy. Target publication uses an exclusive
temporary file and an atomic, non-overwriting hard link on the same filesystem.
Filesystems without hard-link support fail visibly. Completed imports remain
when a batch is cancelled. A restarted host marks unfinished journals interrupted;
re-scanning and retrying safely skips already published snapshots.
Result titles survive host restart. If the index callback fails after publication,
the result remains imported (or skipped), with a warning rather than a false
failure; retrying also re-notifies the index.

## Compatibility

The adapters support Codex response-item JSONL, including paginated-mode rollout
records, independent function calls/results, source compaction summaries and
rollback events; and Claude message chains, content blocks and tool-result
envelopes. Tool names are retained, not renamed to apparently equivalent native
tools. Unknown Codex record formats fail rather than silently declare success.
Unsupported Codex item types remain quoted historical text and produce warnings.
Claude non-message metadata is not replayed. Its source compaction boundaries
are not reconstructed; only messages reachable from the selected parent chain
are migrated. Real Claude installations and versions outside the fixtures still
require acceptance testing; this is not a lossless source-state backup.

Imported entries carry an optional `imported` provenance object. Native context
projection converts historical tool calls/results to text evidence; it does not
restore their execution protocol. Tool results explicitly carry completed,
failed or unknown status into new requests; absent source outcome information
is never interpreted as success. Imported assistant messages do not select the
new session's model. Usage ledgers exclude imported entries; source numeric usage,
when available, remains provenance, not newly incurred StepCode usage. Internal
zero usage required by the native assistant wire type is not a source measurement.

Source system/developer messages and host control envelopes are not activated.
Encrypted reasoning is omitted with a warning. Plain reasoning summaries can be
retained as historical text. Valid source compaction summaries affect only the
request context; preceding imported entries remain readable. Supported images
in Codex `replacement_history` survive as provenance-marked
`stepcode.imported-compaction-attachments` custom messages after the compaction.
These retain captions and enter model context without introducing synthetic user
turns into source rollback accounting. Unsupported or missing retained images
produce the same attachment warnings as ordinary messages. Continuing a long
session may invoke StepCode's normal model-backed compaction, independently of
the offline import operation.

Inline supported images and image files contained in the selected source root
are embedded in the target. Local images are capped at 20 MiB each and 32 MiB
total, with MIME detection and fingerprinting. External paths, missing images and
remote URLs are not fetched and are reported. Project files are not copied.
Source sessions are capped at 128 MiB; discovery at 5,000 candidates and 16
directory levels. Discovery reads complete JSONL records in bounded chunks until
metadata is found, within the source size limit. Claude metadata may share a
record larger than 64 KiB with message content; a final newline is not required.
Symlinks are not traversed during discovery.
Codex date subdirectories can be selected directly. A selected path inside
`archived_sessions` is still excluded unless archive inclusion is enabled.

Web endpoints are specified in [the host OpenAPI contract](../../../apps/web/openapi.yaml).
They use the host's existing cookie and Origin boundary. The browser always
scans the **host** machine, not a remote browser device.
