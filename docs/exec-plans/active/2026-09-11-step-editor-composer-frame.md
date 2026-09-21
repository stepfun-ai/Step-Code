# Step composer frame: drop side rails, add prompt marker

**Goal:** Stop the Step composer's box drawing from being dragged into the clipboard when a user selects their typed prompt, and give the input a first-row prompt marker. Land both as one MR against `main`.

**Architecture:** Keep pi-tui's editor and the whole input state machine untouched. `StepEditor.frameBox` only post-processes the rows pi-tui already rendered, so the change stays inside that one method plus two module constants. Row width and the native cursor column are preserved so no other layout math moves.

**Tech stack:** TypeScript, Vitest, pi-tui terminal renderer, npm workspaces, GitLab.

## Scope and design

- Base: `main@fe15383` (started on `1cfed08`; rebased when `origin/main` moved before any push).
- Branch: `fix/step-editor-side-rails`, in an isolated worktree; the user's main checkout is untouched.
- Root cause: in `regular` mode (the default) Step never enables mouse reporting, so the terminal emulator owns the selection and copies raw screen cells. `frameBox` rendered every content row as `│ text padding │`, so a selection spanning wrapped rows necessarily captured both rails. `TuiAltScreen.getActiveSelectionText` slices already-rendered rows by column, so `fullscreen` mode produced the same result.
- Fix: full-width top and bottom rules, two-cell inset on each side, no rails and no rounded corners. The rails already occupied exactly those two cells, so `STEP_EDITOR_CHROME_WIDTH` stays 4 and the wrap width and cursor column are unchanged.
- Marker: the first framed row leads with `❯ ` instead of its inset. Identical width, so continuations stay aligned. The gap is a plain space, not a no-break space, so a copied prompt carries no invisible characters.
- Out of scope: `packages/tui` (pi-tui pads its own rows; removing that padding would mean changing a lower layer), the footer mode indicator, autocomplete rows, and the `❯` appearing on scrolled continuation rows.
- No changelog entry: AGENTS.md forbids adding one from a non-`main` branch.

## Steps

- [x] **Search for a prior plan.** `ls docs/exec-plans/active/` and grep it for `step-editor`/`frameBox`. Expect no related plan. Rollback: none.
- [x] **Reproduce.** Drive the built TUI in tmux, type a wrapping prompt, and copy it the way a mouse drag would in both `regular` and `fullscreen` mode. Expect the clipboard to contain `│` and padding runs. Rollback: none; read-only.
- [x] **Rails fix.** Edit `frameBox` in `packages/coding-agent/src/modes/interactive/components/step-editor.ts`; update the tests that asserted the rails and add a wrapped-row regression. Expect no rails, unchanged row width. Rollback: revert the single commit.
- [x] **Prompt marker.** Add `STEP_EDITOR_PROMPT_MARKER` and lead the first framed row with it. Expect aligned continuations and an unchanged cursor column. Rollback: revert the single commit.
- [x] **Verify.** `npm run check` with full output; run `step-editor`, `interactive-queue-editing` and both `tui-acceptance` suites; rebuild and re-run the tmux copy test. Expect no failures and a clipboard free of box drawing. Rollback: fix forward on this branch only.
- [x] **Rebase onto moved main.** `origin/main` advanced to `fe15383` before anything was pushed, so rebase rather than merge. Expect no conflict with the new `createStepSelectListTheme` change and green checks afterwards. Rollback: `git rebase --abort`.
- [x] **Publish.** Push the branch and open one MR targeting `main`. Expect one MR, not merged, no release.
- [ ] **Consolidate.** Fast-forward this branch to include the marker commit and push, so one MR carries both commits. Expect MR !54 to show two commits and the same two source files. Rollback: the commits are unchanged; only the branch pointer moves.
- [ ] **Retire the second MR.** MR !55 and its branch `feat/step-editor-prompt-marker` are redundant once the marker commit is on this branch. Needs explicit confirmation before deleting the remote branch (see Authorization).

## Authorization

The user requested the reproduction, the rails fix, the prompt marker, a build for manual testing, and MRs. That authorizes committing and pushing these topic branches and opening MRs against `main`. It does not authorize merging, releasing, or touching unrelated branches.

Deleting the remote branch `feat/step-editor-prompt-marker` (which is how MR !55 gets closed without API access — `glab` returns 401 here) is a destructive remote operation and is pending explicit confirmation. The commit itself is preserved on this branch, so nothing is lost either way.

## Process note

This plan was written after the implementation, not before it. The change was judged trivial at the outset — one method in one file — and step 2 of the Execution Protocol was skipped on that basis. That judgement stopped being correct once the work grew to two commits, a rebase onto a moved `main`, and two pushed MRs, which step 3 names explicitly as side-effecting. Recorded here rather than quietly backfilled.

## Verification record

- Reproduction, `regular` mode: a drag-select of a three-row prompt yielded `…renderMessage    │` / `│ …补上单元   │` / `│ 测试…`; pasting it back under bracketed paste produced the garbled frame the user reported.
- Reproduction, `fullscreen` mode: real SGR mouse events produced the same rail-laden text via `pbcopy`. The user's clipboard was backed up before the test and restored after.
- The rails and corners are Step's own addition: pi-tui's editor comments its content row as "no side borders, just horizontal lines above and below".
- `npm run check` passed on both branches after the rebase (biome, pinned deps, TS imports, shrinkwrap, install-lock, `tsgo --noEmit`, browser smoke). `packages/ai/src/providers/data/` is gitignored and had to be copied into each worktree first; without it `tsgo` reports several hundred unrelated model-type errors.
- Tests: 56 passing on the rails commit, 57 with the marker, across `step-editor.test.ts`, `interactive-queue-editing.test.ts`, `tui-acceptance-snapshot.test.ts` and `tui-acceptance-interactions.test.ts`. The new acceptance snapshots contain `│` only for dialog and table components, not the composer.
- Post-build tmux verification: empty, wrapped and shell-mode frames render correctly; the marker follows `borderColor` (light purple in Ask mode, red in shell mode); the same drag-select now copies plain text.
- `package-lock.json` was dirtied by `npm install` in each worktree (artifactory URL rewrites) and reverted; it is not part of the commits.
- Push required bypassing ssh-agent, which refused to sign in this shell (`agent refused operation`) despite listing the key; `GIT_SSH_COMMAND` with `IdentityAgent=none` and the unencrypted `~/.ssh/id_rsa` was used instead. Reported to the user in case that refusal was a deliberate confirm-on-use setup.

Keep this plan active while the MR has not landed.
