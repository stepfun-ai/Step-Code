# Development Rules

## Architecture

`step-harness` is a pnpm monorepo. StepCode is assembled from layered packages
under `packages/` and `apps/`, built on the Pi runtime. Dependencies flow one
direction only: a lower layer must never import a higher one.

### Package layers

Foundation (no internal dependencies):

- `packages/telemetry` (`@step-harness/telemetry`) — vendor-neutral
  telemetry contracts and typed schema utilities.
- `packages/tui` (`@step-harness/pi-tui`) — terminal UI library with
  differential rendering. A standalone presentation toolkit; it must not import
  agent, session, or product code.
- `packages/contracts` (`@step-harness/contracts`) — host-to-agent contracts:
  in-process facade types and wire framing for the step-agent SDK. Pure
  contracts, no business behavior.
- `packages/config` (`@step-harness/config`) — product-neutral configuration
  format, loading, and one-time startup migrations.

Core runtime:

- `packages/providers` (`@step-harness/providers`, depends on `telemetry`) — unified LLM
  API: provider adapters, model discovery, and provider configuration. All
  provider- and model-specific code lives here.
- `packages/agent-core` (`@step-harness/agent-core`, depends on `providers`,
  `telemetry`) — the general-purpose agent: the agent loop (`agent-loop.ts`),
  the harness (context assembly and compaction under `harness/`), transport
  abstraction, session state, and attachments. Product-neutral — it knows
  nothing about coding tools or the TUI.

Product:

- `packages/coding-agent` (`@step-harness/coding-agent`, depends on
  `agent-core`, `config`, `providers`, `pi-tui`) — the coding agent library.
  Owns the read/bash/edit/write tools, session management and persistence wiring
  (`src/core/session-*`), extensions, interactive and one-shot modes, the
  built-in theme catalog (`src/modes/interactive/theme/`), and the StepCode
  integration (`src/step/`).
- `apps/cli` (`@step-harness/cli`, depends on `agent-core`, `coding-agent`,
  `config`, `providers`, `pi-tui`) — the top-level product entrypoint that
  assembles the CLI and compiles the standalone `step` binary.

### Ownership rules

- **Agent loop:** one implementation, in `packages/agent-core` (`agent-loop.ts`).
  `packages/coding-agent` composes the coding product on top of it; it must not
  fork or reimplement the loop.
- **Session authority:** the session model and its persistence contract belong
  to `packages/agent-core`; `packages/coding-agent` wires session management
  (`src/core/session-manager.ts`) for the CLI. Clients (`packages/contracts`, TUI)
  hold only projections, connection state, and local input state.
- **Provider / model contract:** provider adapters, model discovery, and model
  types live in `packages/providers`; in-process facade types and event shapes live in
  `packages/contracts`. Keep provider SDKs out of `agent-core`, the `coding-agent`
  runtime, and `tui`.
- **Tool contract:** tool schemas, registration, permission decisions, and
  execution belong to `packages/coding-agent`. Provider adapters do not
  implement tool orchestration.
- **TUI / themes:** rendering primitives live in `packages/tui`; the built-in
  theme catalog and theme resolution live in `packages/coding-agent`
  (`src/modes/interactive/theme/`). Components consume the active theme — they
  must not hardcode product colors or create a second theme registry.

### Boundary constraints

- Respect the layering: `telemetry` / `tui` / `contracts` / `config` import no
  other internal package; `providers` depends only on `telemetry`; `agent-core`
  depends only on `providers` and `telemetry`; only `coding-agent` and `apps/cli`
  may reach the product layer.
- Do not duplicate prompt, context, or message assembly in a client — those
  semantics belong to `packages/agent-core` (harness) and `packages/contracts`.
- Do not put durable session, transcript, or checkpoint state in `packages/tui`
  components.
- New external integrations go behind an adapter boundary — a provider in
  `packages/providers`, or a dedicated adapter package. Do not import a
  third-party SDK from generic runtime or TUI code.
- Validate host-to-agent event shapes at the `packages/contracts` boundary; a
  renderer must not depend on host internals.
- When a change affects agent-loop behavior, session semantics, tool
  boundaries, provider contracts, or theme contracts, update the matching
  document under `docs/` in the same change.

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks (e.g. `matchesKey(keyData, "ctrl+x")`). Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS` so they stay configurable.
- Never modify `packages/providers/src/models.generated.ts` directly; update `packages/providers/scripts/generate-models.ts` instead, then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. Otherwise run specific tests from the package root:
  - Vitest: `pnpm exec vitest --run test/specific.test.ts` from the package root (vitest is not hoisted to the repo-root `node_modules`, so a repo-root path fails; `pnpm exec` resolves the package-local bin).
  - `packages/tui` (`node:test`): `node --test test/specific.test.ts`
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- When regressions tests for fixing a github issue, add a comment with the github issue number next to the test.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat pnpm dep and lockfile changes as reviewed code. Direct external deps stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `pnpm install --ignore-scripts`; clean/CI-style with `pnpm install --frozen-lockfile --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `pnpm-lock.yaml` with `pnpm install --lockfile-only --ignore-scripts`.
- Pre-commit blocks lockfile commits unless `STEP_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Create all new work branches from `github-opensource`. Target only
`github-opensource` when opening or merging change requests.

Multiple StepCode sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/providers/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,tui,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When opening a merge request (MR):

- Title uses the same `{feat,fix,docs}[(scope)]: <summary>` convention as commits.
- Write the description in the repository house style: Chinese, technical, concise, with `##` sections in this order — `## 背景` (the problem; use `## 背景与判据` when the fix is selective and you must state the criterion for what to fix vs leave), `## 实现` / `## 修复` (grouped; numbered **bold** sub-headers, affected files in backticks, a "修复前:" contrast line where it clarifies), `## 验证` (tests added, pass counts, `npm run check` status, exec-plan landed), and an optional `## 边界` (what this version intentionally does not do). End AI-authored descriptions with the AI-generated attribution line.
- Write the body to a temp file and pass it with `glab mr create --description "$(cat <file>)"` (or `glab mr update <id> --description ...`); never a fragile inline multi-line string.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt.

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Testing Step Interactive Mode with tmux

`./step-test.sh` runs the CLI from source, so it reflects the working tree
without a build (`--no-env` additionally strips provider credentials). Use the
installed `step` instead when you need to verify a built artifact.

Run the TUI in a controlled terminal (from the repo root):

```bash
tmux new-session -d -s step-test -x 120 -y 32
tmux send-keys -t step-test "./step-test.sh" Enter
sleep 3 && tmux capture-pane -t step-test -p     # capture after startup
tmux send-keys -t step-test "your prompt here" Enter
tmux send-keys -t step-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t step-test
```

A first run in a new directory asks whether the folder is trusted; answer it
before sending a prompt. Widths below ~100 columns truncate tool rows, so prefer
a wide session when checking layout.

## Releasing

**Step binary versioning**: Step releases use the product tag `vMAJOR.MINOR.PATCH`. The package versions may remain independent because packages are not published by this project.

1. **Local binary smoke test**: build the standalone Step bundle and smoke test the current-platform binary outside the repo:
   ```bash
   node infra/release/release-bundle.mjs --dry-run --version v0.1.0
   ./scripts/build-binaries.sh --product step --offline-model-data --platform linux-x64 --out /tmp/stepcode-release
   /tmp/stepcode-release/step --help
   /tmp/stepcode-release/step --version
   ```
   Verify the binary starts, reports the tag-derived version, loads native TUI resources, and completes a smoke prompt with the intended Step provider. Failures are release blockers unless the user explicitly accepts the risk.

2. **Public-source boundary**: the public repository only builds local artifacts. Internal tagging, binary publication, object-store upload, and release announcement jobs are intentionally kept outside this source tree.

3. **If an internal binary publication fails**: inspect the private release pipeline and rerun that job after fixing the issue. Do not recreate an existing tag.

## Execution Protocol

For any non-trivial change — a new subsystem, a multi-file refactor, or risky / hard-to-reverse work — plan before you edit:

1. First search `docs/exec-plans/active/` for a related plan and read it.
2. Before writing code or running side-effecting commands, write a short Markdown exec-plan to `docs/exec-plans/active/<YYYY-MM-DD>-<kebab-name>.md`. The filename must start with the plan creation date in ISO format (`YYYY-MM-DD`), followed by a lowercase kebab-case name; for example, `2026-04-01-stepcode-context-pipeline-and-memory.md`. Do not create undated exec-plan filenames. Cover: **Step** (what you will do), **Tool** (command or edit), **Expectation** (the result that means it worked), **Rollback** (how to undo if it fails).
3. For operations with side effects (deleting, publishing, releasing, migrating), request explicit confirmation at the end of the plan before proceeding.
4. Prefer the scripts under `scripts/` over ad-hoc command lines.

Exec-plans are execution records, not user-facing docs: keep them in `docs/exec-plans/active/` while in progress and move them to `docs/exec-plans/done/` once the work is complete (landed, or finished and verified). They are not part of any published docs navigation. When a change alters runtime behavior, tool boundaries, or a cross-process contract, update the matching doc in the same change rather than leaving the plan as the only record.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.

## Commit attribution

- Keep the Git author and committer as the human contributor's verified GitHub identity.
- AI tools may assist with implementation, but they must not be added as commit co-authors.
- Do not add `Co-authored-by` or `Co-Authored-By` trailers for Claude, Claude Code, Codex, ChatGPT, OpenAI, Anthropic, or another AI client.
- Do not mention the client used to create a change in the commit message solely for attribution.
- Before creating or amending a commit, inspect its metadata and remove any AI-client attribution trailer.

This policy applies to commit metadata. Documentation may mention AI products when that is relevant to the product or feature being documented.
