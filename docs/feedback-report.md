# Feedback report

A feedback report is a user-initiated bug report that has to be investigable without the user's screen. It carries three things: what the user said, the conversation it is about, and enough state to read that conversation. One implementation lives in `packages/coding-agent/src/step/feedback/`; every host (`step feedback`, `/feedback` in the TUI, and a host serving the same session over RPC) calls it.

## Report contents

Attached by default, no per-item choice:

| Part | What it is | Bound |
| --- | --- | --- |
| `feedbackId`, `at`, `category`, `comment` | The report itself | comment ≤ 4000 characters |
| `context` | `channel`, `version`, `versionSource`, `buildTime`, `commit`, `runtime` (node/electron/bun), `platform`, `arch`, `osRelease`, `locale`, `installSource`, `sessionId`, `deviceId`, `uid`, `username`; `surface` is top-level | each value ≤ 256 characters |
| `request` | The newest model request: `requestId`, `provider`, `model`, `reasoning`, `sourceLeafId` | — |
| `sessionSummary` | Counts and enums only: model (provider/id/api), effort, turns, tool calls and failures, aborted and truncated attempts, model-request count, compactions with before/after sizes, tokens and cost, cache hit rate, thinking time, `cwd` (home collapsed), plan/goal/task state, last turn's tool names, recent error kinds, and live host facts (permission tier, context used/window, tool/skill counts, MCP server names) | bounded per field (≤ 50 tool rows × 256 chars, ≤ 20 compactions and errors) |
| `diagnostics` | Error context lines from the host's daily dev log | ≤ 40 lines × 512 characters, ≤ 16 KiB |
| session archive | `events.jsonl` (each row annotated with its own metrics, see below), the full output files the session referenced (`tool-output/`), and the log tail, gzipped | ≤ 8 MiB compressed; ≤ 24 MiB transcript; ≤ 10 output files, 2 MiB each |

`context.versionSource` says where the version came from: `embedded` (release pipeline), `override` (local env) or `fallback` (a source build with nothing injected). A `fallback` version is the product default (`0.1.0`), not a release, so a report from a source build is never mistaken for a shipped one. `context.runtime` names the interpreter — Node, Electron or Bun — which is what a native-module or packaged-app report starts from. `buildTime` is present only when the pipeline embedded it.

`request` is the join key and the dispatch record: `requestId`, provider, model, API dialect, reasoning effort, source leaf, the catalog `contextWindow`/`maxTokens` in force, who answered (`responseProvider`/`responseModel` when auth or a proxy redirected it), HTTP status and duration. It is read from `step.usage_provenance`, whose coverage depends on the usage-recording extension being mounted by the host; a session without it simply omits `request` and its `modelRequests` count stays 0.

`sessionSummary.compactions` is one row per compaction, oldest first: `tokensBefore` as the kernel recorded it, `tokensAfter` as the input size of the first request that followed. A long session that compacted ten times has ten rows (the newest twenty keep their detail, `counts.compactions` counts all of them). A pass that did not shrink the window shows two close numbers; a pass no request followed yet carries `unresolved: true`.

`compactionTotals` counts every pass in `passes` but sums sizes only over passes a request followed (`resolved`), so `tokensBefore - tokensAfter === reclaimed` always holds.

Numbers describe the **branch the session file ends on**, not every line in it: navigating back or forking leaves abandoned entries in the same file, and counting them would report turns the user rewound and a request id from another branch.

`sessionSummary` and the archive describe the **same** session: `resolveFeedbackSession` picks it once and both read that file.

### Per-row metrics

Each line of the bundle's `events.jsonl` keeps the entry it always had and gains a `feedback` object describing that row alone:

```jsonc
{ "id": "da49b9c4", "type": "message", "message": { "role": "assistant", "...": "..." },
  "feedback": {
    "turn": 1,
    "tokens": { "input": 14854, "output": 1752, "cacheRead": 1152, "cacheWrite": 0, "total": 17758 },
    "cacheHitRate": 0.072,            // this request only: cacheRead / (input + cacheRead)
    "costUsd": 0.004,
    "model": "step-5-preview", "provider": "step", "stopReason": "stop",
    "requestId": "2be772f5-…",        // joins the server-side request log
    "durationMs": 4200,
    "ttftMs": 640,                    // null = no stream event ever arrived
    "outcome": "ok",
    "thinkingMs": 11800,
    "reached": "thinking"             // only on a cancelled or failed attempt
  } }
```

A tool result row gets `elapsedMs` (call issued → result recorded) only when the batch had a single call; a parallel batch shares one start, so a per-call duration would be invented. Rows with nothing to add keep their exact original bytes.

`turn` numbers the user messages **in this file**, including turns the user later rewound (the file keeps them); `sessionSummary.counts.turns` counts the live branch only. The two can differ by design, and the difference is itself a useful signal that the user navigated back before filing. Tool-output names come from that transcript, so the archive carries them even when the transcript is only a head-and-tail excerpt.

Sources: the token figures and cache reads are the message's own `usage`, which the session already records per assistant message — the bundle copy just derives the rate and puts it on the row. Timing, `requestId` and `outcome` are joined from the `step.usage_provenance` entry written directly after that message (`usageEntryId`); thinking time from `stepcode-web.thinking-timing`. The join runs in two passes because those entries follow the message they describe.

**Size.** Only the bundle copy is annotated; the session file on disk is never rewritten. Measured on real sessions: +2.2% uncompressed, +1.2–1.8% gzipped. The transcript bound (24 MiB) applies to the pre-annotation excerpt, and the annotated copy is re-bounded if it would exceed it.

### Which session is attached

The conversation a report describes is chosen once, and both the summary and the archive read that same file.

- `--session <id|path>` or a host-supplied session file/id: used as given.
- Nothing named: the newest session **of the current project's own session folder**, and only when it was active within the last ten minutes. A guess never reaches into another project's folder and never attaches an old conversation: the wrong conversation is a privacy incident, not a degraded report.

The rule also decides the summary: a guessed session outside the window contributes neither a transcript nor a session id, so a report is never about a conversation the user was not just using.

### Transcript excerpt

A session larger than the transcript bound keeps its **head and tail**, cut at line boundaries, with a marker line where the middle was removed. A tail-only excerpt lost the request that started the session; a head-only excerpt lost the turn that broke.

### Full tool output

When a tool result was larger than the model-visible limit, the tool saved the full text under `<sessionDir>/tool-output/tool-<hex>.txt`. The transcript keeps a preview plus that path, which does not exist on the receiving machine. The report attaches the files the transcript actually names, resolved inside the session's own `tool-output` directory — names from the transcript are untrusted input and never used as arbitrary paths.

### What a report answers

| Question | Field |
| --- | --- |
| Which version, host, platform, install kind | `context.*` |
| Which model, provider, API dialect, effort | `sessionSummary.model`, `thinkingLevel`, `request.api` |
| What the model's window was, and how full it got | `request.contextWindow`/`maxTokens`, `runtime.contextWindow`/`contextUsed` |
| Did compaction run, from what to what | `sessionSummary.compactions[].tokensBefore` / `tokensAfter` |
| How much was spent, and was the cache working | `usage.*`, `usage.costUsd`, `usage.cacheHitRate` |
| Did the model hit its output limit or get stopped | `counts.truncatedAttempts`, `counts.abortedAttempts`, `counts.failedAttempts` |
| Which request to look up server-side | `request.requestId` |
| What was blocked by permissions | `runtime.permissionPreset` |
| Did an MCP server or skill take part | `runtime.toolCount`, and `runtime.mcpServerNames` / `runtime.skillCount` when the host supplies them |
| Which tool failed, and on which turn | `recentErrors`, `lastTurnTools`, `toolResult` in `events.jsonl` |
| Why the provider rejected a request | `recentErrors[].message` (status + response body), `errorKind` |
| Did it hang, and did the user cancel it | `recentErrors[]` with `kind: "aborted"`: `durationMs`, `ttftMs` (absent = no token ever arrived), `reached` |

Still not collected: the assembled system prompt, the per-request retry log, and per-request token history (totals, the latest request, and compaction deltas only). Add them only with a concrete investigation that needs them.

### Cancelled and failed attempts

A user often cancels because the request looked stuck. Three values make that diagnosable without the user explaining it:

- `durationMs` — how long it ran before settling;
- `ttftMs` — time to the first stream event, `null` when nothing ever arrived (a request that never started returning looks different from a slow one);
- `reached` — `thinking`, `text` or `toolCall`: how far the model got, so "cancelled while thinking" is distinguishable from "cancelled mid-answer".

The timing comes from `step.usage_provenance`, the entry written directly after the assistant message; the summary joins the two by entry id. Reports from sessions written before those fields existed carry the cancellation and `reached` but no timing.

## Redaction

| Applied to | Rule |
| --- | --- |
| Every archived file, the comment, diagnostics | Credentials are replaced with `<redacted:secret>`; the scan covers the whole file, so a secret written early also redacts its later echoes |
| Transcript, tool output, `cwd` | The home directory is written as `~`, so paths keep their structure without carrying the OS user name |
| Diagnostics | Also redacts absolute paths, bare emails and URLs |

A file that cannot be scanned safely (a line too long to scan, an unreadable or symlinked file) is **omitted**, never sent unredacted.

Never collected: credentials (`auth.json`, tokens, cookies), other sessions, workspace source files, environment variables, hostnames, shell history.

## Consent

The user sees one review page with the category, their comment, the identity fields sent with the report, and a file list with sizes and truncation notes. It is one decision: send, or cancel. There is no per-item selection — a report assembled by choosing what to include was usually just the user's own sentence, which cannot be investigated.

`/feedback <text>` submits the same evidence behind the same review page; the comment comes from the command and the category is recorded as `other`. When there is no terminal to show the page on (`--json`, a scripted caller), the submission prints one line naming what it attached, so a non-interactive report is never silent about the transcript. `--no-session-bundle` sends the report without it. With a terminal, a comment supplied on the command line skips the questions but still shows the consent page.

`feedbackEnabled = false` in `step config.toml` (`[feedback] enabled`) or `STEPCODE_DISABLE_FEEDBACK=1` disables the flow entirely; the entry point reports why.

## Delivery and retry

Two requests: the JSON report to the feedback endpoint, then the gzip archive to the bundle endpoint with `?feedbackId=`. A failed body is written under `<storage root>/feedback/` and re-sent by `step feedback --retry`; the archive is saved beside it and uploaded after the body succeeds. A pending report is reported as pending, never as submitted.

A saved body is re-read strictly before retry: unknown fields, unsafe strings or mismatched ids make it invalid rather than sending something that changed on disk.

## Opt-outs for scripted callers

`--no-diagnostics` and `--no-session-bundle` skip those parts. Both are for automation; the guided flows never ask. The content-free `sessionSummary` is always attached.

## Adding a host

A host supplies a session file or id and an identity, then calls:

- `prepareFeedbackEvidence` — resolves the session once and gathers the summary, diagnostics and archive.
- `submitFeedback` — validates, builds the report body, confirms (if the host wants a review page), delivers and records telemetry.

A host must not assemble its own payload: the surface, the attached evidence, and the redaction are decided here.
