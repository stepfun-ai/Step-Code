# Offline Session Import

`SessionImportService` discovers and imports local Codex, Claude Code, WorkBuddy and Qoder history
without starting either source agent or invoking a model. The Web settings page
uses this same service. This is history migration, not restoration of source
processes, approvals, credentials, filesystem checkpoints or hidden reasoning.

## Lifecycle

Construct the service with an explicit `agentDir`, optional `sessionRoot`, and
an optional `onPersisted` index notification callback. Hosts must call `close()`
and await it before closing their index.

1. `scan({ customRoot?, codexRoot?, claudeRoot?, workbuddyRoot?, qoderRoot?, includeArchived? })` returns opaque
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

An automatic scan replaces prior candidate capabilities. A `customRoot` scan appends
new candidates, deduplicating the same source and file path while preserving existing
candidate IDs and reviewed snapshots. It returns newly discovered candidates only, with `existingCount` reporting matched
sessions already in the list so a duplicate-only scan is not mistaken for no matches.
Submitted jobs retain their own
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
Result titles and selected destination `cwd` survive host restart. Every
per-selection imported, skipped or failed result includes the selected absolute
`cwd`, even when that directory could not be opened; it is not the source project
or a claim that a skipped existing session has that cwd. A batch-level journal
failure may have no destination. Persisted cwd values must be absolute strings
without NUL characters; invalid values reject the journal.

Older journals can recover missing cwd and title from at most the first 1 MiB of
a native session, only when its resolved path is inside `sessionRoot/imported`.
Recovery uses the native session header for cwd, `session_info` name or first user
text for title, and validated entry provenance for source. Existing metadata is
preserved. Missing, inaccessible, escaped or out-of-window metadata remains
unknown; recovery neither opens a live session nor rewrites native history.
If the index callback fails after publication, the result remains imported (or
skipped), with a warning rather than a false failure; retrying also re-notifies
the index.

## Reserved publication

A host-owned migration job can use `reserve(selections)` instead of `start()`.
Reservation pins the reviewed snapshots and freezes the final native message IDs,
timestamps and serialized bytes, without creating target files or a nested job.
Each reserved item reports its planned path and SHA-256 fingerprint; `publish()`
uses the same non-overwriting writer as ordinary imports and runs at most once.
The owning job can record its durable intent before calling it.

Always `await reservation.release()` in the owner's cleanup. Release invalidates
unpublished work immediately and waits for in-flight publication and temporary-file
cleanup. A publication that has already entered the atomic link operation may
complete; its real result must be recorded, not reclassified as unwritten. After
release settles no owned publication is still writing. The injected service still
belongs to its host, which must separately await `close()` before closing the index.

An existing target must have matching session identity and import provenance.
Unrelated, invalid, oversized (over 128 MiB), linked or unstable target files fail
verification rather than being counted as imported. The reserved item's `existing`
metadata reports the native file's actual cwd; read it after `publish()` as well,
since another publisher may win the same snapshot while the item waits. The legacy
`ImportResult.cwd` remains the requested cwd, not an assertion that an existing
session moved. Reimport never rewrites continued native history.

## Desktop scanning

Opening the migration page automatically scans the supported applications' default
projects directories. The rescan action repeats that scan; application and project
cards start collapsed. The desktop HTTP scan endpoint accepts only `includeArchived`
and rejects arbitrary source-directory overrides. There is no custom path entry in
the desktop UI. The SDK directory options above remain available for trusted
programmatic callers and isolated tests; they are not desktop input fields.

The desktop list contains only unimported candidates with a successful preview
that match the search text. Missing sources, failed discovery or previews, and
searches with no matches have no row or error hint. Technical errors and compatibility
warnings remain available through the SDK and persisted import metadata, but
are not rendered as desktop diagnostics. Failed imports retain their actual
status and appear as "Not imported"; presentation never changes a failure into
success. Polling failures retain the last known status, and failed mutations
are not retried automatically. Unavailable imported-session links suppress
technical toast messages; global authentication-expiry handling is unchanged.

## WorkBuddy and Qoder

Default roots are `~/.workbuddy/projects` and `~/.qoder/projects`. A custom root
can contain a mixture of supported formats; Qoder-specific header records prevent
its Claude-shaped messages from being misidentified as Claude Code. WorkBuddy
session status files under `sessions/` are not transcripts.

The adapters were verified against local JSONL structures on macOS. WorkBuddy
message blocks and independent tool calls/results are migrated with source IDs;
completed, failed and unknown tool outcomes remain distinct. Unsupported opaque
reasoning produces a warning rather than being guessed or decrypted. Qoder uses
the final `active-leaf` parent chain rather than the most recently stored branch.
Its runtime configuration and attachment/control envelopes are not activated;
unmigratable attachment records produce compatibility warnings. Other application
versions, encrypted/cloud-only history and restoration of live processes are not
guaranteed. Qcoder was interpreted as the locally installed Qoder product.

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

The desktop groups consecutive ordinary historical tool calls into its existing
folded process rows, including calls whose outcomes are unknown. Groups with
unconfirmed outcomes show a neutral recorded-call count rather than completion.
They never acquire a running state from a later live turn. Individual call
statuses and outputs remain readable after expansion; explicit failures and
normal turn boundaries stay separate. This is a presentation change and applies
to existing imports without rewriting or reimporting them.

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
directory levels. Discovery inspects the first 1 MiB for readable titles without
full adapter parsing, attachment loading, preview caching or source writes. It
uses explicit Claude `custom-title`/`summary` records or Codex metadata `title` /
`thread_name` (the Codex title index takes precedence), otherwise normalized first
user text, then a project/source plus ID fallback. Titles are capped at 120
characters. Fallback scan titles do not override the fully parsed preview title.
Discovery decodes only complete JSONL records. Until identity metadata is found,
it retains the existing complete-record read behavior within the 128 MiB source
cap, including metadata-bearing records over 1 MiB. A final newline is not
required. Other titles beyond the window require preview.
Symlinks are not traversed during discovery.
Codex date subdirectories can be selected directly. A selected path inside
`archived_sessions` is still excluded unless archive inclusion is enabled.

Web endpoints are specified in [the host OpenAPI contract](../../../apps/web/openapi.yaml).
They use the host's existing cookie and Origin boundary. The browser always
scans the **host** machine, not a remote browser device.
