# Development and collaboration guide

This guide adds coding and collaboration practices to the [root agent instructions](../AGENTS.md). Module responsibilities remain in their local `AGENTS.md` files; [CONTRIBUTING.md](../CONTRIBUTING.md) owns submission and review requirements, and [testing.md](testing.md) explains validation selection.

## Environment and source of truth

- Use Node.js `>=22.19.0` and the pnpm version declared in the root [manifest](../package.json). Install locked dependencies with `pnpm install --frozen-lockfile --ignore-scripts`.
- Verify behavior against current source, installed dependency types, manifests, and tests. Research and historical design notes do not establish current behavior.
- Read the root and affected local instructions before editing. Check working-tree state and keep the change within the agreed scope.
- Root `pnpm run check` applies Biome fixes to its configured files, then runs type and repository checks. Inspect the resulting diff; a successful command does not imply tests ran.

## Coding conventions

### Names and abstraction

- Follow the surrounding module's naming and file organization. New TypeScript files normally use kebab-case, types / classes use PascalCase, and functions / variables use camelCase; preserve existing public names and external field spellings.
- Keep a function at one abstraction level. Extract a helper when it owns a distinct operation, policy, or reusable behavior; avoid wrappers that merely forward a single call without adding meaning.
- Use options objects when parameters form a meaningful configuration or need clear names. Do not wrap a single internal parameter only for stylistic uniformity.
- Group checks for the same execution phase and collect useful failure context once. Avoid scattered guards and duplicate logs for the same error.
- Preserve the difference between an absent property and an explicitly supplied value. Choose direct optional properties or conditional spreads according to merge, serialization, and caller semantics, not a blanket style rule.
- Reuse existing primitives, registries, keybindings, themes, and feature interfaces. Do not introduce a parallel mechanism or change public exports just to simplify a local implementation.

### Types and validation

- Keep the existing [strict compiler settings](../tsconfig.base.json). The [Biome configuration](../biome.json) currently permits explicit `any`; that permission is not a reason to erase useful types in new code.
- Parse untrusted JSON, configuration, model/tool inputs, durable files, and process/wire data as `unknown`, then narrow at the owning entry point. Validate fields and failure behavior required by consumers.
- Do not repeat runtime validation solely because a typed same-process interface could theoretically receive an invalid value. Validate where data actually enters from an untyped or independently evolving source.
- Prefer discriminated unions for distinct outcomes and narrow before accessing fields. Handle all variants of a closed union; use an intentional, documented fallback for extensible or versioned external input.
- An unavoidable `any`, assertion, or non-null assertion needs a narrow scope and a reason that explains the guarantee or dependency limitation. Do not use `as unknown as`, disabled diagnostics, or a widened type merely to conceal an incompatible value.
- Check optional-value semantics before changing signatures: absence, `undefined`, `null`, an empty string, and an empty collection can have different meanings in configuration and protocols.

### Comments and public interfaces

- Use comments and JSDoc for non-obvious behavior, preconditions, returned results, errors, cancellation, timing, and resource ownership. Public callers must be able to understand the obligations they rely on.
- Do not narrate obvious control flow, repeat nearby types, or keep an implementation conversation in source comments. Keep explanations close to the code they govern.
- Update owning documentation when behavior or public interfaces change. Keep one authoritative description and link related guides rather than duplicate API definitions or defaults.

## Failure handling and asynchronous ownership

- Identify the layer that owns an error: lower layers preserve actionable cause information, while the caller that can recover or present the failure decides what happens next. Avoid logging the same failure independently at every layer.
- Invalid configuration, missing required references, and unknown mutation outcomes must not silently become empty results or success. Stop work that depends on an untrusted state and report what remains uncertain.
- Preserve independent outcome facts. A command can time out and still exit with code zero after trapping a signal; report timeout, signal, and exit status independently under the existing result contract.
- Do not automatically retry side-effecting operations after cancellation, connection loss, or persistence failure without knowing whether they already executed. Read-only or idempotent retries still need a bounded policy and cancellation.
- A best-effort catch must explain why ignoring the failure is safe. Cleanup failures or abandoned-promise rejections may be intentionally contained; configuration failures and data loss must remain visible. Do not broaden the protected block beyond the operation being contained.
- Give background work an owning run or session, observe its rejection, and settle it on cancellation or replacement. Session-wide idle or completion events do not automatically identify the result of one queued message.
- Teardown closes publication / listener paths, requests cancellation, waits for owned work or child exit, and releases timers, subscriptions, locks, and temporary resources. An abort request alone is not proof that teardown finished.
- Late callbacks must check their owning lifecycle before publishing state. Do not let a completed operation update a replacement session or reopen a canceled run.
- Commit durable state before publishing notifications or deriving UI/cache state. A failed write must not leave consumers observing a success that was never persisted.
- Reuse existing process and storage helpers. Cleanup of a possible symlink or junction must remove the link rather than recursively traverse its target; recursive deletion is limited to known owned directories.
- If a listener failure is intentionally contained, report it without starving later listeners, and ensure the owner handles any partial state it changed. Catching an exception does not restore state by itself.

## Collaboration workflow

Use this workflow when several contributors or agents work on the same change. A single-contributor task uses the same scope and verification rules without unnecessary coordination overhead.

1. **Define the result.** Agree on behavior, constraints, affected consumers, and acceptance evidence. Continue already authorized work; clarify only decisions needed to resolve an actual ambiguity.
2. **Assign ownership.** Name the module and file paths each contributor owns, plus one integration owner. Everyone must know other changes may be present in the checkout.
3. **Agree shared interfaces first.** Establish request / result fields, error and cancellation semantics, and persistence or event changes before dependent implementations diverge. Assign one owner to coordinated changes in public types, exports, manifests, and the lockfile.
4. **Work independently within the assigned files.** Use a suitable existing checkout for sequential work. Isolate overlapping concurrent edits in separate worktrees when needed; do not create a worktree for every task automatically or stash / revert another task's changes.
5. **Validate and hand off.** Report changed files, behavior and interface effects, exact commands and results, remaining failures, and unresolved assumptions. Keep temporary working notes local; they are not product documentation or material to stage.
6. **Integrate and review.** The integration owner reviews the combined diff, checks dependent callers, resolves owned conflicts, and selects validation for the final combined tree. Stop a Git operation if its conflicts extend into unrelated work; do not discard that work to finish the task.

An interface change must reach dependent contributors before they continue against an obsolete definition. Independent implementation work can proceed while such a decision is pending. Keep durable design rationale in the owning product documentation, not a transcript of agent messages.

## Git and review workflow

- Follow the English text and Conventional Commit requirements in [CONTRIBUTING.md](../CONTRIBUTING.md#commit-and-pr-conventions). Separate commits by coherent responsibility; do not manufacture extra commits or mix unrelated refactors into a fix.
- Commit and push only within the user's authorization, using the current human Git identity and explicit staging paths. Inspect staged content, formatter changes, and metadata before publishing.
- By default, update published task branches with normal commits. Rewrite their history only when explicitly requested; record the live remote OID and use an exact `--force-with-lease` so another contributor's update rejects the push. Never use raw `--force` or rewrite an unrelated branch.
- After a rewrite, verify remote HEAD and revisit review comments and CI tied to previous commits. Earlier hashes or inline anchors are not current evidence.
- Use the [PR review checklist](../CONTRIBUTING.md#pr-review-checklist). Explain compatibility changes, affected consumers, prompt behavior, validation, and limitations without reproducing the implementation history.
- Report only checks actually run. New changes, unresolved failures, changed artifacts, or relevant environment changes justify new validation; commit or push alone does not.
