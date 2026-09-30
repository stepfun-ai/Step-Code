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

## Bound generated summary output

`reserveTokens` also sets the automatic trigger:
`contextTokens > contextWindow - reserveTokens`. Raising it must not raise a
summary request above the model's output limit or the existing 32000-token
summary ceiling. Both compaction implementations clamp the final candidate
budget after considering the reserve fraction and model budget. History and
history updates use fraction 0.8; split-turn prefixes use 0.5.

For a model declaring `contextWindow=1048576`, `maxTokens=65536`, a 196608-token
trigger uses `reserveTokens=851968`. History and prefix requests both have output
cap 32000. Previously their caps were 681574 and 425984. A positive lower model
limit is respected; when `maxTokens <= 0` denotes an unknown limit, the reserve
fraction remains the fallback, bounded by 32000.

Settings defaults and valid budgets are unchanged. In particular, a 65536-output
model keeps its 32000 summary cap with either the session's 16384 reserve or the
low-level helper's 24576 reserve. With an unknown model limit and reserve 24576,
history remains 19660 and prefix remains 12288. Ordinary model requests still use
their existing output budget; this change only bounds generated compaction
summaries. No new setting is introduced.

## Recognize compaction requests without relaxing the normal cap

Both implementations currently use the same system prompt: 581 UTF-8 bytes,
SHA-256 `7f4677db342c3991df3ed0ba729c514db1772ef7af4c39155d2a0d87d08b12bb`.
Hash decoded prompt text exactly: retain whitespace/newlines and do not add a
trailing newline. The text is `SUMMARIZATION_SYSTEM_PROMPT` in each compaction
`utils.ts`. The complete generated static instruction suffixes are pinned as:

| Kind | UTF-8 bytes | SHA-256 |
| --- | ---: | --- |
| History | 2702 | `4379f7f63f9fbd36f3f273e94b9566d78967e2e938e4b483957bf67266490572` |
| Prefix | 2948 | `0a355395dcd867cb08c3be3229d31475b3a468c51021489fcca4fab6c967cdb6` |
| Update | 3457 | `90546e9b55c76b8ac2570b98b0d2849cb3808f102097f52f643b00253edbb333` |

For the OpenAI Chat transport, positively identify a built-in compaction only
when all of these hold:

1. The top-level system message matches the pinned system prompt exactly.
2. The request has exactly a system message and one user message, both text-only,
   with no `tools` or `tool_choice` field.
3. The entire user text matches the generated framing: `<conversation>\n...\n</conversation>\n\n`
   followed by the exact pinned history or prefix instructions. An update also
   has `<previous-summary>\n...\n</previous-summary>\n\n` before its exact update
   instructions. History/update may append `\n\nAdditional focus: ...`; prefix
   does not append it. The match must be unambiguous and anchored, not a search
   for a phrase anywhere in the transcript.

The static suffix starts with `The messages above are a conversation to summarize.`,
`The messages above are the PREFIX of a single turn`, or
`The messages above are NEW conversation messages`, respectively. These starts
are labels for inspection; they are not sufficient classifiers on their own.
The complete suffix includes the eight-section format and detail rules.

Branch summaries share the system prompt but have different instructions and a
2048-token output budget. The system hash alone must not grant a compaction cap
allowance. Unknown, drifted, or ambiguous summary-shaped requests require review.
A normal request containing quoted summary instructions remains normal; neither
an observed 32000 cap nor a session ID establishes that a request is compaction.
The coding-agent main system prompt varies with runtime resources and configuration
and therefore has no single compaction-style static hash.

For the Harbor adaptive custom-model profile, the generated model overlay omits
`reasoning`, `thinkingLevelMap`, and `compat`, and the adapter emits no `--thinking`
flag. The model loader defaults `reasoning` to false. The default OpenAI Chat
serializer emits `max_completion_tokens`: 65536 for normal requests and 32000 for
recognized compaction requests with this model. Neither kind includes
`reasoning_effort` or `thinking`. Do not add `--thinking off` merely to test this
profile. Other integrity checks, including model identity and no-effort fields,
still apply to every request.

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

Budget and adaptive wire regressions are also offline:

```sh
# From packages/agent-core
pnpm exec vitest --run test/harness/compaction-summary-budget.test.ts

# From packages/coding-agent
pnpm exec vitest --run test/compaction.test.ts -t 'summary output budget'
pnpm exec vitest --run test/suite/regressions/compaction-adaptive-wire.test.ts
```

The adaptive fixture was generated with the Harbor adapter's actual overlay
builder using a synthetic model ID and endpoint. The native test loads it through
the model registry, injects an offline HTTP fetch backed by the suite faux
provider, forces automatic history/prefix compaction, and verifies an explicit
history update. It pins the system and static instruction bytes, checks both
normal and summary wire caps, and supplies no thinking-level override.
