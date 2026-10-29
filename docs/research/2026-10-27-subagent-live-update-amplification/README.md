# Subagent event-log amplification: cause, design, and what comes next

- Date: 2026-10-28
- Status: implemented on `feat/event-durability`; the frame-payload bounds it
  introduces are deliberate stopgaps, with their removal condition in §8
- Reproduction: `repro.mts` and `child.mjs` in this directory

## 1. Symptom

With the benchmark configuration, a single trial's `stepcode.jsonl` reached GB
scale and the run OOMed. A harness redirects the standalone CLI's `--mode json`
stdout to that file, so the file *is* the session event stream.

| native log metric | old run | new run |
| --- | --- | --- |
| files | 171 | 95 |
| total | 1.472 GiB | 127.332 GiB |
| median file | 6.552 MiB | 874.835 MiB |
| file P95 | 22.957 MiB | 4,281.838 MiB |
| largest file | 0.049 GiB | 11.713 GiB |

Two adjacent lines at the 50% offset of the largest file:

```
type: tool_execution_update
toolName: subagent
event bytes: 2,845,152
partialResult.details.results[0].messages: 2,036,197 bytes
messages SHA256 of the previous line: identical
```

The two runs cover different task sets, so the ratio is not a per-call cost. It
is evidence of one datum being written over and over.

## 2. Cause: one stream, two audiences

`tool_execution_update` was doing two jobs at once:

1. the UI's refresh signal, and
2. a line in whatever stream the host redirected to a file.

Because an event could always end up in a log, its producer had to keep it small,
and because it fired per streamed delta, keeping it small was expensive. `messages`
changes only at `message_end`, so between two of them hundreds of events carried a
byte-identical array.

The chain, with the location of each step:

| step | location | behaviour |
| --- | --- | --- |
| 1 | `features/step-subagent.ts` `parseJsonEvent` | every child event, deltas included, calls `onUpdate` |
| 2 | `features/subagent/execute.ts` `emit` | each `onUpdate` rebuilt `details` with `results[].messages` |
| 3 | `agent-core/src/agent-loop.ts` | each `partialResult` became a `tool_execution_update` |
| 4 | `modes/print-mode.ts`, `modes/rpc/rpc-mode.ts` | **every** event was serialized to one JSONL line |

Step 4 is the actual defect. With N turns and M deltas per turn there are ~NxM
events, and turn k carries a transcript of ~k turns, so the total is ~O(N^2 x M).
A 40-turn, 150-delta child had 82 distinct `messages` snapshots and wrote 6,327
of them.

A corroborating detail: `modes/json-event.ts` already stripped the cumulative
snapshot from `message_update` (*"Remove cumulative assistant snapshots from
streaming wire events"*) but not from `tool_execution_update`. The question was
never "how do we make one event smaller" — it was "which events belong on this
stream at all".

## 3. Reproduction

Both test doubles are the ones the repository's testing policy already allows —
the parent's model (faux provider, no network) and the child's token stream. The
measured path is production code: real rpc adapter, real event projection, real
orchestrator, real Agent Loop, real `toJsonEvent`, and the same durability filter
the transport applies.

```bash
cd packages/coding-agent
node --import tsx ../../docs/research/2026-10-27-subagent-live-update-amplification/repro.mts
REPRO_LIVE=1 node --import tsx ../../docs/research/2026-10-27-subagent-live-update-amplification/repro.mts
```

Before the change (`main`, Node 22):

| child | log | updates | `messages` share | largest line | peak RSS |
| --- | --- | --- | --- | --- | --- |
| 20 turns x 60 deltas, 20 KB tool results | 268.05 MiB | 1367 | 99.2% | 0.42 MiB | 724 MiB |
| 40 turns x 150 deltas, 40 KB tool results | 4992.61 MiB | 6327 | 99.8% | 1.63 MiB | 1333 MiB |

After the change, with the `--mode json` default (durable events only):

| child | log | durable | live frames (dropped) | largest durable line | peak RSS |
| --- | --- | --- | --- | --- | --- |
| 20 turns x 60 deltas | **0.005 MiB** | 0.005 MiB | 11 | 0.001 MiB | 261 MiB |
| 40 turns x 150 deltas | **0.005 MiB** | 0.005 MiB | 10 | 0.001 MiB | 259 MiB |
| 80 turns x 300 deltas | **0.005 MiB** | 0.005 MiB | 13 | 0.001 MiB | 258 MiB |

The log is now **independent of the child's size**, which is the property to
assert: quadrupling the child does not move the number. With
`--include-live-events` the same 40-turn run writes 0.010 MiB, of which 0.005 MiB
is frames, and no frame carries a transcript.

## 4. Competitor survey

Six implementations, source-read. Versions: opencode `f669c46c`, codex `970111f6`
(Rust under `codex-rs/`), kimi-code `743f14097`, minimax-code `da22f11`,
deepseek-harness, ZCode.

| implementation | where the decision lives | deltas persisted | progress persisted | persistence trigger | child history |
| --- | --- | --- | --- | --- | --- |
| opencode | **event type**: `durable` / `ephemeral` are mutually exclusive | no | no | `text.ended`, `tool.success`, `step.ended` | own session; parent keeps sessionID + final text |
| codex | **storage boundary**: `rollout/policy.rs` transient list | no | no | `ItemCompleted`, full `ResponseItem` | own thread; parent keeps agent_thread_id |
| kimi-code | **event type**: static `durable` flag, default false | no | no | durable event; content parts at step end | own agent log; parent keeps resultSummary |
| minimax-code | **transport**: `VOLATILE_EVENT_TYPES` | no | no | `message_end`, `tool_execution_end` | own child session; parent keeps a report |
| deepseek-harness | **event vocabulary**: no progress event type exists | no | no | turn/step boundaries, 200ms batches | own session; parent keeps childId + label |
| ZCode | **event type set**: `TRANSIENT_SESSION_EVENT_TYPES` | no | no | pending/running/completed upserts | own session; parent keeps childSessionId + outputPath |

What all six share:

1. **A non-durable event flows to the UI and not to storage.** codex's
   `SubAgentActivity` is durable only when `kind == Completed`, so `Started`,
   `Interacted` and `Interrupted` never reach the rollout; opencode's
   `session.tool.progress` is `Event.ephemeral`, whose type has no durable
   envelope at all.
2. **The successor is the replayable value.** `message_end` / `tool_execution_end`
   / `Text.Ended` carry the authoritative payload; a reader can skip every frame.
3. **Capability, not throttling, is what makes them more live.** Because a frame
   is never written, emitting one per token is free — there is no trade between
   latency and log size to make.
4. **The child's transcript has its own home**, referenced by id.

One structural difference matters for us: in all six the log file *is* their
storage layer, so filtering at the storage boundary works. Our `stepcode.jsonl`
is a **redirected stdout**, and the session file itself only ever received
`message_end` — it was never the problem. So the classification has to be applied
by the serialized transports, not by the session store.

## 5. Design

### 5.1 Principle

1. **Durability is a property of the event, not the size of its payload.** It is
   decided once and enforced at every serialized output.
2. **A live frame is a replacement snapshot.** It may be dropped, coalesced, or
   superseded; only the terminal result must arrive.
3. **A record carries a fact once.** An event whose payload is only a summary of
   events already written reports the boundary instead of repeating them.
4. **The terminal result is a summary.** Full history stays in the child session
   and is referenced by id.

### 5.2 One classification, enforced by one projection

`core/session-event-durability.ts` declares the two frame types:

```ts
const EPHEMERAL_SESSION_EVENT_TYPES = new Set(["message_update", "tool_execution_update"]);

export function sessionEventDurability(event): "durable" | "ephemeral" {
  return EPHEMERAL_SESSION_EVENT_TYPES.has(event.type) ? "ephemeral" : "durable";
}
```

It is an allowlist of *frames*, so an event added later is durable by default:
forgetting to classify cannot silently opt a new event into a log. The criterion
is "payload is a cumulative snapshot of in-flight work", the same boundary
opencode draws at `Text.Ended`.

The classification is applied in `modes/json-event.ts`, and nowhere else.
`toJsonEvent(event, { includeLiveEvents })` returns `undefined` for a frame the
caller did not opt into; a transport writes `if (projected)`. Filtering at the
call site is what turns one policy into two, so `check:session-event-transports`
fails the build when `toJsonEvent` is called outside a known transport, when a
transport's call does not pass `{ includeLiveEvents }` as its own second
argument, or when the classification is referenced outside the projection.

| transport | default | reason |
| --- | --- | --- |
| `--mode json` | facts only | it is a machine-readable record of one run; traces read `message_end` |
| `--mode rpc` | facts only | it is a control channel, but its stdout redirects just as easily |
| in-process `session.subscribe` | all events | an in-process subscriber is a live consumer by construction |

`--include-live-events` is the single explicit opt-in. A harness does not pass
it, so its log is clean. The subagent runner does pass it to its child, because
that child's stdout is a pipe it reads frame by frame and renders in the lane
list.

The guard is textual — a "forgot to classify" guard, not a security boundary. It
does not stop a namespace import, a hand-rolled `JSON.stringify(event)`, a
wrapper outside its scanned roots, or an edit to its allowlist. Those are
deliberate acts visible in review; the ordinary mistake is what it catches.

### 5.3 What the record contains

Frames are excluded. Beyond that, a record repeated its own results: `turn_end`
carries the assistant message and its tool results, and `agent_end` carries every
message of the run — all of them already written as their own
`message_start`/`message_end`, and a tool result also as `tool_execution_end`.

Projected both ways on the same runs, those two events were **40.2% of the
durable record** for a 100-task batch (713,553 -> 426,615 bytes) and **51.6%** for
a 20-task batch whose answer is 40,000 characters (278,463 -> 134,739 bytes). They
now carry `{ messageRole, toolResultCount }` and `{ willRetry, messageCount }`:
the boundary says where the turn and the run ended, not what they contained, and
a reader reconstructs the transcript from `message_end` exactly as before.

`messageCount` is not a checksum. It is the length of that run's `messages` array,
and the loop can emit more `message_end` events than it lists (a resampled
tool-call leak, a throwing `shouldStopAfterTurn`). A reader detects a truncated
run by a message that never got its `message_end`, not by comparing counts.

This is boundary-payload deduplication, **not** an exactly-once record. What still
repeats, and why it stays:

| payload | wire events carrying it | why it stays |
| --- | --- | --- |
| tool result | `tool_execution_end`, `message_start`, `message_end` (3) | the begin/end pair frames it; the tool event is its execution outcome |
| user message | `message_start`, `message_end` (2) | the pair is how a reader frames a message |
| assistant message | `message_end` only (1) | its `message_start` carries the empty partial that streaming builds from |

The projection test pins the marginal record bytes for the tool-result payload at
a constant 3 per added character; a repeated transcript would make that
multiplier grow with the number of events. Multipliers are per payload kind, not
a single record-wide factor.

### 5.4 A live frame stays cheap

A frame no longer reaches a file by default, but it is still a replacement
snapshot, so re-sending accumulated state wastes the consumer's own budget.
`features/subagent/projection.ts` projects a record by explicit allowlist:

- no `messages`;
- short tails for streamed text, tool output and `stderr`;
- a task prompt clipped at both ends, because a chain splices the previous step's
  whole answer into it;
- one roster per frame bounded by bytes, with the tail counted in
  `omittedResults` so a renderer still reports the real task count.

`agent-core` keeps **at most one frame in flight per tool**: a frame arriving
while another is being delivered replaces the pending one, and the drain that the
tool result awaits delivers the newest frame before returning. A slow consumer
can therefore never make the loop hold one promise per token — the memory half of
the incident, independent of which transport consumes the frames.

`execute.ts` additionally coalesces frames on a 100ms window. That is a **repaint
budget** (recomputing a roster projection per token costs more than a screen can
show), not a log-safety mechanism.

### 5.5 The terminal result is a summary

`messages` is gone from the final `details`. The transcript is the child session's
property, referenced by `sessionId` / `sessionFile`; a second copy in the tool
result competed for the same budget and reached only one of the events that echo
it. What remains is `activeText` (bounded at 50,000 characters, the renderer's own
truncation point), the failure diagnostics, and the session pointers.

The 128 KiB shared final-field budget reserves small task, output, and diagnostic
floors for every record, then divides the remaining bytes across the records and
fields still to project. Floors add only O(records x small) bytes, so a record
never loses its identity or its failure reason to an earlier sibling's long
output, and the total does not grow with the child's output.
Model-facing `content` is unaffected and still passes through the existing 50 KiB
/ 2000-line retention.

### 5.6 The wire backstop

One `tool_execution_update`, if written at all, is capped at 256 KiB of
**serialized** bytes: the tail of its text plus `[live output truncated]`, with
`args`/`details` dropped (they are on the start/end events). Measuring after JSON
escaping matters — a control character is a six-byte escape, so counting
characters under-counts by 6x — and both ids and tool names are clipped so the
halving loop always converges. Terminal events are never bounded.

## 6. Impact

**Users**

- `--mode json` / `--mode rpc` no longer contain `message_update` or
  `tool_execution_update`, and `turn_end` / `agent_end` report `messageRole` /
  `toolResultCount` and `willRetry` / `messageCount` instead of the messages they
  close over. Scripts that counted deltas or read those two payloads need
  `--include-live-events` (which restores frames, not the boundary payloads; the
  boundary values were always available on `message_end`).
- Trace reconstruction is unaffected: it reads `message_end` and
  `tool_execution_end`, both of which still carry the value.
- The TUI keeps its live list: it subscribes in process. Frames arrive on a 100ms
  repaint budget, and a state that lasts under 100ms may not be painted.
- Subagent cards no longer show the child transcript; it is reachable through
  `sessionId` / `sessionFile`.
- No migration, no new configuration, one new optional flag.

**Agent**

- Model-visible `content` is unchanged, including the existing 50 KiB retention.
- A chain's `{previous}` is unchanged: it reads the internal unprojected records;
  budgets apply only to what leaves the module.
- The subagent runner adds `--include-live-events` to its child, without which the
  parent would lose `activeToolOutput` and the live list would degrade.
- Contract changes, documented in `docs/json.md`, `docs/rpc.md` and
  `docs/tool-output-retention.md`: the wire `turn_end` / `agent_end` carry
  structure instead of messages; `StepSubagentDetails.results[].messages` is
  removed; the optional `omittedResults` is added.

**Risk and rollback**

| risk | control |
| --- | --- |
| an external script depends on deltas in `--mode json` | documented in `docs/json.md`; `--include-live-events` restores them |
| a subagent child missing the flag degrades the live list | end-to-end test asserts a progress-only marker reaches the parent; removing the flag fails it |
| a new event type is misclassified | allowlist of frames: new types default to durable |
| removing `messages` breaks a renderer | renderers prefer `activeText`, which is backfilled from the full transcript |
| merge conflicts on the web branch | changes concentrate in `emit`, the transports and projections; web consumes subscriptions unchanged |

Rollback: the classification is one module and one flag; `git revert` needs no
data migration. Details already written by an older version are not restored by
the revert — read the child session instead.

## 7. Validation

- `session-event-durability.test.ts`: each type's classification, the
  allowlist bias (an unknown type is durable), and that every frame has a durable
  successor.
- `json-event-projection.test.ts`: frames are `undefined` unless opted in; the
  boundary projection; a boundary with nothing to close over; a real run through a
  local tool asserting no frame, no boundary payload, and the per-payload
  occurrence counts; the marginal bytes per added character (3 for a tool result,
  constant) so a repeated transcript would fail.
- `json-mode-durability.test.ts`: the real CLI under `--mode json` writes no
  frames, restores them under `--include-live-events`, and writes the boundary
  shapes above.
- `subagent-live-channel.test.ts`: a real spawned `--mode rpc` child; the parent
  receives a marker that exists only in a progress frame, no frame carries a
  transcript, and the final result has no `messages`. The fixture honours
  `--include-live-events` like the CLI, so dropping the flag fails the test.
- `json-event-backstop.test.ts`: the 256 KiB cap under ASCII, control characters,
  quotes, CJK, a lone surrogate and emoji; a pathological id; a terminal result is
  never bounded.
- `agent-core/test/agent.test.ts`: frames separated by a yield all arrive in
  order; a synchronous burst may coalesce but never loses or reorders the newest
  frame; a delivery failure surfaces through the awaited tool result.
- `scripts/guard-self-tests.test.mjs` runs the transport guard's self-test, which
  pins both its detections and its documented non-guarantees.
- `packages/agent-core` and `packages/coding-agent` full suites; `pnpm run check`
  (biome, boundary checks, the guards, `tsgo`, browser smoke).

## 8. Not in this change, and what would let us delete the stopgaps

1. **Progress does not yet have a channel of its own.** It is classified as
   non-durable and excluded from the log, which removes the amplification, but it
   still travels as a session event. The target design gives live progress a
   dedicated surface — the shape codex and opencode converge on — so that
   `omittedResults`, the roster byte budget and `rosterFields` can be deleted
   outright. **Removal condition:** when a live frame no longer carries a roster,
   all three go, and no test needs them.
2. **A dedicated `subagent_progress` event type is optional, not required.** Now
   that frames are excluded from storage, a new event type would buy naming
   clarity only, at the cost of a new type plus every consumer. Prefer to revisit
   it together with (1).
3. **Session-file compaction.** After this change growth is linear, not quadratic,
   but a long session is still large. Competitors have zstd or a file cap; we do
   not.
4. **Full backpressure.** One frame in flight bounds the loop's queue, but
   `output-guard`'s stdout queue has no hard limit. With facts only, that traffic
   is small, so this is secondary.
5. **A tool result still reaches the record three times.**
   `tool_execution_end`, `message_start` and `message_end` each carry it;
   `turn_end` / `agent_end` no longer do (see §5.3). Two of those are the
   begin/end pair that frames a message, so collapsing them is an
   event-sequence change, not a de-duplication — a different risk class than this
   change, which only removed payload from events whose whole purpose is the
   boundary.
6. **Type-level durability.** The classification is enforced in one projection
   module, not by the event type, and a check script fails the build if a second
   policy appears. opencode makes it a compile-time property; we do not yet.
