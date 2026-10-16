# Generic harness

Inherits the [agent-core rules](../../AGENTS.md). This directory implements generic context and session mechanisms.

## Responsibilities and entry points

- `agent-harness.ts`, `messages.ts`, `reducer.ts`, `system-prompt.ts`: execution composition, messages, and context semantics.
- `session/`: session state, context, in-memory implementations, JSONL codec / storage / repository, and storage conformance helpers.
- `compaction/`: cut points, summaries, branch summaries, lightweight request-time projection, and invariants.
- `tools/`, `types.ts`, `env/nodejs.ts`: generic tool primitives, explicit filesystem / shell contracts, and environment implementations.
- `skills.ts`, `skill-discovery.ts`, `prompt-templates.ts`: generic resource discovery and parsing.

## Boundaries and invariants

- Messages, session entries, and model-request context are distinct views. Projection changes only the pending request view; it must not rewrite transcripts, session trees, or compaction boundaries.
- Compaction retains current user intent, active tool-call/result pairs, and protected tails. Failure or cancellation must not persist partial summaries.
- Lightweight projection remains deterministic and disableable. Invalid projection falls back to original messages; do not lower estimates to conceal actual context pressure.
- Keep JSONL codec, storage, and repository layers independent. Recovery and branch reads follow existing entry / parent / leaf contracts.
- Tool I/O goes through explicit environment interfaces. Generic execution primitives do not own Step permission presets, approval UI, or product tool naming.
- `packages/coding-agent/src/core/compaction/projection.ts` reuses this package's projection implementation. Do not create a second algorithm; product adapters own product-specific summaries and skill retention.

## Validation and documentation

- From `packages/agent-core`, run `pnpm exec vitest --run --config vitest.harness.config.ts <test/harness/...test.ts>` for affected session, compaction, or tool cases.
- Session implementation changes use the `session/testing` conformance contract. Context changes cover pairing, cancellation, failure, branching, and recovery.
- Update the [harness](../../docs/harness.md) and product [compaction guidance](../../../coding-agent/docs/compaction.md).
