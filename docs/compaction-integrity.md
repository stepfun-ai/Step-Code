# Compaction integrity

Built-in compaction replaces earlier conversation context with a generated
summary. It must preserve the previous checkpoint when no new history needs
summarizing, and must fail before returning replacement context if a required
summary has no text. The coding-agent and agent-core compaction implementations
enforce the same rules.

## Preserve history during repeated split-turn compaction

A previous checkpoint can contain the only remaining copy of the original goal,
constraints, and verified results. When the next cut falls inside the first
retained turn, `messagesToSummarize` is empty but `turnPrefixMessages` is not.
The earlier summary still belongs in the next checkpoint.

For that case, `compact()` copies `previousSummary` verbatim as the history
portion and generates only the turn-prefix summary. The previous summary does
not need another model request. `No prior history.` is used only when there is
no previous summary. When new history exists, the existing update-summary request
continues to receive `previousSummary`.

## Reject empty generated summaries before assembly

Each history and turn-prefix generation extracts text blocks from the provider
response, then requires `text.trim().length > 0` before returning success. Empty
content arrays, empty text, whitespace-only text blocks, and thinking-only
responses fail this check. Thinking mixed with whitespace also fails. Accepted
text retains its original whitespace and formatting.

Validation happens before combining history and prefix text or appending file
operation metadata. In particular, none of the following can make a missing
generated summary valid:

- A preserved or newly generated history summary beside an empty turn prefix.
- `No prior history.`, the split-turn heading, or its separators.
- `<read-files>` and `<modified-files>` metadata.

Failure of either required generation fails the whole compaction. An empty
history response stops before requesting a turn-prefix summary. An empty prefix
response discards the newly generated history result as a candidate checkpoint.
No partial compaction result is returned.

The coding-agent helpers throw `Summarization failed: empty summary` or
`Turn prefix summarization failed: empty summary`. Agent-core returns a
`CompactionError` with code `summarization_failed` and the same message. Existing
session callers therefore keep their checkpoint, retained messages, and active
context when generation fails. Both manual and automatic built-in compaction
use these helpers.

Length-stop and provider-error diagnostics take precedence over the empty-text
check. Cancellation also remains a cancellation: coding-agent throws an
`AbortError` for an aborted summary response, and agent-core returns error code
`aborted`. Existing bounded retries for transient provider errors are unchanged;
an otherwise successful response with empty text fails without an added retry.

This check prevents missing summaries from being persisted. It does not judge
the factual quality of nonempty model text or validate extension-supplied
compaction results.

## Offline regression tests

The tests import the actual compaction and context modules and use the faux
provider. Coding-agent also exercises the real `AgentSession` and in-memory
`SessionManager`, checking that manual and automatic failures do not append a
checkpoint or change the active messages. Automatic cases also cover histories
without file metadata, where an empty generation previously produced either an
empty handoff or only the fixed split-turn boilerplate. No model service is used.

```sh
# From packages/coding-agent
pnpm exec vitest --run test/suite/regressions/compaction-integrity.test.ts

# From packages/agent-core
pnpm exec vitest --run test/harness/compaction-integrity.test.ts
```
