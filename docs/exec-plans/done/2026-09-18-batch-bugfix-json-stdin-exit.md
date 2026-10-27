# Batch bugfix: JSON message_start dup, stdin assembly, JSON exit code

Branch: `fix/batch-bugfix`. Four user-reported bugs (feedback 1&2 are the same).

## Bug A — `message_start` leaks streamed content, duplicates first delta (JSON mode)

- **Step**: give the provider `start` event its own empty content array so the
  emitted `message_start` can't alias the mutated `output.content`.
- **Tool**: in each provider, change `stream.push({ type: "start", partial: output })`
  to `partial: { ...output, content: [] }`. Sites: `openai-completions.ts`,
  `anthropic-messages.ts`, `openai-responses.ts`. (`faux.ts` already pushes an
  isolated empty-content partial — verify, only touch if it aliases.)
- **Expectation**: buffering a provider stream and inspecting the `start` event
  shows `partial.content === []` even after deltas mutate the live message.
  Regression test asserts this; JSON `message_start.content` is `[]`.
- **Rollback**: revert the one-line change per provider.

## Bug B1 — piped stdin whitespace-trimmed

- **Step**: preserve raw stdin; keep trim only for the empty/whitespace check.
- **Tool**: `main.ts` `readPipedStdin`: `resolve(data.trim() || undefined)` →
  `resolve(data.trim().length > 0 ? data : undefined)`.
- **Expectation**: `printf '  X  \n' | ...` sends the model `  X  \n...`, not `X...`.
- **Rollback**: revert the one-line change.

## Bug B2 — stdin/@file/CLI joined with no separator

- **Step**: join parts with exactly one newline between them, without adding a
  second when a part already ends in `\n` (fileText always does).
- **Tool**: `initial-message.ts` `buildInitialMessage`: replace `parts.join("")`
  with a small accumulator that appends `\n` before a part only when the current
  buffer is non-empty and does not already end with `\n`.
- **Expectation**: `STDIN`+`CLI` → `STDIN\nCLI`; `@file`+`CLI` stays single-newline
  (no `\n\n`); whitespace-only stdin still treated as absent.
- **Rollback**: revert to `parts.join("")`.

## Bug C — `--mode json` exits 0 on request failure

- **Step**: compute the process exit code for both text and json modes; keep only
  the stdout text-printing text-mode-specific.
- **Tool**: `print-mode.ts`: move the terminatingBlocks and
  `stopReason === error|aborted` → `exitCode = 1` logic out of `if (mode === "text")`;
  guard only the assistant-text stdout print with `else if (mode === "text")`.
  Error/blocked messages stay on stderr (safe for the JSON stdout stream).
- **Expectation**: JSON mode on a failed request returns non-zero, matching text mode.
- **Rollback**: re-nest the block under `if (mode === "text")`.

## Verify

`npm run check`; targeted vitest for the new regression tests; `./test.sh`.
No commit. On a branch other than `main`, so no CHANGELOG entry.

## Review follow-ups (adversarial workflow)

- **Bug A also on the proxy transport**: `packages/agent-core/src/proxy.ts` `processProxyEvent`
  returned `{ type: "start", partial }` aliasing the same mutable `partial` the deltas
  mutate — identical bug on the remote/proxy path. Applied the same one-liner
  (`partial: { ...partial, content: [] }`) + a regression case in `test/proxy.test.ts`.
- **openai-responses had no dedicated snapshot test**: added a third case to
  `start-event-content-snapshot.test.ts` driving `streamOpenAIResponses`.
- **B1 trim-removal was untested and one assembly test was misleading**: exported
  `readPipedStdin` and added `test/read-piped-stdin.test.ts` (raw preserved,
  whitespace-only → absent); reshaped the assembly test to use stdin without a
  trailing newline so it actually fails on the old `join("")`.
- Each new guard was verified to fail against the pre-fix code, then restored.
