# Single bright-blue default theme

Supersedes the blue auto-pair decision in `2026-09-19-blue-default-transparent-content.md`.
The user requests one blue theme, a brighter blue, and no legacy Step light entry.
Keep the violet dark/light pair, existing welcome artwork, and user-message backgrounds.

## Steps

1. **Step** Rename the blue palette to `step-blue`, remove `step-light`, and brighten its anchors.
   **Tool** `apply_patch` on product theme JSON, catalog, and defaults.
   **Expectation** Six built-ins; both terminal appearances resolve the default to `step-blue`.
   Local Kimi Code bundles `primary: #4FA8FF`; installed MiniMax Code 0.4.12 bundles
   dark `brand/accent: #68C0FF` and light `#0094FC`. Choose the brighter `#68c0ff`
   as the single blue anchor, with `#4fa8ff` reserved for the low-thinking accent.
   Keep the existing user-background contrast requirement and truecolor/256 pipeline.
   **Rollback** Reverse only this task's palette/catalog/default hunks.
2. **Step** Put the single default first in onboarding and remove stale theme tips/docs.
   **Tool** `apply_patch` on theme-prompt, status tips, and themes documentation.
   **Expectation** Default labeled `step-blue (default)`; custom auto pairs still work.
   No compatibility aliases or personal configuration rewrites.
   **Rollback** Reverse this task's prompt/tip/documentation hunks.
3. **Step** Update theme-dependent tests and check boundaries.
   **Tool** Focused Vitest files, `npm run check`, structure review.
   **Expectation** Theme/default/picker/contrast tests pass in truecolor and 256 colors;
   no new package dependencies, renderer contracts, or background animations.
   **Rollback** Reverse this task's test hunks, keeping earlier welcome and goal work.

## Scope

No releases, installs, commits, builds, live provider calls, or personal settings edits.
Historical execution records remain unchanged. No feature-branch changelog entry.

## Results

- Catalog: `dark`, `light`, `sage`, `step-blue`, `step-violet`, `step-violet-light`.
- First picker paint now applies the highlighted default, even if login initialized another theme.
- Product theme/default/picker/login/export and dependent product tests: 94 passed.
- Dependent CLI editor/message/overlay/approval/queue/tool tests: 199 passed.
- Non-welcome acceptance snapshots (B/C/C2/D/E/F-G/I): 22 passed, 3 welcome cases excluded.
- The wider CLI run also exercised `step-welcome.test.ts`: 7 passed, 2 failed on
  pre-existing layout expectations (strip before frame and old solid-block wordmark).
  This task changes only its theme fixture name; those unrelated assertions and welcome code remain untouched.
- `npm run check`: passed, including TypeScript and all architecture guards; Biome formatted
  only the changed theme-prompt source/test. npm emitted its two existing unknown-config
  warnings for pnpm's `link-workspace-packages` and `prefer-workspace-packages` settings.
- `git diff --check`: passed. No live terminal session, install, build, or provider request.

## Structure Review

Scope: this task's working-tree hunks; earlier welcome/goal/editor changes retain their own review records.

| Rule | Result | Evidence |
| --- | --- | --- |
| R1 dependency direction | PASS | Only product defaults/theme/prompt and UI tip changes |
| R2 non-UI imports | PASS | No new interactive UI imports; defaults stays in product |
| R3 pure TUI | PASS | No TUI implementation/dependency changes in this task |
| R4 contracts | PASS | No contract changes |
| R5 executable ownership | PASS | No bin changes |
| R6 extension ownership | PASS | No extensions added or moved |
| R7 provider dispatch | PASS | No provider changes |
| R8 stdout startup | PASS | No stdio/bootstrap changes |
| R9 workspace packages | PASS | No new package |
| R10 helper placement | PASS | Default ordering stays in the existing theme-prompt module |
| R11 public exports | PASS | No package export/global symbol changes; theme names changed at user's request |
| R12 responsibility split | PASS | Theme catalog remains product-owned; UI consumes active tokens |

No structural violations or new migration debt.
