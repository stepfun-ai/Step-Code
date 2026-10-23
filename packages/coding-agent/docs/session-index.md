# Session index

The session index is a derived SQLite database for session lists and full-text search. Session JSONL files stay the only authoritative data: the index only reads them, and deleting it loses nothing but the time to rebuild it.

## Storage and lifecycle

| Item | Value |
| --- | --- |
| Location | `<agentDir>/index/session-search.v1.db` (plus `-wal` / `-shm`); the schema major is part of the name |
| Engine | Built-in `node:sqlite` with FTS5 `trigram`; no extra dependency |
| Owner | One worker thread per process holds the only connection. The CLI does not open the index during interactive or print sessions; only `step session-index` and hosts that call `openSessionIndex()` do |
| Roots | `<agentDir>/sessions` and any directory added with `addRoot()` or found holding a persisted file |
| Ownership check | `PRAGMA application_id` (`STCX`); a file without our id is never modified and the index runs degraded |
| Damaged file | Unreadable, missing tables, or `schema_major` disagreeing with the name: moved aside as `session-search.v1.db.corrupt-<time>` (one kept) and rebuilt |
| Schema upgrade | Incompatible layout: new file name, the old file is left alone. Older minor (`user_version`): migrate in place. Newer minor: use known columns, no migration. Tokenizer change: rebuild FTS tables from `entries` without rereading JSONL |
| Projection change | `projector_version` per source; older sources are reprojected on the next reconcile. Rows from a newer projector are left as is, and an older binary appending to one marks it for reprojection |
| Metadata | `index_meta` holds `schema_major`, `fts_definition`, `projector_version`, `backfill_state`, `last_reconcile_at` |

## What is indexed

| Source | Indexed text |
| --- | --- |
| `message` with role `user` / `assistant` | Text blocks, capped at 64 KiB per entry |
| `compaction`, `branch_summary` | `summary` |
| `custom_message` with `display: true` | Text content |
| `label` | Label text |
| `session_info` and the first user message | Session title search (`entryId` is `null`) |
| Tool results, bash output, hidden custom messages, extension entries | Not indexed |

v1 files without entry ids are indexed with ids `L<physical line>`. Files are migrated to v3 in memory only.

Child-agent sessions (subagent lanes, workflow agents) are indexed with `sessions.origin = 'subagent'` but are excluded from every search and list, including the short-query window and degraded mode. A session is a child when its header has `origin: "subagent"` or its id starts with `subagent-` / `workflow-` (`isChildAgentSession`); sessions written before the header marker carry only the prefix. Schema minor 2 added the column and marked existing rows by prefix.

## Updates

| Trigger | Behavior |
| --- | --- |
| `notifyPersisted({ path, kind })` | Debounced per path (200 ms), then the file is synced |
| Append | Reads from the stored offset after checking the header and last-line hashes |
| Header or tail changed, file shrank, v1 file | Session rows are deleted and rebuilt in one transaction |
| Empty file or incomplete header | Marked `pending`; existing rows stay searchable |
| Unfinished final line | Left for the next sync |
| Unparseable complete line | Skipped like `SessionManager` does; the count is kept in `sources.error` and the source stays `ok` |
| Reconcile (open, `reindex`) | Lists every root, syncs new or changed files newest first, and deletes rows for files that are gone from a root that was listed successfully |
| Before each search or list | Freshness pass with a 30 ms budget: re-syncs the 20 most recently modified known files, then lists only directories whose mtime moved since the last reconcile to pick up files written by other processes. A pass cut short by the budget schedules a background reconcile. Deletions wait for the next reconcile |

Writes check the source row they started from inside `BEGIN IMMEDIATE`; when another process changed it meanwhile the sync is retried once.

## Search

| Query | Path |
| --- | --- |
| Every token has 3+ characters | FTS5 `MATCH` of quoted phrases, ordered by bm25 |
| Any token is shorter | `LIKE` on `entries.text` within the 200 most recently modified matching sessions, newest first, at most 50 hits. Without `cwd` or `since`, only the last 30 days are searched |

Snippets wrap matches in `SNIPPET_MATCH_START` / `SNIPPET_MATCH_END`. Results carry `coverage` so a caller can tell a partial backfill from a complete answer.

## Degraded mode

When `node:sqlite`, FTS5 trigram, the database, or the worker is unavailable, `openSessionIndex()` still resolves. Searches and lists scan JSONL on each call, hits are session-level only, and `status()` returns `state: "degraded"` with the reason. A worker that fails after opening switches the same object to this mode.

## API

```ts
import {
  attachSessionIndex,
  createStepSessionManagerFactory,
  openSessionIndex,
  withSessionIndex,
} from "@step-harness/coding-agent";

const index = await openSessionIndex({ agentDir });
attachSessionIndex(sessionManager, index); // one manager
const factory = withSessionIndex(createStepSessionManagerFactory(agentDir), index); // every manager it builds

for await (const batch of index.search({ text: "migration", cwd, limit: 20 })) {
  console.log(batch.coverage, batch.hits);
}
const page = await index.listSessions({ cwd, limit: 50 });
await index.close();
```

`SessionManager.setFilePersistedListener()` reports `create`, `append`, and `rewrite` after each successful write. Listener errors are ignored; the next reconcile repairs any missed update. `attachSessionIndex()` sets that listener; `withSessionIndex()` wraps a `SessionManagerFactory` so created, opened, forked, and resumed managers are attached (in-memory managers have no file and are left alone).

## Host methods

`createSessionSearchService(index)` exposes the index to a Web or Desktop host without choosing a transport. `call(method, params, signal)` takes untrusted JSON params, validates them, and yields JSON-safe results; the host owns framing and the index lifetime.

| Method | Params | Result |
| --- | --- | --- |
| `search.query` | `q` (1–500 chars), `cwd?` (absolute), `entryTypes?`, `limit?` (1–100, default 20), `since?` (epoch ms) | One or more `{ hits, coverage }` batches |
| `sessions.list` | `cwd?`, `limit?` (1–200, default 50), `cursor?` | `{ sessions, nextCursor? }`; `created` / `modified` are epoch ms |
| `index.status` | none | `SessionIndexStatus` |

Invalid requests throw `SessionSearchRequestError` with `code` `unknown_method` or `invalid_params` before the index is queried.

## Integrating a host

A Web or Desktop host that wants session lists and search follows these steps. Nothing here needs changes to `SessionManager`, the JSONL format, or the CLI.

| Step | What to do | Notes |
| --- | --- | --- |
| 1. Open once | At host startup: `openSessionIndex({ agentDir, roots })`. Roots are `defaultSessionIndexRoots(agentDir)` plus any configured session directory (`STEP_CODING_AGENT_SESSION_DIR`, `--session-dir`) as `kind: "custom"` | Never rejects. Backfill runs in the worker; the host stays responsive. Keep one index per host process and reuse it |
| 2. Wire writes | Pass `withSessionIndex(factory, index)` as the runtime's `sessionManagerFactory`; call `attachSessionIndex(manager, index)` for a manager built outside the factory (the initial session) | Writes from this process are indexed within the 200 ms debounce. Writes from CLI processes are found by the freshness pass before each query |
| 3. Expose methods | Route the transport's requests to `createSessionSearchService(index).call(method, params, signal)`. Map `SessionSearchRequestError.code` to the transport's error codes; abort the signal when a client cancels or retypes | Results are JSON-safe; stream each `search.query` batch as it arrives |
| 4. Show progress | Poll `index.status`: `backfilling` with `indexed / total` drives a progress indicator; `degraded` with `degradedReason` means results come from a JSONL scan (session-level hits only). Each search batch also carries `coverage` | `reindex()` yields progress for an explicit rebuild |
| 5. Shut down | `await index.close()` | Flushes pending notifications and stops the worker |

Constraints for hosts:

- Treat the database as private to the index. Do not open it, write it, or copy rows elsewhere; it may be deleted and rebuilt at any time.
- Session data changes only through `SessionManager`; the index never writes JSONL.
- Several processes may open the same index safely (each sync runs in `BEGIN IMMEDIATE` and rechecks its source row), but each costs a worker and a backfill pass. Prefer one long-lived host per agent directory.
- Packaged builds must ship the worker: `session-index-worker.js` beside `client.js` for `dist/` and the Node bundle, and `src/core/session-index/session-index-worker.ts` as an extra entry point for `bun build --compile`. Without it, the index runs degraded.
- Requires `node:sqlite` with FTS5 `trigram` (Node.js `>=22.19.0`, or the compiled Bun binary).

Source map:

| Path | Role |
| --- | --- |
| `src/core/session-index/client.ts` | `openSessionIndex`, worker RPC, degraded fallback switch |
| `src/core/session-index/session-index-worker.ts` | Worker that owns the connection; request handling, backfill, freshness pass |
| `src/core/session-index/store.ts` | Sync, reconcile, freshness pass, search, list |
| `src/core/session-index/schema.ts` | DDL, open / inspect / upgrade, versions, `getSessionIndexPath` |
| `src/core/session-index/reader.ts`, `projector.ts` | Read-only JSONL access and entry projection |
| `src/core/session-index/fallback.ts` | JSONL scan used when the index is degraded |
| `src/core/session-index/attach.ts` | `attachSessionIndex`, `withSessionIndex` |
| `src/server/session-search-service.ts` | Transport-neutral host methods and parameter validation |
| `test/session-index/` | Store, client / worker, and service tests |

## CLI

```bash
step session-index status [--json]
step session-index reindex [--full] [--json]
step session-index clear
```

`STEP_CODING_AGENT_SESSION_DIR` is included as an extra root when set.
