# StepCode Desktop

`@step-harness/desktop` is an Electron shell around the StepCode web app. It does not have its own UI or agent
runtime: it starts the same server that `pnpm web:serve` runs (`apps/web/dist/server.js`) and shows the same React
client (`apps/web/dist/public`) in a native window. Sessions, workspaces, settings and credentials are the ones the
CLI and the web host use (`~/.stepcode`), so a conversation started in one is visible in the others.

The shared composer supports workspace `@` file/folder completion: type `@` to list candidates, use arrow keys
and Enter to reference a file or folder, or Tab / the row chevron to enter a directory. Paths with spaces are quoted.
This uses the authenticated Web Host, not Electron filesystem IPC; references stay text and existing pasted uploads
remain separate. See [composer behaviour](../../docs/stepcode-web.md).

What the shell adds on top of the browser version:

- No terminal or browser needed: the server runs under Electron's bundled Node (`ELECTRON_RUN_AS_NODE=1`).
- `window.stepcodeDesktop` (contract: `apps/web/client/src/platform/desktop-bridge.ts`, imported as
  `@step-harness/web/desktop-bridge`): native folder picker, open http(s) links in the system browser, reveal a path
  in Finder / Explorer, name the default browser (name + icon, macOS / Windows) for "open in browser" controls,
  and read/save sidebar tag groups in stable userData storage.
  The client checks for it and otherwise falls back to the server's picker / in-page browser / a generic label.
  `getTheme()` and `setTheme(choice)` restore and persist appearance in this desktop profile, independently of
  the server port. They accept `system`, `light`, `dark` and `violet`; failed writes reject and show a client notice.
  Plain browsers keep their origin-scoped localStorage. A valid local choice is imported when the profile has none.
- The user's login-shell environment (macOS / Linux GUI launches), so the agent's bash tool finds the same `git`,
  `node`, Homebrew tools, etc. as in a terminal. On macOS/Linux, a private `node` wrapper also makes Electron's
  bundled Node available when no system `node` is on PATH, including to StepPage's installer and MCP launcher.
  The wrapper's directory is appended to the server's PATH; system Node and explicit MCP PATH overrides still win.
  It is not installed globally and does not change shell profiles.
- Native menus (copy/paste/undo, zoom, fullscreen, DevTools), edit context menu, persisted window bounds,
  single-instance lock, macOS inset traffic lights.

## Architecture

```
Electron main (src/main.ts)
 ├─ server-host.ts ── spawn ──▶ <electron as node> apps/web/dist/server.js
 │     env: STEPCODE_WEB_PORT=<free loopback port>, STEPCODE_WEB_CWD=<workspace>, STEPCODE_WEB_OPEN=0, ELECTRON_RUN_AS_NODE=1
 │          (STEPCODE_WEB_OPEN=0: the window shows the client, so the server must not open a browser tab too)
 │          packaged: version/channel/commit/buildTime/installSource/feedback endpoints from
 │          <server>/stepcode-release.json replace any inherited STEPCODE_* build identity
 │     stdout "Local: http://127.0.0.1:<port>/#token=<launch token>"  ──▶ parsed (redacted in the log)
 │     stdout/stderr ──▶ <logs>/web-server.log
 ├─ window.ts ── BrowserWindow (contextIsolation, sandbox, no nodeIntegration)
 │     loads http://127.0.0.1:<port>/#token=<token>; the client exchanges it for its auth cookie
 │     navigation pinned to that origin; other http(s) links ──▶ system browser
 ├─ preload.ts (dist/preload.cjs) ── contextBridge ──▶ window.stepcodeDesktop
 │     beginTagGroupClose / completeTagGroupClose ──▶ tag-group-close.ts (native intention + document gate)
 └─ ipc.ts ── pickDirectory / openExternal / revealPath / defaultBrowser / getTheme / setTheme / readTagGroups / saveTagGroups
       (only from the window's top frame on the server origin)
```

On quit, the renderer first drains accepted pending group edits. Only after the actual window closes does the server
get SIGTERM, then SIGKILL after 5 s. Group drain failure or its separate 10s deadline cancels quit and retains the
window and Host. Ordinary macOS window close keeps the Host alive. A failed start shows an error page;
unexpected Host exit attempts that page but a dirty renderer can veto replacement and retain userData IPC access.
**File → Restart Server** first uses the same bounded group drain, then changes origin and stops the old Host.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm --filter @step-harness/desktop start` | Build `@step-harness/web`, bundle the desktop, launch Electron. |
| `pnpm --filter @step-harness/desktop dev` | Bundle the desktop and launch; builds the web app only if its output is missing. |
| `pnpm --filter @step-harness/desktop build` | esbuild: `src/main.ts` → `dist/main.js` (ESM), `src/preload.ts` → `dist/preload.cjs`. |
| `pnpm --filter @step-harness/desktop typecheck` | `tsgo --noEmit` (source and tests). |
| `pnpm --filter @step-harness/desktop test` | Offline Node-environment, hosted-child and release-envelope regressions. |

The packages the server imports (`@step-harness/coding-agent` and below) must be built (`pnpm build` at the root).

## Environment variables

| Variable | Effect |
| --- | --- |
| `STEPCODE_WEB_CWD` | Default workspace. Otherwise the last folder picked with the native picker, else the home directory — except on first use (below). |
| `STEPCODE_DESKTOP_NODE` | Run the server with this Node.js executable instead of Electron's (e.g. for a native-module ABI mismatch). |
| `STEPCODE_DESKTOP_SERVER_ENTRY` | Use another `server.js` build instead of `@step-harness/web/server`. |
| `STEPCODE_WEB_PUBLIC_DIR` | Passed through to the server: serve the client from another directory. |
| `STEPCODE_STEPGO_IMPORT` | Passed through to the server: `0` skips the one-time import of a local stepgo launcher's models and key (see `docs/stepcode-web.md`). |
| `STEPCODE_DESKTOP_PORT` | Fixed server port instead of a free one. |
| `STEPCODE_DESKTOP_START_TIMEOUT_MS` | How long to wait for the server banner (default 30000). |
| `STEPCODE_DESKTOP_SHELL_ENV` | `0` skips the login-shell environment read; `1` forces it even when started from a terminal. |
| `STEPCODE_DESKTOP_SHELL_ENV_TIMEOUT_MS` | Deadline for that read (default 8000). |
| `STEPCODE_DESKTOP_USER_DATA_DIR` | Isolated Electron profile (window state, logs, single-instance lock). |
| `STEPCODE_DESKTOP_SMOKE` | `1`: load the app hidden, print `STEPCODE_DESKTOP_SMOKE {json}` (bridge, auth, `/healthz`), exit 0/1. |

**First-use workspace.** With neither `STEPCODE_WEB_CWD` nor a picked folder, the desktop passes
`STEPCODE_WEB_DOCUMENTS_DIR=<Documents>` to the server, which on a blank installation (no workspace and no session
yet) creates `<Documents>/StepCode/default-workspace`, registers it and launches in it. It is created once: later
launches reuse it, and removing it from the sidebar keeps it from being created again. With a launch folder the desktop
drops any inherited `STEPCODE_WEB_DOCUMENTS_DIR`.

Packaging reads the release identity and the feedback endpoints from these. An unpackaged run has no envelope, so it
keeps whatever identity the login shell exported — which is how a source checkout reports something other than the
`0.1.0` fallback.

| Variable | Effect |
| --- | --- |
| `STEPCODE_BUILD_VERSION` | Product version in the staged app and the envelope (a `v0.2.0` tag is accepted). |
| `STEPCODE_BUILD_COMMIT` / `STEP_HARNESS_BUILD_COMMIT` | Commit recorded in the release envelope. |
| `STEPCODE_FEEDBACK_ENDPOINT` | Optional override for the feedback API URL written into the envelope (http/https, no credentials). Without it the build's own collector route is used. |
| `STEPCODE_FEEDBACK_BUNDLE_ENDPOINT` | Optional override for the feedback bundle URL written into the envelope (http/https, no credentials). |

Electron switches such as `--remote-debugging-port=9222` can be appended to `electron .`.

## Files

- Window bounds, last picked folder, appearance choice and sidebar tag-group metadata: `<userData>/desktop-state.json`
  (macOS: `~/Library/Application Support/StepCode`). Appearance is local to this profile, not shared CLI configuration.
- Server log: `<logs>/web-server.log` (macOS: `~/Library/Logs/StepCode`), also **File → Show Server Logs**.
- Private Node wrapper (macOS/Linux, when using Electron's runtime): `<userData>/node-bin/node`. Refreshed when
  the server starts so moving or upgrading the app does not leave it pointing at an old executable. Wrapper-write
  failures are warnings, not host-startup failures. An explicit `STEPCODE_DESKTOP_NODE` bypasses this fallback.
- Release envelope (packaged app only): `<resources>/server/stepcode-release.json`, written by `scripts/package.mjs`
  beside the staged server. A source checkout has none, so dev runs keep their own identity.

The CLI still requires Node.js 20+ on PATH for StepPage. Windows keeps its existing behavior: no POSIX wrapper and
no automatic StepPage installation.

## Sidebar group persistence

`readTagGroups()` and `saveTagGroups(data)` are narrowly scoped preload/IPC methods, with the same owned-window,
top-frame and server-origin checks as the other bridge operations. They store only versioned group names, colours
and session-id assignments in `desktop-state.json`, preserving its appearance, window and workspace fields. The shared boundary
validator rejects duplicate colours/names/ids, unknown colours, empty names/groups, orphan references and oversized data
(eight colours, 200-character names, 256-character session ids, 10,000 assignments, 4 MiB serialized metadata).

The renderer restores Desktop data before session-list pruning, without delaying the list fetch or bootstrap.
Edits made during recovery queue until restoration succeeds, then validate against confirmed groups plus retained
unconfirmed edits. A conflicting colour or duplicate name
is rejected visibly without merging saved groups. A failed read does not save an empty snapshot; a later list refresh
retries recovery. Each changed snapshot saves before its group fields enter the UI store. Deletion and successful list
pruning use the same path; unchanged snapshots do not write. Complete snapshots are sent in order. The main process
replaces the state file synchronously and atomically before acknowledging a save,
so closing the window or normally exiting immediately after that acknowledgement leaves no pending metadata write.
A failed Desktop read or save remains visible in the existing error toast after ordinary 4200ms notices disappear.
Successful recovery clears only the read error; a changed full write clears only the save error, never a no-op.
Corrupt/unreadable state is protected from all preference writes until a subsequent full read succeeds; repairing
the file alone does not make an incomplete cache safe to save. Valid appearance/window/workspace fields still restore
when only group data is corrupt, and independent edits made while blocked survive recovery. Recovery waits at most
10s and ignores expired late read responses.

`beginTagGroupClose()` claims the current native close/quit/restart intention, or returns null for a manual reload.
`completeTagGroupClose(attemptId, "saved" | "failed")` acknowledges only that window/document's one-time attempt.
Main expires it after 10s. ShellEffects blocks unload only when accepted edits remain, freezes new edits and joins
pending recovery/ordered writes. A failed write stays in the projected snapshot, so a later edit cannot erase it.
Successful drain grants one unload permit; failure/timeout cancels the intention and preserves operations for retry.
A manual reload without a native token drains without closing the window; the next manual reload can proceed.
Clean loading/error pages do not read groups just to close. Main never force-destroys the window. Synchronous disk
I/O can block main's event loop, so the timeout is not an absolute wall-clock bound during an OS filesystem stall.

Plain Web uses `stepcode.tagGroups` in localStorage instead. Desktop never uses that origin-scoped fallback, because
its loopback port can change between launches. Removing the last tagged session still removes the empty group and
frees its colour; archiving a listed session keeps its tag. This does not synchronize groups with CLI/browser
profiles, restore groups already lost before this fix, or guarantee writes interrupted by forced termination,
force-killed processes or power loss. Other page preferences are unchanged.

## Desktop CSS hooks

The client marks `<html data-host="desktop" data-platform="darwin|win32|linux">` when the bridge is present. On macOS
the window uses `titleBarStyle: "hiddenInset"` with the traffic lights at `{ x: 16, y: 16 }`; the client reserves the
top-left strip of the sidebar for them and marks it `-webkit-app-region: drag`. The whole top band (session header,
right panel header, top of the tool rail) is a drag region too, so the window drags and double-click zooms from
anywhere on it; controls inside it opt out with `no-drag`.

## Icons

`resources/icon.svg` is the source: the login page's brand tile (`features/login`, `.login-logo` + `StepCodeMark`)
on the macOS icon grid. `pnpm --filter @step-harness/desktop icons` (macOS; uses Chrome, `sips`, `iconutil`)
regenerates the committed `icon.png` (window / Dock icon at run time), `icon.icns` (macOS bundle) and `icon.ico`
(Windows executable and installer). `electron .` sets the Dock icon from `icon.png`; a packaged app uses the bundle's.

## Installers

Run `pnpm build` at the repo root first, then from the repo root:

| Command | Output in `apps/desktop/release/<version>/` |
| --- | --- |
| `pnpm --filter @step-harness/desktop package` | All of the below |
| `pnpm --filter @step-harness/desktop package:mac` | `StepCode-<version>-mac-arm64.dmg` (Apple Silicon), `StepCode-<version>-mac-x64.dmg` (Intel) |
| `pnpm --filter @step-harness/desktop package:win` | `StepCode-<version>-win-x64.exe` (NSIS, per-user, install folder selectable) |

`<version>` is the product version shown by `step --version` and the web host, not the workspace package version:
`STEPCODE_BUILD_VERSION` when set (a release tag such as `v0.2.0` is accepted), otherwise the root `package.json`
version. It is also what the app reports (`app.getVersion()`, `window.stepcodeDesktop.version`).

Each target also gets a `stepcode-release.json` beside the resolved server entry
(`<resources>/server/node_modules/@step-harness/web/dist`), which `src/release-envelope.ts` reads when the shell spawns
the server. It records `version`, `channel: "release"`, `buildTime` (packaging time), `installSource`
(`dmg` for the mac targets, `nsis` for Windows) and, when set at package time, `commit` and the two feedback endpoints.
Optional values are normalized and dropped when invalid (non-http(s), credentials in the URL, control characters,
over-long strings), so a bad value never reaches a report. The file exists only inside the installer; nothing here
commits an endpoint. Its values replace inherited `STEPCODE_BUILD_*`/`STEPCODE_FEEDBACK_*` identity (and
`STEPCODE_VERSION_OVERRIDE`), so a shell exported for a source build cannot change what a packaged app reports.
Without the file (source checkout, `pnpm dev`) the server keeps the inherited environment: the dev/fallback identity
and the built-in feedback collector route, unless the shell exports `STEPCODE_BUILD_*`/`STEPCODE_FEEDBACK_*`.

`scripts/package.mjs` stages two trees under `release/stage/` and hands them to electron-builder (appId
`com.stepfun.stepcode`):

- `app` → `resources/app.asar`: only `dist/main.js`, `dist/preload.cjs` and the icon.
- `server` → `resources/server` (not in the asar: the server runs from its own directory and spawns node-pty and
  subagent processes from real files): `@step-harness/web` plus its production dependency closure, copied from the
  installed pnpm tree into a flat `node_modules`, so the exact lockfile versions ship. The packaged app resolves
  `@step-harness/web/server` from there.

Native modules are N-API prebuilds for every platform (node-pty, `@step-harness/pi-tui`), so one server tree serves
every target and nothing is rebuilt. Optional per-platform packages that are not installed on the build machine are
left out (e.g. `@mariozechner/clipboard` for Windows; its callers fall back without it).

The builds are **unsigned** (macOS gets an ad-hoc signature so Apple Silicon starts it; no notarization). On macOS
the first launch needs right-click → Open (or `xattr -dr com.apple.quarantine /Applications/StepCode.app`); on
Windows SmartScreen asks for "More info → Run anyway".

## Not included yet

Code signing, notarization and auto-update.
