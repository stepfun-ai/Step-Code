# Compaction summary overflow recovery

Conversation-history summaries and split-turn prefix summaries can recover when the provider rejects the summary request for context overflow. The first request keeps the existing prompt, serialization, output-token limit, reasoning settings, and routing options. Summary requests continue to use `cacheRetention: "none"`.

After a classified overflow error, the next requests target 70%, 50%, then 35% of the **original rejected request's estimated input size**. The estimate uses the serialized text actually sent, including the system prompt, conversation tags, summarization instructions, custom focus, and any previous summary. Each reduction must produce a strictly smaller request within its target. The percentages are not compounded, and there are at most three reductions.

The reducer removes complete older message groups, oldest first. An assistant's tool calls and all their results form one group, including parallel results and messages interleaved before the batch completes. The retained source preserves:

- The previous summary and summarization/custom instructions verbatim.
- The latest real user request, including image input with blank or absent text, even if synthetic messages follow it.
- The newest assistant group and newest complete tool batch, plus trailing context.
- Checkpoint messages already present in the source, including compaction and branch summaries.

Retained groups use the existing serialization and tool-output truncation. Recovery does not further rewrite their contents. A note inside the conversation reports how many older groups were omitted. If the protected content cannot fit, no further measurable reduction is possible, or tool calls/results cannot be grouped safely, compaction fails explicitly instead of resending an unchanged rejected payload.

Only an error response classified as context overflow activates source reduction. Authentication and other permanent errors retain their failure behavior. Empty summaries, length-limited summaries, and successful responses with large reported input usage do not trigger input loss. Cancellation prevents subsequent requests. Output-integrity validation remains separate from overflow recovery.

Transient errors retain the configured retry policy and reporting callbacks. They retry the current request without reducing it, and the transient retry budget is shared across all overflow reductions for that summary. A summary therefore makes at most four requests plus the configured number of transient retries. A split compaction gives the history and prefix summaries their own budgets, as before. Branch summaries retain their existing behavior.

## Usage and failure contract

When a summary succeeds, its returned usage includes reported usage from the failed overflow/transient attempts as well as the successful response, including cache, reasoning, and cost fields. A successful split compaction combines the history and prefix totals.

`AgentSession` persists usage only with a successful compaction. This change does **not** add persistent accounting for a terminally failed or cancelled compaction, or for a successful history summary followed by a failed prefix summary. Those paths retain the existing failure contract; no usage entry is written for them.

## Regression coverage

`test/compaction-overflow-recovery.test.ts` drives the real summary functions through an injected stream function. It covers both summary paths, protected content and tool pairing, bounded reductions, no progress, cancellation, permanent errors, unchanged successful requests, transient retries, successful usage aggregation, and unchanged branch behavior. Existing summary-reasoning, serialization, transient-stream-drop, and truncated-summary regressions remain applicable.
