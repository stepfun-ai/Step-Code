# Literal search result paths implementation plan

> Execution: follow `superpowers:executing-plans` inline, with TDD and independent review.

**Goal:** Fix `search_files` silently dropping TODO matches in dynamic-route paths and open one MR against `main`.

**Architecture:** Keep the native grep backends, tool schema, limits and context rendering unchanged. Parse rows by their existing `path:line: text` structure instead of rejecting a legal path because it starts with `[` or `WARNING:`. Native notices without that structure remain excluded.

**Tech stack:** TypeScript, Vitest, native ripgrep/git/POSIX search, npm workspaces, GitLab.

## Scope and design

- Base: `main@1413955b75d5599954404c3e197eae00b2621930`.
- Branch: `fix/search-files-bracket-paths`, in an isolated worktree; do not change the user's plan-task branch.
- The reported two-file fixture must return both `[slug]/page.tsx` and `static/page.tsx`, with accurate match/file counts and no false truncation.
- Cover `[slug]`, `[...slug]`, `[[...slug]]`, default/explicit search roots and zero/nonzero context. Verify a real native match-limit notice is not counted as a result and truncation metadata remains correct.
- Prefer the existing row parser over a new exact-warning allowlist (fragile when native notice wording changes) or a structured grep API redesign (unnecessary for this fix).
- No changes to `find_files`, backends, permissions, dependency manifests, lockfiles or release tags. No macOS binary validation claim from Linux tests.

## Steps

- [x] **Baseline.** Install pinned dependencies without lifecycle scripts (`npm ci --ignore-scripts`), using a supported Node runtime; run the existing profile tests. Expect a clean baseline. Rollback: leave the original worktree untouched; remove only task-owned temporary setup if needed.
- [x] **RED.** Add the dynamic-route and notice regressions in `packages/coding-agent/test/step-tool-profile.test.ts`; run `node ../../node_modules/vitest/dist/cli.js --run test/step-tool-profile.test.ts` from `packages/coding-agent` with offline tool setup. Expect assertions about missing route matches to fail, not setup/import errors. Rollback: remove only the new tests if the approach is abandoned.
- [x] **GREEN.** In `packages/coding-agent/src/step/tool-profile.ts`, remove the blanket prefix exclusion in `parseNativeSearchRows`, retaining row-shape validation and documenting why legal paths cannot be treated as notices. Run the focused tests again; expect all cases to pass. Rollback: restore only this task's parser change.
- [x] **Docs.** Document literal returned paths in `packages/coding-agent/docs/step-integration.md`; add concise Unreleased fix entries to the root and coding-agent changelogs for this MR. Expect no unrelated docs or released-entry changes. Rollback: remove only these additions.
- [ ] **Verify and review.** Run `npm run check` with full output, relevant native grep/profile tests, `./test.sh` in its sanitized environment, and `git diff --check`. Review the exact diff independently. Expect no new failures or unrelated changes; record any pre-existing/environment failures explicitly rather than claiming success. Rollback: revise only this fix; do not modify unrelated behavior to make checks pass.
- [ ] **Publish.** Stage only the explicit fix/test/doc/plan paths, commit, push this branch, check for an existing MR from it before creating one, and GET the created MR to verify its target and head SHA. Expect one MR targeting main, not merged and no release. Rollback: do not force-push or merge; report any publication problem without duplicate POSTs.

## Authorization

The user explicitly requested the fix followed by an MR in this thread. This authorizes the topic-branch commit/push and one MR, not merging, releasing, deleting remote branches or modifying unrelated worktrees.

## Verification record

- Baseline: the existing profile suite passed (11/11).
- RED: all 14 new cases failed for the expected omitted match; the existing 11 tests still passed.
- Runtime: Linux, Node 24.21.0, ripgrep 15.0.0; isolated test home and no provider credentials. This is not a macOS standalone-binary test.
- Dependencies were installed with lifecycle scripts disabled. Ignored provider data was reused from the original checkout after source comparison and passed the model-data validator; no dependency or generated-catalog changes are included.
- GREEN: `step-tool-profile.test.ts` and `grep-fallback.test.ts` passed, 32/32 tests. The profile suite includes the 14 new regressions.
- `npm run check` passed, including formatting/lint, pinned dependencies, TypeScript imports, generated install manifests, type checks, and browser smoke. Its only formatting change was in the new parameterized test.
- Independent read-only code review approved MR preparation with no introduced blockers. It noted the pre-existing context-row ambiguity in the unchanged greedy row regex; that broader parsing issue is not expanded into this fix.
- `./test.sh` is running with an isolated home, no API credentials, and bounded CPU affinity. Its final result and the pushed commit's CI status will be recorded in the MR/worklog before publication is considered complete.
- Publication/readback is pending this commit. The user authorized pushing the topic branch to run CI before opening the single MR.

Keep this plan active while the MR has not landed.
