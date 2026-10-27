# MCP compat migration from Claude Code and Codex

Port the old `~/step-cli` first-run "which agents' MCP servers should we read?"
flow into `step-harness`, changed from a live re-read into a one-time,
user-confirmed migration that writes into `~/.step-cli/config.toml`.

## Background

The old CLI (`~/step-cli`) has three pieces:

- `src/bootstrap/config/mcp-compat.ts` — translates `~/.claude.json`
  (`mcpServers`) and `~/.codex/config.toml` (`[mcp_servers.*]`) into its own
  server shape. Two rules: never throw (a bad foreign entry must not stop
  startup), and report what was dropped (enumerate consumed keys, warn about the
  rest).
- `src/runtime/agent-compat-prompt.ts` + `src/gateway/storage/agent-compat-store.ts`
  — prompt once per source, remember *the question was asked* rather than the
  answer, so declining is durable but a source added in a later release still
  gets asked.
- `src/tui/view/multi-select-view.ts` — a checkbox overlay (pi-tui has no
  checkbox widget): ↑/↓ move, Space toggle, Enter confirm, Esc skip.

Two differences in this repo:

1. `~/.step-cli/config.toml` is the authority (`docs/exec-plans/active/2026-09-09-unified-step-config-mcp.md`
   deliberately rejected reading foreign files at runtime). So this is a
   migration: translate once, write into `config.toml`, never read the foreign
   file again.
2. `StepMcpServerConfig` is already Codex-shaped (`command`/`url` imply the
   transport; `http_headers`, `env_http_headers`, `bearer_token_env_var`,
   `startup_timeout_sec`, `tool_timeout_sec`, `enabled_tools`,
   `disabled_tools`). Codex translation is therefore near-lossless and needs no
   `timeoutMs` collapse, and header/bearer env *variable names* are copied
   verbatim instead of being dereferenced — a resolved bearer token must never
   be baked into `config.toml`.

## Presentation and safety requirements

- The prompt lists **every recognised server individually**, with its name, its
  source, and whether it can be imported. A server that cannot be imported stays
  visible with the concrete reason (`sse transport is not supported`, `no
  command`, `already in config.toml`) rather than disappearing, so an omission
  never reads as a bug.
- Nothing is written until the user selects rows and presses Enter. Esc writes
  nothing.
- `~/.claude.json` and `~/.codex/` are opened read-only and never written,
  renamed, or deleted.
- Every failure mode degrades to a message: missing directory, missing file,
  empty config, unparsable JSON/TOML, and a single malformed server each yield a
  specific reason and leave the rest of the flow running. Nothing throws.

## Name conflicts

The old CLI let a later source overwrite an earlier one by name. The
requirement here is the opposite: nothing may be clobbered.

Allocation, in source order (Claude Code, then Codex), against a `taken` set
seeded with the existing `mcp_servers` keys:

1. Sanitize the foreign name to `[A-Za-z0-9_-]` (it becomes the `<server>__<tool>`
   prefix the model sees); warn when the name changed.
2. If free, use it.
3. If taken by a declaration deep-equal to the candidate, skip the server — the
   migration is idempotent and re-running it adds nothing.
4. Otherwise try `<name>-claude` / `<name>-codex`, then `<name>-claude-2`, `-3`, …

## Steps

| # | Step | Tool | Expectation | Rollback |
|---|------|------|-------------|----------|
| 1 | Translator: `src/step/mcp-import.ts` — `STEP_MCP_IMPORT_SOURCES`, `stepMcpImportSourcePath`, `readStepMcpImportSource`, `detectStepMcpImportSources`, `planStepMcpImport`, `applyStepMcpImport` | write | Foreign servers become `StepMcpServerConfig` values; unknown keys and unsupported transports produce warnings, never throws | `rm` the file |
| 2 | Review store: `src/step/mcp-import-store.ts` — `~/.step-cli/mcp-import.json`, `{schemaVersion:1, reviewedSources:{source:isoTimestamp}}`; unreadable reads as "nothing reviewed" | write | Declining a source is durable; a corrupt file costs one extra prompt | `rm` the file |
| 3 | TUI: `src/step/mcp-import-view.ts` — `StepMcpImportView extends Container`, `SelectList` + `DynamicBorder` + `theme`, one checkbox row per server showing name / source / status, ↑/↓ Space Enter Esc, mirroring `StepOnboardingView` | write | Renders the per-server checkbox list at 80 columns; un-importable rows show `[-]` plus their reason and cannot be toggled; Esc cancels | `rm` the file |
| 4 | Runner: `src/step/mcp-import-prompt.ts` — `runStepMcpImportPrompt`, hosts the view on `TuiMainScreen` like `runStepLogin`, marks reviewed *before* writing config, then `applyStepMcpImport` | write | Returns `{imported, skipped, warnings, cancelled}`; a crash mid-write re-asks rather than silently enabling | `rm` the file |
| 5 | Wire into `src/step-cli.ts` after the login block, inside `if (shouldLaunchMain)`, guarded by `interactiveStartup` | edit | A first interactive launch with a non-empty `~/.codex/config.toml` shows the prompt; `step -p`, `--print`, non-TTY and later launches do not | revert the hunk |
| 6 | Tests: `src/step/mcp-import.test.ts` | `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run src/step/mcp-import.test.ts` | Covers same-name collision across both sources, collision with an existing `config.toml` entry, idempotent re-run, sse/ws rejection, IDE transports dropped silently, unconsumed-key warnings, and the written TOML round-tripping through `readStepConfig` | revert the file |
| 7 | `npm run check` | command | No errors, warnings or infos | fix or revert |

## Side effects

Step 5 makes the first interactive launch write to `~/.step-cli/config.toml` —
only after the user checks at least one source and presses Enter. Esc writes
nothing but records the source as reviewed, so it is not asked again. No foreign
file is ever modified.

## Outcome

All seven steps landed.

- `src/step/mcp-import.ts` — `planStepMcpImport` / `applyStepMcpImport` plus the
  source-status reporting (`ok` / `missing` / `empty` / `error`, each with a
  concrete `detail`).
- `src/step/mcp-import-store.ts` — `~/.step-cli/mcp-import.json`, merge-on-write,
  mode `0o600`, write failures swallowed.
- `src/step/mcp-import-view.ts` — the per-server checkbox screen. Needed two new
  accessors on `SelectList` (`setItems`, `getSelectedIndex`), because rebuilding
  the rows on every toggle requires replacing the item array in place and
  reading the cursor. Toggle is registered as `tui.select.toggle` (default
  `space`) in `packages/tui/src/keybindings.ts` rather than a hardcoded key
  check.
- `src/step/mcp-import-prompt.ts` — `runStepMcpImportPrompt`, hosted on
  `TuiMainScreen` the way `runStepLogin` is. When no source has candidates it
  marks them reviewed and returns without drawing anything, so a user with
  neither agent installed never sees the screen.
- `src/step-cli.ts` — one `await runStepMcpImportPrompt(...)` guarded by
  `shouldLaunchMain && interactiveStartup`.
- `src/step/mcp-import.test.ts` — 16 tests, all passing. Includes a byte-for-byte
  round-trip assertion on `~/.claude.json` after an import, an idempotent
  second-run assertion, and three tests driving `StepMcpImportView` directly
  (rendered rows, Space+Enter selecting only the checked row, blocked rows
  refusing to toggle).
- `npm run check` — clean.

### Known caveat

`packages/tui/dist/keybindings.js` predates `tui.select.toggle`
(`grep -c tui.select.toggle dist/keybindings.js` → `0`). Vitest resolves the
package to `src`, so the tests exercise the real binding, but a script or binary
running against `dist` will not toggle on Space until `packages/tui` is rebuilt.

## Follow-up: correct placement and a debug switch

Two problems with the first landing.

**Placement.** The prompt ran in `step-cli.ts` before `main()`, which puts it
*before* project-trust authorization: trust is resolved inside `main()` while the
runtime's resource loader boots (`main.ts` `resolveProjectTrust`), long after the
`step-cli.ts` call site. The required order is login → trust → MCP import → REPL.
The only hook after both is inside `InteractiveMode.run()`.

Reuse the overlay host that `/login` already uses (`createStepLoginHost`): the
screen then draws inside the main TUI instead of a second standalone
`TuiMainScreen`, so there is no screen swap between trust and the prompt.

**Debug switch.** `STEP_MCP_IMPORT_ALWAYS=1` ignores the reviewed-source record
so the screen appears on every launch. It also suppresses the reviewed write, so
a debug run leaves no trace in `~/.step-cli/mcp-import.json` and the release
behaviour (ask once) is unchanged when the variable is absent.

| # | Step | Tool | Expectation | Rollback |
|---|------|------|-------------|----------|
| 8 | `interactive-mode.ts`: add `stepMcpImport?: (host: StepLoginHost) => Promise<void>` and call it in `run()` after the `exitAfterStartupLogin` return, wrapped so a failure warns instead of aborting the REPL | edit | Prompt renders as a full-viewport overlay after trust; `step login` (exit-after-login) never reaches it | revert the hunk |
| 9 | `main.ts`: add `"stepMcpImport"` to the `interactiveModeOptions` Pick | edit | Product option type-checks | revert |
| 10 | `step-cli.ts`: drop the pre-`main()` call, wire `stepMcpImport` into `interactiveModeOptions` | edit | No standalone screen before the REPL | revert |
| 11 | `mcp-import-prompt.ts`: `STEP_MCP_IMPORT_ALWAYS` forces every source pending and skips `markStepMcpImportSourcesReviewed` | edit | Debug run repeats; unset behaves as before | revert |
| 12 | Tests + `npm run check` | vitest, command | Existing 16 pass, plus coverage for the forced-repeat flag | fix or revert |

### Follow-up outcome

Steps 8–12 landed. Ordering is now fixed by code position rather than by
convention: `main.ts` resolves project trust while building the runtime
(`createAgentSessionRuntime`, line ~1189) and only then constructs and runs
`InteractiveMode` (line ~1330), so anything inside `run()` is necessarily after
trust. Inside `run()` the prompt sits after the `exitAfterStartupLogin` return,
which puts it after `maybeRunStartupLogin` as well.

The call site also gained a guard the pre-`main()` version did not need: it fires
only when there is no `initialMessage`, no `initialMessages`, and no restored
session history. `step "fix this"` and `--continue` reach the REPL without being
interrupted; only a bare `step` is asked.

Interactive smoke test was not run: `tmux` is unavailable in this environment
(`command not found`). Coverage is the 17 unit tests, three of which drive
`StepMcpImportView` directly.

### Interactive verification (tmux)

Ran `step-cli.ts` under tsx with `HOME` pointed at a throwaway fixture holding a
seeded `.claude.json` and `.codex/config.toml`, `STEP_API_KEY` set so the login
step is satisfied, and a project carrying `.step-cli/settings.json` so
`hasTrustRequiringProjectResources` actually fires the trust prompt.

Observed: trust dialog first, then the import screen, then the REPL. Space
toggles a row (5/5 -> 4/5); a blocked row stays `[-]` and the count does not
move. Enter wrote four servers to `~/.step-cli/config.toml` with the Codex
`shared` landing as `shared-codex`; Esc wrote nothing. `~/.claude.json` and
`~/.codex/config.toml` kept their original mtimes in both runs. With
`STEP_MCP_IMPORT_ALWAYS=1` no `mcp-import.json` was written, so the flag leaves
no trace.

Note: a project with no trust-requiring resources never sees a trust prompt at
all (`main.ts` gates `resolveProjectTrust` on `hasTrustRequiringProjectResources`),
so in a bare directory the import screen is legitimately the first thing drawn.
The ordering guarantee is "after trust *if trust is asked*", which is what the
code position gives.

Gap found and fixed during this run: the outcome of `runStepMcpImportPrompt` was
discarded, so a successful import dropped the user into the REPL with no record
of what had been written. `stepMcpImport` now resolves to a notice string which
`InteractiveMode` shows via `showWarning` (the same channel the credential
migration notice uses); `describeStepMcpImportOutcome` builds it and stays silent
for skipped/cancelled/no-op outcomes.

## Follow-up 2: truncated source label, cross-source duplicates, copy

Three defects reported from a real `STEP_MCP_IMPORT_ALWAYS=1 step` run.

**1. "Claude Code" renders as "Claud".** `SelectList` clamps the primary column
to `DEFAULT_PRIMARY_COLUMN_WIDTH = 32` when the caller passes no layout. The
row label is `"[-] " + name.padEnd(19) + "  " + sourceLabel`, i.e. 25 + 11 = 36
columns for `konva-documentation` + `Claude Code`; the clamp cuts it at 30, which
lands mid-word. Fix in the view, not the TUI: measure the widest label and pass
`minPrimaryColumnWidth`/`maxPrimaryColumnWidth`. `renderItem` already re-clamps
to `width - prefixWidth - 4`, so a narrow terminal still degrades gracefully.

**2. Identical servers from both sources import twice.** `resolveCandidate`
compares a colliding name against `existing` (what `config.toml` already holds)
but not against what the *same run* has already allocated. So Claude's `figma`
takes `figma`, then Codex's byte-identical `figma` sees the name taken, finds no
entry in `existing`, and falls through to `figma-codex`. The user's config now
holds `figma`/`figma-codex`, `FeishuProjectMcp`/`FeishuProjectMcp-codex`, and
`chrome-devtools`/`chrome-devtools-codex` — three pairs, each pair identical.
Fix: track the config allocated under each name during the run and compare
against that, which also subsumes the `existing` check.

**3. Header copy.** Replace with the user's wording.

| # | Step | Tool | Expectation | Rollback |
|---|------|------|-------------|----------|
| 13 | Size the primary column to the real content | edit `mcp-import-view.ts` | `Claude Code` renders whole at 100 cols | revert hunk |
| 14 | Dedup identical servers within a run | edit `mcp-import.ts` `resolveCandidate` | Codex `figma` blocks as a duplicate of Claude's, no `figma-codex` | revert hunk |
| 15 | Header copy | edit `mcp-import-view.ts` | new text renders | revert hunk |
| 16 | Tests + `npm run check` + tmux smoke | vitest, tmux | suite green, live run shows all three | revert commit |

Out of scope unless the user asks: the three duplicate pairs already written to
their real `~/.step-cli/config.toml`. The fix stops new ones; it does not edit a
file the user owns.

### Follow-up 2 outcome

Steps 13-16 landed, verified against a copy of the user's real `.claude.json`
and `.codex/config.toml` in a throwaway `HOME`. The same input that produced 11
entries with three duplicate pairs now produces 8 with none.

Two further defects surfaced while fixing the reported three:

- `describeCandidate` prefixed every blocked row with "cannot import", which is
  wrong for a de-duplicated row: that server *is* imported, under the name the
  first source claimed. The prefix is now dropped for `kind: "duplicate"`. The
  name-exhaustion fallback was also tagged `duplicate` despite being a genuine
  failure; it now has its own `name-exhausted` kind so the two cannot be
  confused again.
- `applyStepMcpImport` selects by `targetName`, and de-duplication is precisely
  the case where two candidates share one. Selecting `figma` therefore matched
  the blocked Codex twin as well and reported it under `skipped`, so the notice
  claimed to have both imported and skipped the same name. Blocked candidates
  whose target name is written by another row are now ignored.

### Follow-up 3: intro copy back to English, selection glyphs

Intro paragraph returned to English at the user's request; the rest of the
screen was already English, so the mixed-language state is gone.

`[x]` was read as "excluded" rather than "selected" — the opposite of its
meaning. Replaced the bracket glyphs with themed marks: green `✓` checked,
muted `○` unchecked, muted `-` blocked. The glyph is the narrow U+2713 the rest
of the product uses, not the emoji `✔️`: the emoji presentation occupies two
terminal columns and would undo the column alignment fixed in follow-up 2.
`visibleWidth` strips ANSI, so colouring the glyph does not disturb the label
column measurement.

Known cosmetic trade-off: `theme.fg` emits a colour reset after the glyph, and
`SelectList` wraps the whole selected row in the accent colour, so on the
selected row the text after the glyph renders in the default colour instead of
accent. The row is still marked by the accent `→`. Fixing it properly would mean
threading per-item selection state into `buildItems`, which is not worth the
coupling.

### Follow-up 4: the success notice looked like a failure

The import summary was routed through `showWarning`, which paints it yellow and
prefixes it with "Warning:" — so a clean import read as something having gone
wrong. Added `InteractiveMode.showNotice`: a green `✓` and no prefix word, with
continuation lines indented under the check. The error path in the same block
still uses `showWarning`, which is what that channel is for.

Also reflowed the message: the count line and the server list are now separate
lines instead of one long `…: a, b, c, d` run, and the count reads "8 MCP
servers" rather than "8 MCP server(s)".

### Follow-up 5: imported servers are not live until restart

`step/mcp.ts` discovers and connects servers from a `session_start` handler
guarded by `if (startup) return;` — once per process, never again. In `run()`,
`init()` (which emits `session_start`) is line ~1304 and the import prompt is
line ~1350, so a server written by the prompt is always too late for this
session's discovery. Confirmed live: `/mcp` reported "No MCP servers configured"
immediately after a successful 8-server import, and listed all of them after a
restart of the same fixture.

The notice now says so, on the imported branch only — a failed write has nothing
to restart for. Moving the prompt earlier is not an option: it would put it ahead
of the trust and login gates the placement was chosen for. A live reload would
be the real fix and is a larger change (reconnect, re-register tools, reconcile
against already-registered ones) touching `step/mcp.ts`, which has unrelated
uncommitted edits in the tree; not attempted here.

### Follow-up 6: state moves into config.toml, and an allocation bug it exposed

`~/.step-cli/mcp-import.json` did not earn its own file. The record now lives in
`config.toml`, the file that already answers "what does Step think about MCP
here":

    [mcp_import]
    reviewed = [ ".claude", ".codex" ]

Added `updateGlobalStepConfig` so every writer shares the settings lock, and
re-expressed `updateGlobalMcpConfig` in terms of it. The per-source timestamps
were dropped: nothing read them, and an unexplained date in a hand-edited config
invites questions it does not answer. The legacy JSON file is still read, folded
into the table on the next write, and deleted — so an upgrading user is not
re-prompted and does not keep the file.

Testing the migration surfaced a real bug in follow-up 2's de-duplication.
`planStepMcpImport` allocated names across *both* sources and the pending filter
was applied afterwards, so a source the user is no longer asked about still
claimed names. With `.claude` reviewed and its servers never imported, Codex's
identical `figma` was blocked as "same server as Claude Code" — a duplicate of a
row that is never shown and never written, leaving the server impossible to
import. Live: 3 of 6 Codex servers were wrongly blocked. `planStepMcpImport` now
takes the source list and the pending set is passed in, so only offered sources
allocate; anything a skipped source imported is in `existing` already. Live after
the fix: 6 of 6.

Separately, a concurrent session had rewritten the header copy and left the
sentence dangling at "…config.toml; " with the "your original config files are
not modified" reassurance dropped. Completed the sentence in their wording
rather than reverting the rewrite.

### Follow-up 7: the screen flashed the main UI first

Mounting the offer after `init()` meant `ui.start()` had already painted the
welcome block and editor, and `playLogoIntro()` had already run, so the user saw
the logo and the input box and then watched them be replaced. Moved the call to
the top of `run()`, before `init()`, where nothing has been drawn yet.

The two ordering guarantees survive the move: project trust is resolved by
`createAgentSessionRuntime` while the runtime is being built, which is before
`InteractiveMode` is constructed at all; and Step performs its startup login in
`step-cli.ts` before calling `main()` (`needsStepLoginBeforeInteractive`).
`maybeRunStartupLogin` inside `run()` is Pi's generic path and is inert for Step,
which never sets `startupLoginProvider`.

Consequences handled:

- The call now precedes the `exitAfterStartupLogin` early return, so that flag is
  checked explicitly in the guard. Without it `step login` would be asked about
  MCP servers before showing its login screen.
- `stepMcpImport` no longer receives a host: there is no `this.ui` to overlay onto
  before `init()`, so the prompt uses its own `TuiMainScreen` (the standalone host
  it already had). The signature dropped the parameter rather than passing a host
  that cannot exist yet.
- The notice and the failure warning are held in locals and shown after `init()`,
  since `showNotice`/`showWarning` need the chat container.

Verified by sampling `tmux capture-pane` every 0.4 s across startup: the trust
dialog is followed directly by the import screen, with no frame containing either
"Step CLI /" or "Ask Step to do anything".

## Follow-up 8: ask for project trust unconditionally

User compared Step with Codex: Codex prompts in a bare `~/Downloads`, Step does
not. The two prompts answer different questions. Step's asks "may I load and
execute what is in this directory", and `hasTrustRequiringProjectResources`
gates it consistently with that — nothing to load, nothing to authorise. Codex's
also covers the contents the agent is about to *read*: a hostile README is a
prompt-injection vector regardless of whether the directory ships config. Step
has no equivalent gate. The user asked for the Codex behaviour.

Not just deleting the gate — the default it feeds must flip with it. Today
`projectTrusted` falls back to `!hasTrustRequiringResources || trustStore.get(cwd) === true`,
so a resource-less directory is *trusted* by default; that is only sound while
such a directory is never asked about.

| # | Step | Tool | Expectation | Rollback |
|---|------|------|-------------|----------|
| 17 | Drop the resource gate from `shouldResolveProjectTrust`; fallback becomes `trustStore.get(cwd) === true` | edit `main.ts` | bare `~/Downloads` prompts | revert hunk |
| 18 | Remove the implicit-trust-on-reload path | edit `main.ts`, `interactive-mode.ts` | no silent upgrade of a session-only answer | revert hunks |
| 19 | Prompt text names the injection risk | edit `core/project-trust.ts` | new wording renders | revert hunk |
| 20 | Tests + `npm run check` + tmux | vitest, tmux | suite green; prompt appears in a bare dir | revert commit |

Step 18 removes working code, which normally needs the user's say-so. It is not
optional here: `autoTrustOnReloadCwd` was armed only for directories that could
never be asked, and persists `trusted: true` the moment such a directory grows a
`.step-cli/`. Once those directories *are* asked, a user who answers "Trust (this
session only)" would have that answer quietly promoted to permanent. Reported in
the summary rather than left in.

Escape hatch for anyone who finds the prompt noisy: the existing
`defaultProjectTrust` setting ("always" / "never" / "ask") is consulted before
the prompt, so `always` restores today's silence.

## Follow-up: the trust prompt itself never ran in a plain directory

Verifying step 8's ordering claim by hand exposed a bigger problem than placement:
in a directory with no `.step-cli/` (or `.pi/`) of its own, the trust prompt never
appeared at all, so "MCP import comes after directory authorization" was vacuous
for exactly the directories a new user starts in.

Two copies of the same gate caused it. `main.ts` only built a
`ProjectTrustContext` when `hasTrustRequiringProjectResources(cwd)` was true, and
`resolveProjectTrusted` repeated the check and returned `true` early. Both keyed
on *project config being present*, so trust was decided by whether a directory
carried settings/agents/commands — not by whether it carried files the model
would read.

`step package --local` depends on that rule, though: its two tests require a
directory with project config to be blocked without `--approve`, and one without
project config to be allowed to create the first `settings.json`. That is a
different question ("may I write config here") from the session's ("may I read
what is here"), so the resolver now takes an explicit `alwaysAsk`.

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| 13 | `main.ts`: build `ProjectTrustContext` for every interactive/print launch; pass `alwaysAsk: true` | bare dir prompts | revert hunk |
| 14 | `core/project-trust.ts`: add `alwaysAsk`, gate the early return on it | package CLI keeps bootstrapping | revert hunk |
| 15 | `test/project-trust.test.ts` (new, 6 cases) + full `./test.sh` | 320 files pass | delete file |

### Outcome

Landed. A bare directory now prompts, the answer persists per-directory, and
`default_project_trust = "always"` in `~/.step-cli/config.toml` is the opt-out.
Headless launches (`hasUI: false`) resolve to untrusted rather than silently
trusted. `./test.sh` 320 files / `npm run check` clean.

### Known caveat

`~/.step-cli/config.toml` is TOML, so `default_project_trust` must sit above the
first `[table]` header or it becomes a key of that table. Worth a docs note.

## Follow-up: two answers, and declining actually declines

Two reports against the prompt from the previous change.

**Five options was too many.** The startup prompt now offers `Yes, continue` /
`No, quit`, matching the other agent CLIs. The parent-folder and session-only
variants stay on the `/trust` command, where the user has gone looking for them;
`getProjectTrustOptions` is unchanged and still backs that selector.

**Escape skipped authorization.** It resolved to `false` and the session
continued untrusted — which, after the previous change, protects nothing: the
prompt's own warning is about files the agent reads, and an untrusted session
reads them anyway. So the warning was theatre and Escape looked like a way past
the gate. Declining now throws `ProjectTrustDeclinedError`, which `main` catches
around `createAgentSessionRuntime` and turns into a quiet return — no stack
trace, alternate screen never entered. `No, quit` and Escape are the same answer.

Declining records nothing, so the next launch asks again rather than persisting a
refusal the user cannot easily undo.

The throw is gated on `alwaysAsk`, so `step package` keeps its boolean contract
and its bootstrap path.

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| 16 | Two-label prompt in `selectProjectTrustOption` | live prompt shows two rows | revert hunk |
| 17 | `ProjectTrustDeclinedError`, thrown on decline when `alwaysAsk` | Esc exits to the shell | revert hunk |
| 18 | Catch it in `main.ts` and return | no stack trace on decline | revert hunk |
| 19 | Tests + `./test.sh` + tmux | 320 files pass; all three answers behave | revert commit |

### Outcome

Landed. Live: `Yes, continue` enters the TUI and writes the decision; `No, quit`
and Escape both drop straight back to the shell with no trust file written.
`./test.sh` 320 files, `project-trust.test.ts` now 8 cases, `npm run check` clean.
