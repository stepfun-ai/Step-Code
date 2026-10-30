# Compaction & Branch Summarization

LLMs have limited context windows. When conversations grow too long, Step uses compaction to summarize older content while preserving recent work. This page covers both auto-compaction and branch summarization.

**Source files** ([step-harness](https://github.com/stepfun-ai/step-harness)):
- [`packages/coding-agent/src/core/compaction/compaction.ts`](https://github.com/stepfun-ai/step-harness/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) - Auto-compaction logic
- [`packages/coding-agent/src/core/compaction/branch-summarization.ts`](https://github.com/stepfun-ai/step-harness/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) - Branch summarization
- [`packages/coding-agent/src/core/compaction/utils.ts`](https://github.com/stepfun-ai/step-harness/blob/main/packages/coding-agent/src/core/compaction/utils.ts) - Shared utilities (file tracking, serialization)
- [`packages/coding-agent/src/core/session-manager.ts`](https://github.com/stepfun-ai/step-harness/blob/main/packages/coding-agent/src/core/session-manager.ts) - Entry types (`CompactionEntry`, `BranchSummaryEntry`)
- [`packages/coding-agent/src/core/extensions/types.ts`](https://github.com/stepfun-ai/step-harness/blob/main/packages/coding-agent/src/core/extensions/types.ts) - Extension event types

For TypeScript definitions in your project, inspect `node_modules/@step-harness/coding-agent/dist/`.

## Overview

[Model-managed working context (CLM)](context-management.md) is the default
compression mode. At the existing context threshold, Step first asks the model
to shorten eligible old observations in a validated working view. It keeps the
canonical history and protects user requirements and current tool groups. If no
useful edit is accepted, Step falls back to the native summary compaction
explained below. Provider context overflow goes directly to native recovery.

Use `--context-projection off` or `compaction.contextProjection = "off"` to select
native compaction explicitly. `/compact` still requests a native summary;
`/clm-compact` requests an explicit working-context edit. A settled CLM response
with no queued continuation leaves routine maintenance until the next request.

The native pipeline has two summarization mechanisms:

| Mechanism | Trigger | Purpose |
|-----------|---------|---------|
| Compaction | Context exceeds threshold, or `/compact` | Summarize old messages to free up context |
| Branch summarization | `/tree` navigation | Preserve context when switching branches |

Both use the same structured summary format and track file operations cumulatively. Compaction and branch-summary requests use fresh routing session IDs and, where supported by the provider, disable prompt-cache writes because these one-off prompts are unlikely to be reused.

## Failure diagnostics

Native compaction failures include a safe configuration snapshot in the error shown by TUI, RPC, and SDK. The snapshot reports the runtime model/provider/API, context window, model output limit, selected summary output budget, observed payload output budget when available, approximate input size, reasoning option, request attempts and elapsed time, stop reason and error kind. It also includes compaction reserve/retention and retry settings.

`selectedMaxTokens` is the caller's budget; `observedPayloadMaxTokens` is the numeric output cap observed through the provider payload callback after context/adapter adjustments. Custom streams that do not invoke this callback report `unknown`. Input estimates use serialized characters/4, not the provider tokenizer. Configuration provenance is currently `unknown`; values describe effective runtime settings, not a guessed disk configuration.

Non-cancelled failures append a versioned `step-compaction-failure` custom entry to the session JSONL (when persistence is enabled). This entry is not added to model context and contains no failed summary, prompt, headers, URL, or environment dump. Credential-shaped error text is redacted. Failure to persist diagnostics does not replace the original error. Cancelled requests do not create failure entries.

A `length` response remains an incomplete summary and is never saved as a successful checkpoint. Check model output limits and input headroom rather than assuming increasing `reserveTokens` increases the output cap. Transient transport failures use the existing bounded retry policy; deterministic malformed responses and cancellations do not become network retries.

## Compaction

### When It Triggers

Auto-compaction triggers when:

```
contextTokens > min(
  floor(contextWindow * triggerRatio),
  max(contextWindow - 4096 - min(model.maxTokens, 8192), floor(contextWindow * 0.5))
)
```

`triggerRatio` defaults to `0.9` for every model (configurable globally or per model in `~/.stepcode/config.toml` or trusted `<project-dir>/.stepcode/config.toml`). Providers clamp each request's `max_tokens` to the remaining context minus a 4096-token safety margin, so the second term keeps room for the next response: on a small window 10% of the context is less than that margin. The trigger never drops below half the window. With an 8K-or-larger output limit, a 32K window compacts at 20,480 tokens (62.5%), 64K at 53,248 (81.25%), and 128K or larger at 90%. A response truncated by the clamp still goes through the overflow/length recovery below. `tokenLimit` can only make compaction trigger earlier. An explicitly configured `reserveTokens` keeps its old effect as an additional ceiling, `contextWindow - reserveTokens`.

Step checks the threshold once immediately before every model request: before the first request of a prompt (counting the incoming prompt), before every follow-up request inside a tool loop (counting the new tool results and injected steering), and before the first request of a continuation. If the threshold is crossed, Step compacts inside the same agent run and resumes with the summary and retained messages. Steering queued while a follow-up request compacts is delivered to that same request. Input queued while the pre-run check compacts (or added by an `agent_start` listener) joins the first request and is measured again before it is sent; input typed while that first request's own check compacts is delivered with the next request. A final answer that crosses the threshold does not compact on its own; the next request compacts first. Context-overflow and truncated-length recovery still run after the failed response. If measuring or preparing maintenance throws unexpectedly, the request is sent unchanged and overflow recovery remains the fallback.

Token counts use the last valid assistant usage plus estimates of messages added after it. Usage reported before the latest compaction is ignored, because it measured the previous, larger context; without trustworthy usage, the estimate also includes the system prompt and tool schemas.

If automatic threshold compaction fails three times in a row, it pauses for the session and the third failure's message says so; while paused, Step does not measure or attempt automatic compaction. An unexpected error while measuring or preparing maintenance also counts, is recorded as a `step-compaction-failure` entry, and the request is sent unchanged. Cancelled compactions, extension cancellations, and errors raised after a compaction was saved do not count. A successful compaction (including `/compact`), an accepted CLM edit, a model switch, or a registry update that changes the model's context window resumes it. Overflow recovery is unaffected.

Set `triggerPolicy = "legacy"` to restore the previous `contextWindow - reserveTokens` threshold, checkpoints (including compaction right after a final answer), and token measurement.

You can also trigger manually with `/compact [instructions]`, where optional instructions focus the summary.

### How It Works

1. **Find cut point**: Walk backwards from newest message, accumulating token estimates until `keepRecentTokens` (default 20k, configurable in `~/.stepcode/config.toml` or trusted `<project-dir>/.stepcode/config.toml`) is reached
2. **Extract messages**: Collect messages from the previous kept boundary (or session start) up to the cut point
3. **Generate summary**: Call LLM to summarize with structured format, passing the previous summary as iterative context when present
4. **Append entry**: Save `CompactionEntry` with summary and `firstKeptEntryId`
5. **Rebuilds context**: Session rebuilds the context for the next request, using summary + messages from `firstKeptEntryId` onwards

```
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9     10
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

On repeated compactions, the summarized span starts at the previous compaction's kept boundary (`firstKeptEntryId`), not at the compaction entry itself, falling back to the entry after the previous compaction if that kept entry cannot be found in the path. This preserves messages that survived the earlier compaction by including them in the next summarization pass as well. Step also recalculates `tokensBefore` from the rebuilt session context before writing the new `CompactionEntry`, so the token count reflects the actual pre-compaction context being replaced.

### Split Turns

A "turn" starts with a user message and includes all assistant responses and tool calls until the next user message. Normally, compaction cuts at turn boundaries.

When a single turn exceeds `keepRecentTokens`, the cut point lands mid-turn at an assistant message. This is a "split turn":

```
Split turn (one huge turn exceeds budget):

  entry:  0     1     2      3     4      5      6     7      8
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┴──────┘
                ↑                                     ↑
         turnStartIndex = 1                  firstKeptEntryId = 7
                │                                     │
                └──── turnPrefixMessages (1-6) ───────┘
                                                      └── kept (7-8)

  isSplitTurn = true
  messagesToSummarize = []  (no complete turns before)
  turnPrefixMessages = [usr, ass, tool, ass, tool, tool]
```

For split turns, Step generates two summaries and merges them:
1. **History summary**: Previous context (if any)
2. **Turn prefix summary**: The early part of the split turn

### Cut Point Rules

Valid cut points are:
- User messages
- Assistant messages
- BashExecution messages
- Custom messages (custom_message, branch_summary)

Never cut at tool results (they must stay with their tool call).

### CompactionEntry Structure

Defined in [`session-manager.ts`](https://github.com/stepfun-ai/step-harness/blob/main/packages/coding-agent/src/core/session-manager.ts):

```typescript
interface CompactionEntry<T = unknown> {
  type: "compaction";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: Usage;       // LLM usage that generated the summary
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default compaction uses this for details (from compaction.ts):
interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Extensions can store any JSON-serializable data in `details`. The default compaction tracks file operations, but custom extension implementations can use their own structure. Generated and extension-provided summaries store their LLM `usage` when available so session totals include summarization work.

See [`prepareCompaction()`](https://github.com/stepfun-ai/step-harness/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) and [`compact()`](https://github.com/stepfun-ai/step-harness/blob/main/packages/coding-agent/src/core/compaction/compaction.ts) for the implementation. For direct programmatic summarization, `generateSummary()` returns the summary text and `generateSummaryWithUsage()` returns `{ text, usage }`.

## Branch Summarization

### When It Triggers

When you use `/tree` to navigate to a different branch, Step offers to summarize the work you're leaving. This injects context from the left branch into the new branch.

### How It Works

1. **Find common ancestor**: Deepest node shared by old and new positions
2. **Collect entries**: Walk from old leaf back to common ancestor
3. **Prepare with budget**: Include messages up to token budget (newest first)
4. **Generate summary**: Call LLM with structured format
5. **Append entry**: Save `BranchSummaryEntry` at navigation point

```
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D
    A ───┤
         └─ E ─ F ─ [summary of B,C,D] (new leaf)
```

### Cumulative File Tracking

Both compaction and branch summarization track files cumulatively. When generating a summary, step extracts file operations from:
- Tool calls in the messages being summarized
- Previous compaction or branch summary `details` (if any)

This means file tracking accumulates across multiple compactions or nested branch summaries, preserving the full history of read and modified files.

### BranchSummaryEntry Structure

Defined in [`session-manager.ts`](https://github.com/stepfun-ai/step-harness/blob/main/packages/coding-agent/src/core/session-manager.ts):

```typescript
interface BranchSummaryEntry<T = unknown> {
  type: "branch_summary";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  fromId: string;      // Entry we navigated from
  usage?: Usage;       // LLM usage that generated the summary
  fromHook?: boolean;  // true if provided by extension (legacy field name)
  details?: T;         // implementation-specific data
}

// Default branch summarization uses this for details (from branch-summarization.ts):
interface BranchSummaryDetails {
  readFiles: string[];
  modifiedFiles: string[];
}
```

Same as compaction, extensions can store custom data in `details`.

See [`collectEntriesForBranchSummary()`](https://github.com/stepfun-ai/step-harness/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts), [`prepareBranchEntries()`](https://github.com/stepfun-ai/step-harness/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts), and [`generateBranchSummary()`](https://github.com/stepfun-ai/step-harness/blob/main/packages/coding-agent/src/core/compaction/branch-summarization.ts) for the implementation.

## Summary Format

Branch summarization keeps a compact 6-section checkpoint format. Compaction summaries use a more detailed 8-section handoff format, written for the next model instance rather than for the user:

```markdown
## User Goal
[Active objective(s) and acceptance criteria]

## Current State
### Done
- [Completed item with its concrete result]

### In Progress
- [Unfinished item with exactly where it stands]

### Blocked
- [Blocked item with the precise blocker]

## Files & Artifacts
- [`path` — created/modified/deleted/reverted; key functions/classes]

## Verification
- [Command/test → PASS/FAIL/BLOCKED, exit code, diagnostic error lines verbatim]

## Decisions & Constraints
- [User preferences, technical decisions, environment limits; facts vs inference]

## Failed Approaches
- [What failed or was ruled out, why, and what would have to change]

## Next Actions
1. [Action + target file/command + completion criterion]

## References
- [Issue links, log/artifact paths, other resume pointers]

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

### Message Serialization

Before summarization, messages are serialized to text via [`serializeConversation()`](https://github.com/stepfun-ai/step-harness/blob/main/packages/coding-agent/src/core/compaction/utils.ts):

```
[User]: What they said
[Assistant]: Response text
[Assistant tool calls]: read(path="foo.ts"); edit(path="bar.ts", ...)
[Tool result]: Output from tool
```

Provider thinking blocks are omitted from this view; the stored messages keep them.

This prevents the model from treating it as a conversation to continue.

Oversized tool results are truncated during serialization with a head + tail + salient-lines strategy (defaults: 800-char head, 800-char tail, up to 20 salient lines re-surfaced from the omitted middle, ~2400-char total budget). Salient lines match `error|fail|test|exit|path|diff|warning` or stack-frame patterns (`traceback`, `File "`, `-->`, and `file.ext:123` / `file.ext(123` source locations). A marker records how many characters were omitted and what was kept. This keeps summarization requests within reasonable token budgets while preserving trailing errors and diagnostic lines, since tool results (especially from `read` and `bash`) are typically the largest contributors to context size.

## Custom Summarization via Extensions

Extensions can intercept and customize both compaction and branch summarization. See [`extensions/types.ts`](https://github.com/stepfun-ai/step-harness/blob/main/packages/coding-agent/src/core/extensions/types.ts) for event type definitions.

### session_before_compact

Fired before auto-compaction or `/compact`. Can cancel or provide custom summary. See `SessionBeforeCompactEvent` and `CompactionPreparation` in the types file.

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, reason, willRetry, signal } = event;

  // preparation.messagesToSummarize - messages to summarize
  // preparation.turnPrefixMessages - split turn prefix (if isSplitTurn)
  // preparation.previousSummary - previous compaction summary
  // preparation.fileOps - extracted file operations
  // preparation.tokensBefore - context tokens before compaction
  // preparation.firstKeptEntryId - where kept messages start
  // preparation.settings - compaction settings

  // branchEntries - all entries on current branch (for custom state)
  // reason - "manual" (/compact), "threshold", or "overflow"
  // willRetry - whether the aborted turn is retried after compaction (overflow recovery)
  // signal - AbortSignal (pass to LLM calls)

  // Cancel:
  return { cancel: true };

  // Custom summary:
  return {
    compaction: {
      summary: "Your summary...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      // usage: summaryResponse.usage, // Optional; included in session totals
      details: { /* custom data */ },
    }
  };
});
```

#### Converting Messages to Text

To generate a summary with your own model, convert messages to text using `serializeConversation`:

```typescript
import { convertToLlm, serializeConversation } from "@step-harness/coding-agent";

pi.on("session_before_compact", async (event, ctx) => {
  const { preparation } = event;
  
  // Convert AgentMessage[] to Message[], then serialize to text
  const conversationText = serializeConversation(
    convertToLlm(preparation.messagesToSummarize)
  );
  // Returns:
  // [User]: message text
  // [Assistant]: response text
  // [Assistant tool calls]: read(path="..."); bash(command="...")
  // [Tool result]: output text

  // Now send to your model for summarization
  const { summary, usage } = await myModel.summarize(conversationText);
  
  return {
    compaction: {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      usage,
    }
  };
});
```

See [custom-compaction.ts](../examples/extensions/custom-compaction.ts) for a complete example using a different model.

### session_compact_failed

Fired when manual or automatic compaction fails or is aborted. This is useful for telemetry extensions that need to pair `session_before_compact` attempts with terminal outcomes.

```typescript
pi.on("session_compact_failed", async (event, ctx) => {
  const { reason, errorMessage, aborted, willRetry, fromExtension } = event;
  // reason - "manual" (/compact), "threshold", or "overflow"
  // errorMessage - present for non-abort failures
  // aborted - true for cancelled/aborted compactions
  // willRetry - whether the aborted turn would have retried after compaction
  // fromExtension - whether extension-provided compaction content was being used
});
```

### session_before_tree

Fired before `/tree` navigation. Always fires regardless of whether user chose to summarize. Can cancel navigation or provide custom summary.

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;

  // preparation.targetId - where we're navigating to
  // preparation.oldLeafId - current position (being abandoned)
  // preparation.commonAncestorId - shared ancestor
  // preparation.entriesToSummarize - entries that would be summarized
  // preparation.userWantsSummary - whether user chose to summarize

  // Cancel navigation entirely:
  return { cancel: true };

  // Provide custom summary (only used if userWantsSummary is true):
  if (preparation.userWantsSummary) {
    return {
      summary: {
        summary: "Your summary...",
        // usage: summaryResponse.usage, // Optional; included in session totals
        details: { /* custom data */ },
      }
    };
  }
});
```

See `SessionBeforeTreeEvent` and `TreePreparation` in the types file.

## Settings

Configure compaction in `~/.stepcode/config.toml` or trusted `<project-dir>/.stepcode/config.toml`:

```toml
[compaction]
enabled = true
triggerRatio = 0.9
keepRecentTokens = 20000

[compaction.modelTriggerRatios]
"my-provider/small-window-model" = 0.8
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable auto-compaction |
| `triggerRatio` | `0.9` | Fraction of the context window that triggers auto-compaction (0.5-0.95); small windows trigger earlier to keep response room |
| `modelTriggerRatios` | none | Per-model `triggerRatio`, keyed by `provider/model-id` |
| `tokenLimit` | none | Absolute token ceiling; can only trigger earlier |
| `triggerPolicy` | `"v2"` | `"legacy"` restores the previous threshold and checkpoints |
| `reserveTokens` | `16384` | Legacy trigger headroom; when set explicitly, also caps the v2 trigger at `contextWindow - reserveTokens` |
| `keepRecentTokens` | `20000` | Recent tokens to keep (not summarized) |

Invalid trigger values fall back to their defaults and are reported as settings warnings at startup.

Disable auto-compaction with `enabled = false`. You can still compact manually with `/compact`.

`reserveTokens` never sets the summary output limit.
History, update, split-turn prefix, and branch summaries omit a separate
`maxTokens` override. The provider sizes output from the model's declared limit
and the remaining context space for the actual request. This leaves reasoning
models their normal response budget instead of imposing an extra summary cap.
The existing `generateSummary` and `generateSummaryWithUsage` reserve argument is
retained for call compatibility but no longer selects the output budget.

Summary input includes visible replies, tool calls, and tool results. Provider
thinking blocks are omitted because replayed reasoning may not belong to the
live context and can make the summary request larger than that context. This
only changes the summary view; original session history and successful skill-read
retention remain intact. `keepRecentTokens` stays approximate, and configured
trigger thresholds are unchanged. See the
[compaction integrity contract](../../../docs/compaction-integrity.md) for request
recognition and wire-budget validation.
