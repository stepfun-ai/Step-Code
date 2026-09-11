# Persist PATH in the installer (Windows + Unix) so `step` is runnable after install

## Problem

After running the Windows one-liner install (`irm <base>/install.ps1 | iex`), `step` is
not recognized in a new PowerShell:

```
step : 无法将"step"项识别为 cmdlet、函数、脚本文件或可运行程序的名称。
```

User expectation: after install, `step` works directly.

## Root cause (confirmed on this machine — 2026-09-09)

- `step.exe` **is** installed: `C:\Users\admin\.step-cli\bin\step.exe` (127 MB, full
  runtime laid out alongside it).
- The persistent **User PATH does not contain** `.step-cli\bin` (measured:
  `step in USER PATH? = NO`).
- `infra/release/install.ps1` never writes PATH. `Write-Result` (`install.ps1:386-403`)
  only **prints an advisory** ("add these directories to PATH…") and a session-only
  `$env:PATH = …` snippet. It never calls
  `[Environment]::SetEnvironmentVariable('PATH', …, 'User')`.
- When invoked as `irm … | iex`, that advisory just scrolls past; the persistent PATH
  is unchanged, so `step` is missing in every new shell.
- `infra/release/install.sh` (`install.sh:174`) is the same — it prints the install
  path but does not touch any shell rc / PATH either.

Directories that should be on PATH:
- `%USERPROFILE%\.step-cli\bin` (holds `step.exe`)
- `%USERPROFILE%\.step-cli\agent\bin` (managed `fd`/`rg`)

## Immediate workaround (current shell + persist for future shells)

```powershell
$b="$env:USERPROFILE\.step-cli\bin"; $a="$env:USERPROFILE\.step-cli\agent\bin"
$u=[Environment]::GetEnvironmentVariable('PATH','User')
foreach($d in @($b,$a)){ if(($u -split ';') -notcontains $d){ $u="$u;$d" } }
[Environment]::SetEnvironmentVariable('PATH',$u,'User')
$env:PATH="$b;$a;$env:PATH"   # this session, no restart needed
step --version
```

> Safe on **this** machine — the current User PATH is all literal paths (no `%VAR%`
> entries). Do **not** ship this exact form in the installer: see the `REG_EXPAND_SZ`
> hazard under **Step**.

### Why the smoke test didn't catch it

`Test-Install` (`install.ps1:450`) invokes step by its **full path**
(`Join-Path $InstallDir 'step.exe'`), not via PATH — so the install "passes" while bare
`step` is unusable.

### Runtime / self-update notes (not blockers, but relevant)

- The running app does **not** locate itself via PATH (`resolveStepExecutablePath` uses
  `process.execPath`), so this is purely a *user-invocation* problem — fixing the
  installer is sufficient for the reported bug.
- `installLatestStepRelease` re-runs the installer → idempotent PATH logic re-applies
  harmlessly. But `runStepUpdateCommand` replaces files **in place** and never runs the
  installer, so it won't register PATH — fine (PATH is set at first install), worth a
  code comment.
- `fd`/`rg` are resolved by absolute path first, so `.step-cli\agent\bin` on PATH is a
  convenience, not a runtime requirement — include it for parity with the old advisory.

## Step

**`infra/release/install.ps1` — replace the advisory-only `Write-Result` with real PATH
persistence:**

> ⚠️ **Do NOT use `[Environment]::Get/SetEnvironmentVariable('Path',…,'User')`.**
> `GetEnvironmentVariable` returns the **already-expanded** value and `SetEnvironmentVariable`
> writes it back as `REG_SZ`, so any `REG_EXPAND_SZ` entry in the user's existing PATH
> (e.g. `%USERPROFILE%\…`, `%JAVA_HOME%\bin`) is permanently flattened to a literal —
> a data-corruption bug for anyone whose PATH uses `%VAR%`. Instead read/write
> `HKCU\Environment` directly: `Microsoft.Win32.Registry.CurrentUser.OpenSubKey('Environment')`
> → `GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`
> to read, and `SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString)`
> to write — preserving `%VAR%` references.

1. Read the **persistent User** PATH from `HKCU\Environment` un-expanded (see warning
   above), not `$env:PATH` (the merged Machine+User+session value — writing it back to
   User scope would duplicate system entries into the user hive). Treat a missing value
   or `$null` as an empty string; coalesce to `''` **before** calling any string method
   (`Set-StrictMode -Version Latest` makes `$null.TrimEnd(';')` throw).
2. Compute which of `@($InstallDir, (Join-Path $AgentDir 'bin'))` are missing —
   case-insensitive, trailing-backslash-normalized comparison. Append only genuinely
   missing dirs (idempotent on re-run / self-update). If none missing, skip the write.
3. Persist once via the registry `SetValue(... ExpandString)` above, joining with `;`
   (no `;;` or leading `;`).
4. Update current session: `$env:PATH = ($env:PATH.TrimEnd(';') + ';' + ($missing -join ';'))`.
5. Broadcast `WM_SETTINGCHANGE` (0x001A) to `HWND_BROADCAST` with `lParam='Environment'`
   via `Add-Type` P/Invoke `SendMessageTimeout` (SMTO_ABORTIFHUNG, ~5000ms) so Explorer
   and **subsequently-launched** processes pick up the change without reboot. This does
   **not** refresh already-open shells' `$env:PATH` — they must be reopened. Give the
   P/Invoke type a unique name (repeated `Add-Type` of the same type name throws if the
   function runs twice in one session). `try/catch` — broadcast failure must not fail
   install.
6. Wrap the whole persistence block in `try/catch`; on failure (locked-down HKCU) fall
   back to the current printed advisory. Replace the "add … for future sessions" note
   with a confirmation of what was added + "open a new shell to use step".

**`infra/release/install.sh` — close the parity gap (it currently does *no* PATH handling
at all, `install.sh:174`):**

> **Policy decision for the maintainer, not settled here:** the `.ps1` side persists
> silently to the registry, but the Unix equivalent means *editing the user's shell rc
> file* — more invasive, and many installers only print guidance. Pick one and document
> it. Options below assume the auto-edit choice for parity.

- Detect the profile (`~/.zshrc` / `~/.bashrc` / `~/.profile`) and append an idempotent
  `export PATH="$INSTALL_DIR:$AGENT_DIR/bin:$PATH"` guarded by a unique marker comment
  (`# added by step-cli installer`); grep for the marker before appending.
- Regardless of the choice, always print a `source`-able snippet — rc edits only affect
  future shells (no `WM_SETTINGCHANGE` analog), and under `curl | sh` you cannot mutate
  the parent shell.

## Tool

Edit `infra/release/install.ps1` and `infra/release/install.sh`. Extract the
missing-dir computation into a testable helper and add coverage in
`scripts/release-bundle.test.mjs` (currently only tests base-URL substitution):
- Assert rendered `install.ps1` reads/writes `HKCU\Environment` via the registry with
  `DoNotExpandEnvironmentNames` + `ExpandString` (NOT `SetEnvironmentVariable`), does the
  `$env:PATH` session update, and does the `WM_SETTINGCHANGE`/`SendMessageTimeout`
  broadcast.
- Idempotency test: User PATH already contains the dirs → `missing` empty, no append.
- `%VAR%` preservation test: a User PATH containing `%SOMEVAR%\bin` must survive the
  round-trip un-expanded.
- Malformed User PATH (null / trailing `;`) → no `;;` or leading `;`.
- `install.sh`: idempotent marker-guarded rc edit, no duplicate on re-run.
- Note: `step-local-update.test.ts` mocks `installUpdate`, so the real installer never
  runs there — new coverage must target the scripts directly.

## Expectation

A fresh `irm … | iex` install leaves `step` runnable in **newly opened** shells (and in
programs launched from Explorer after the `WM_SETTINGCHANGE` broadcast) without any
manual PATH edit. Already-open shells still need to be reopened — the broadcast does not
retro-edit a live process's `$env:PATH`. Re-running the installer or self-update is
idempotent (no duplicate PATH entries), and existing `%VAR%` PATH entries are preserved
un-expanded. Locked-down environments degrade to the printed advisory instead of erroring.

## Review addenda (2026-09-09)

These refine the **Step** and **Tool** sections above; where they conflict, these win.

1. **Idempotency must compare *expanded* paths (else `%VAR%` PATHs double-append).**
   `$InstallDir`/`$AgentDir` are already expanded to literals at `install.ps1:66-67`, but
   the registry PATH is read **un-expanded** (to preserve `%VAR%`). Comparing a literal
   `C:\Users\me\.step-cli\bin` against an existing `%USERPROFILE%\.step-cli\bin` entry
   fails → duplicate append on every run. Fix: in the missing-dir computation, run each
   existing entry through `[Environment]::ExpandEnvironmentVariables($entry)` **for the
   comparison only**, then write the original un-expanded strings back untouched. Keep the
   case-insensitive + trailing-`\` normalization on top of that.

2. **Guard the session update (Step 4) on `$missing` being non-empty**, same as the
   registry write (Step 3). With `$missing` empty, `$env:PATH.TrimEnd(';') + ';' + ''`
   leaves a trailing `;`. Skip the whole block when nothing is missing.

3. **Open the key writable and tolerate its absence.** `OpenSubKey('Environment')` is the
   read-only overload; write via `OpenSubKey('Environment', $true)` (or
   `[Microsoft.Win32.Registry]::SetValue('HKEY_CURRENT_USER\Environment', …)`). On a
   pristine profile the `Environment` subkey may not exist — create it (`CreateSubKey`)
   rather than throwing.

4. **State why not `setx` / `SetEnvironmentVariable`.** Beyond the `REG_EXPAND_SZ`
   flattening already documented, `setx` truncates PATH at **1024 chars**. Direct registry
   write is the only route that both preserves `%VAR%` and avoids truncation — add a code
   comment so this isn't "simplified" back into a truncating call later.

5. **Env-var knobs must be honored (and tested).** Persistence writes the resolved
   `$InstallDir` / `$AgentDir` **variables**, so custom `STEP_INSTALL_DIR` /
   `STEP_CODING_AGENT_DIR` (`install.ps1:51-64`) are persisted correctly — but this is
   currently untested. Add a test: with `STEP_INSTALL_DIR` set to a custom dir, **that**
   dir is what lands on PATH, not the default `%USERPROFILE%\.step-cli\bin`.
   (`STEP_VERSION` / `STEP_RELEASE_BASE_URL` also exist but are not PATH-relevant.)

6. **`install.sh` policy — DECISION: auto-edit the rc with a marker, matching `.ps1`.**
   Resolving the open question from the **Step** section: persist for parity with Windows
   (don't leave Unix as print-only). Append the marker-guarded `export PATH=…` to the
   detected rc; when `$SHELL` is unset, fall back to `~/.profile` **plus** the detected
   shell's rc. Always also print the `source`-able snippet (rc edits + `curl | sh` cannot
   mutate the parent shell).

7. **Tool assertions are static string-matches — say so, and gate real runs on `pwsh`.**
   The rendered-script substring assertions (Tool section) are the intended level given CI
   can't run PowerShell on Linux. Label them as static checks, and put any
   behavior-executing test behind a `commandAvailable('pwsh'|'powershell')` guard, mirroring
   the existing exec tests in `release-bundle.test.mjs`.

8. **Session update: append, deliberately.** Step 4 appends `$InstallDir` to `$env:PATH`
   (the immediate-workaround snippet above prepends). Appending is the intended choice — it
   won't shadow a pre-existing system `step`. Keep it as append; the prepend in the
   workaround is only for the one-off manual fix.

## Rollback

Revert the edits in the touched installer/test files and remove this plan.
