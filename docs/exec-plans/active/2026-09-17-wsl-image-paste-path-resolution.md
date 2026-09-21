# WSL image-file paste path resolution

Execution record for making a **Windows image path** pasted into a **WSL**
terminal resolve to a usable `@` file reference, instead of being inserted as
raw, broken text.

Created 2026-09-17.

## Problem

On WSL (`process.platform === "linux"`), copying an image file in Windows
Explorer and pasting it into the terminal delivers the **Windows** path as
bracketed-paste text, e.g. `C:\Users\Administrator\Desktop\美女.jpg`. The
existing paste-to-`@`-reference feature (branch `feat/tui-image-paste`) fails
end-to-end here:

1. `onPasteImagePath` (apps/cli/src/ui/runtime/input-dispatch.ts:235) calls
   `cleanPastedPath(content)`. On WSL `platform === "linux"`, so it treats
   backslashes as shell escapes and **strips them**:
   `C:\Users\...\美女.jpg` -> `C:UsersAdministratorDesktop美女.jpg` (mangled).
2. The mangled string still ends in `.jpg`, so `isImageFilePath` is true and the
   paste is claimed; `insertPastedImagePath` runs.
3. In `insertPastedImagePath`: `path.isAbsolute("C:Users...")` is **false** on
   POSIX, and the clipboard fallback's `fs.existsSync("C:\\Users\\...")` is also
   false (the file really lives at `/mnt/c/Users/...`). No path resolves, so the
   original raw text is inserted.

Result: the input line shows `C:\Users\Administrator\Desktop\美女.jpg` as plain
text; the model cannot read the image. The only WSL branch in
`clipboard-image.ts` is for **screenshot image DATA** (Win+Shift+S via
PowerShell), not for a copied **file path**.

Root cause: (a) `cleanPastedPath` corrupts Windows paths on WSL/linux, and
(b) nothing converts a Windows path (`C:\...`) to its WSL POSIX form
(`/mnt/c/...`) before existence checks.

## Step

1. `packages/coding-agent/src/utils/clipboard-image.ts`:
   - Add `isWindowsPath(p)`: true for a drive-letter path (`C:\` or `C:/`) or a
     UNC path (`\\host\...`). Pure, exported.
   - In `cleanPastedPath`: after stripping quotes, if `platform === "win32"`
     **or** the value is a Windows path, return it as-is (do NOT unescape
     backslashes). This keeps genuine POSIX shell-escaped paths working while no
     longer mangling a Windows path pasted on WSL.
   - Add `wslPathToPosix(winPath, { env?, run? })`: returns null unless
     `isWSL(env)` and `isWindowsPath(winPath)`; otherwise runs `wslpath -u
     <winPath>` (async, non-blocking `execFile` via the existing
     `runClipboardCommand`, honoring the "never freeze the UI on a paste"
     design) and returns the trimmed POSIX path, or null on failure/empty. The
     optional `run` injector is a test seam.
   - Export `isWindowsPath` and `wslPathToPosix` from `src/index.ts`.

2. `apps/cli/src/ui/runtime/input-dispatch.ts`:
   - Import `isWindowsPath`, `wslPathToPosix`.
   - In `insertPastedImagePath`, add a branch between the absolute-POSIX check
     and the clipboard fallback: if `isWindowsPath(cleaned)`, `await
     wslPathToPosix(cleaned)`, and if the result is an existing image file, use
     it as `absolutePath`. On non-WSL, `wslPathToPosix` returns null, so a
     stray `C:\...` paste falls back to raw text (unchanged behavior).

3. Tests (`packages/coding-agent`, unit — no real provider, no real `wslpath`):
   - `cleanPastedPath` leaves a Windows path intact on `linux` (regression for
     the mangling bug) and on `win32`; existing POSIX-unescape cases still pass.
   - `isWindowsPath`: drive-letter (back/forward slash), UNC, and negatives
     (POSIX path, bare name, empty).
   - `wslPathToPosix` gating via injected `run`: non-WSL env -> null; non-Windows
     path -> null; success -> POSIX path; empty/failed run -> null; asserts it
     invokes `wslpath -u <path>`.

## Tool

- Edits: `clipboard-image.ts`, `src/index.ts`, `input-dispatch.ts`, and a new
  test file under `packages/coding-agent/test/`.
- Keep all Windows/WSL filesystem logic in the product/util layer
  (`coding-agent`), never in `packages/tui`. No new hardcoded `matchesKey`.
- `npm run check` (full output) after changes. Run the new + touched tests via
  the package-scoped vitest CLI and `./test.sh`.
- No CHANGELOG entry (feature branch, not `main`).

## Expectation

- On WSL under Windows Terminal, copying an image file in Explorer and pasting
  it inserts `@"/mnt/c/Users/Administrator/Desktop/美女.jpg"` (a resolved,
  readable reference), not the raw `C:\...` text.
- `cleanPastedPath("C:\\Users\\a\\pic.png", "linux")` returns
  `C:\Users\a\pic.png` unchanged (was mangled to `C:Usersapic.png`).
- POSIX shell-escaped paths (`/Users/x/a\ b.png`) and doubled-backslash cases
  still unescape correctly; win32 behavior unchanged.
- On non-WSL Linux/macOS, a pasted `C:\...` string cannot resolve and is
  inserted as raw text (no regression, no crash).
- `npm run check` passes; new and existing paste tests pass.

## Rollback

- Revert the four edits and the new test file. No shared session, provider, or
  TUI code is touched; the change is additive behind an `isWSL` + Windows-path
  gate, so reverting restores the prior (macOS/Linux-only) behavior exactly.

## Verification

- Unit tests above pass; `npm run check` passes.
- Real-terminal check (WSL + Windows Terminal): launch step, copy an image file
  in Explorer, paste, confirm the input shows `@"/mnt/c/..."` and the model can
  read the image. Confirm a normal text paste and a POSIX image-file paste are
  unaffected.

## Cross-review outcomes (2026-09-17)

A 5-lens workflow review with adversarial verification surfaced 4 confirmed
findings (3 refuted). Applied:

1. Added a test for the `!isWSL` gate in `wslPathToPosix` (in
   `clipboard-image.test.ts`, where `/proc/version` is stubbed so `env:{}` forces
   `isWSL === false`): asserts null return with no shell-out. The gate was
   previously deletable with all tests still green.
2. Made `readClipboardImagePath` WSL-aware (delegates to `wslPathToPosix`), so the
   Ctrl+V path (`clipboardPaste`) resolves Windows image paths symmetrically with
   the bracketed-paste path — not just the latter.
3. Tightened the `isWindowsPath` UNC branch to require `\\host\share` (not a bare
   leading `\\`), so a shell-escaped leading-backslash POSIX filename (`\file.png`
   -> `\\file.png`) still unescapes correctly. (Kept `cleanPastedPath` pure —
   rejected the reviewer's alternative of adding `isWSL` filesystem I/O into that
   per-paste hot-path function.)
4. Exported `insertPastedImagePath` and added an `apps/cli` composition test
   asserting the resolved POSIX path (not the raw `C:\...`) is threaded into the
   `@"..."` reference, plus the raw-text fallback when resolution fails.

Also fixed a pre-existing break in `clipboard-image.test.ts` (unrelated to the
feature): its `child_process` mock omitted `execFile` (needed by the module's
top-level `promisify(execFile)`), and its "non-WSL" cases were host-dependent;
added the `execFile` mock and a `/proc/version` stub so the suite is green on WSL
and non-WSL hosts alike.
