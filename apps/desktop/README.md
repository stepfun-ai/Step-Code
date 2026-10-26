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
  in Finder / Explorer, and name the default browser (name + icon, macOS / Windows) for "open in browser" controls.
  The client checks for it and otherwise falls back to the server's picker / in-page browser / a generic label.
- The user's login-shell environment (macOS / Linux GUI launches), so the agent's bash tool finds the same `git`,
  `node`, Homebrew tools, etc. as in a terminal. On macOS/Linux, a private `node` wrapper also makes Electron's
  bundled Node available when no system `node` is on PATH, including to StepPage's installer and MCP launcher.
  The wrapper's directory is appended to the server's PATH; system Node and explicit MCP PATH overrides still win.
  It is not installed globally and does not change shell profiles.
- Native menus (copy/paste/undo, zoom, fullscreen, DevTools), edit context menu, persisted window bounds,
  single-instance lock, macOS inset traffic lights.
- In-app updates for packaged release builds (see [Updates](#updates)), shown in the sidebar above the account row
  and under **StepCode → Check for Updates…** (macOS) / **File → Check for Updates…** (Windows).

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
 └─ ipc.ts ── pickDirectory / openExternal / revealPath / defaultBrowser
       (only from the window's top frame on the server origin)
```

On quit the server gets SIGTERM, then SIGKILL after 5 s. If it fails to start or exits unexpectedly the window shows
an error page; **File → Restart Server** starts a new one.

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
| `STEPCODE_WEB_CWD` | Default workspace. Otherwise the last folder picked with the native picker, else the home directory. |
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
| `STEPCODE_DESKTOP_UPDATE_URL` | Read updates from this channel directory instead of the one built in (e.g. the test bucket's `.../stepcode/desktop/`, or `http://127.0.0.1:<port>/` for a local test). https only, http for loopback. Packaged apps only. |

Packaging reads the release identity and the feedback endpoints from these. An unpackaged run has no envelope, so it
keeps whatever identity the login shell exported — which is how a source checkout reports something other than the
`0.1.0` fallback.

| Variable | Effect |
| --- | --- |
| `STEPCODE_BUILD_VERSION` | Product version in the staged app and the envelope (a `v0.2.0` tag is accepted). |
| `STEPCODE_BUILD_COMMIT` / `STEP_HARNESS_BUILD_COMMIT` | Commit recorded in the release envelope. |
| `STEPCODE_FEEDBACK_ENDPOINT` | Feedback API URL written into the envelope (http/https, no credentials). |
| `STEPCODE_FEEDBACK_BUNDLE_ENDPOINT` | Feedback bundle URL written into the envelope (http/https, no credentials). |

Electron switches such as `--remote-debugging-port=9222` can be appended to `electron .`.

## Files

- Window bounds and last picked folder: `<userData>/desktop-state.json` (macOS: `~/Library/Application Support/StepCode`).
- Server log: `<logs>/web-server.log` (macOS: `~/Library/Logs/StepCode`), also **File → Show Server Logs**.
- Private Node wrapper (macOS/Linux, when using Electron's runtime): `<userData>/node-bin/node`. Refreshed when
  the server starts so moving or upgrading the app does not leave it pointing at an old executable. Wrapper-write
  failures are warnings, not host-startup failures. An explicit `STEPCODE_DESKTOP_NODE` bypasses this fallback.
- Release envelope (packaged app only): `<resources>/server/stepcode-release.json`, written by `scripts/package.mjs`
  beside the staged server. A source checkout has none, so dev runs keep their own identity.
- Update configuration (packaged with a feed only): `<resources>/app-update.yml`; update log `<logs>/updater.log`;
  downloads in electron-updater's cache (`~/Library/Caches/stepcode-desktop-updater`,
  `%LOCALAPPDATA%\stepcode-desktop-updater`).

The CLI still requires Node.js 20+ on PATH for StepPage. Windows keeps its existing behavior: no POSIX wrapper and
no automatic StepPage installation.

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
| `node scripts/package.mjs --mac --arch=arm64` | One dmg, for the architecture named (default both) |

The GitLab pipeline (`catalyst/falcon-mobile-pipeline`) does not call these directly. It calls the repo-root entry
points, which build the monorepo, drive the two commands above, and copy the installers to `dist-electron/`, where
falcon reads them: `pnpm dist:mac -- --env=<sit|prod> --arch=<all|arm64|x64> [--fast-build] [--notarize]`
(plus `--signed-app` / `--from-app=<.app>` for the notarization stages, see [Signing](#signing)) and
`pnpm pack:win -- --env=<sit|prod> --no-sign`, the latter also writing `dist-electron/latest.yml` and
`dist-electron/channel-artifacts.json`. Both accept `--dry-run` to print the plan without building.

`<version>` is the product version shown by `step --version` and the web host, not the workspace package version:
`STEPCODE_BUILD_VERSION` when set (a release tag such as `v0.2.0` or `desktop-v0.2.0` is accepted), otherwise the
root `package.json` version. Release pipelines set it from the `desktop-vX.Y.Z` tag (see [Releases](#releases)). It is also what the app reports (`app.getVersion()`, `window.stepcodeDesktop.version`).

Each target also gets a `stepcode-release.json` beside the resolved server entry
(`<resources>/server/node_modules/@step-harness/web/dist`), which `src/release-envelope.ts` reads when the shell spawns
the server. It records `version`, `channel: "release"`, `buildTime` (packaging time), `installSource`
(`dmg` for the mac targets, `nsis` for Windows) and, when set at package time, `commit` and the two feedback endpoints.
Optional values are normalized and dropped when invalid (non-http(s), credentials in the URL, control characters,
over-long strings), so a bad value never reaches a report. The file exists only inside the installer; nothing here
commits an endpoint. Its values replace inherited `STEPCODE_BUILD_*`/`STEPCODE_FEEDBACK_*` identity (and
`STEPCODE_VERSION_OVERRIDE`), so a shell exported for a source build cannot change what a packaged app reports.
Without the file (source checkout, `pnpm dev`) the server keeps the inherited environment: the dev/fallback identity
unless the shell exports `STEPCODE_BUILD_*`/`STEPCODE_FEEDBACK_*`.

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

## Signing

Local builds and the ad-hoc falcon jobs are **unsigned** (macOS gets an ad-hoc signature so Apple Silicon starts it;
no notarization). On macOS the first launch needs right-click → Open (or
`xattr -dr com.apple.quarantine /Applications/StepCode.app`); on Windows SmartScreen asks for "More info → Run anyway".

With `CSC_LINK` / `CSC_KEY_PASSWORD` set, `scripts/package.mjs` signs the mac app with that Developer ID instead,
with hardened runtime and `resources/entitlements.mac.plist` / `entitlements.mac.inherit.plist`. Notarization is not
done here: on the CI branch, `.gitlab-ci.desktop-macos-signing.yml` runs falcon's macos-signing stages per architecture
(arm64 and x64): `dist:mac --signed-app` builds the signed app, falcon checks it and submits it to Apple, staples the
ticket, and `dist:mac --from-app=<stapled .app>` wraps that exact app into the dmg and zip. Release tags always take
this path; a Run pipeline takes it with `MACOS_SIGNING_ENABLED=true` on a protected branch.

Windows signing uses the company's GlobalSign EV certificate on a USB token, the same identity
`heimdall/stepfun-desktop` signs with. Only the Windows packager runner (tags `windows` + `bare-metal`) holds the
token, with SafeNet Authentication Client and Single Logon, so no password or certificate variable is involved:
`node scripts/pack-win.cjs --sign` (sets `WIN_SIGN=1`) probes the token, has electron-builder sign `StepCode.exe`,
its DLLs, the installer and uninstaller through `scripts/win-signer.cjs`, signs the PE files of the server tree in
`afterPack`, and checks the app and installer with `signtool verify /pa`. It uses
`build/tools/win/signing/signtool.exe` (CI branch only), SHA-256 with an RFC 3161 timestamp from GlobalSign, and the
certificate thumbprint `WIN_EV_THUMBPRINT` (default: the company EV certificate). After the packager reboots, the
token has to be unlocked once on that machine before CI can sign again. Cross-builds on macOS stay unsigned.

## Releases

Releases are tag-driven, on the private CI branch (`.gitlab-ci.yml`, `.gitlab-ci.desktop-release.yml`), and one
pipeline does all of it:

1. **Run pipeline** on the release branch (or the default branch) with `DESKTOP_BUMP` = `patch` / `minor` /
   `major`. `desktop_tag_release` (`infra/release/desktop-tag-release.mjs`) pushes the next protected
   `desktop-vX.Y.Z` tag on that commit (the first is `desktop-v0.1.0`) without a pipeline of its own, and passes the
   version to the following jobs.
2. The same pipeline builds that version (`STEPCODE_BUILD_VERSION=X.Y.Z`): signed and notarized mac arm64 / x64 dmgs
   and, with `DESKTOP_RELEASE_WINDOWS=true`, the EV-signed Windows x64 NSIS installer (the uploads refuse one without a
   signature). Windows is off for now (the Windows packager runner is down), so releases are macOS only and their
   `latest.json` lists only mac assets. Nothing in the tree is bumped. Running a pipeline on an existing tag repeats
   its release.
3. `desktop_upload_test` (automatic) and then `desktop_upload_prod` (manual) run
   `infra/release/desktop-release.mjs --upload`: the same installers go to `desktop/<v>/` in the test and the
   production TOS bucket, with `SHA256SUMS`, `manifest.json` and finally the channel pointer `desktop/latest.json`.

Stage a release locally without uploading (after `package`):
`node infra/release/desktop-release.mjs --version X.Y.Z --base-url https://example.test/stepcode`.

## Updates

The packaged app updates itself with [electron-updater](https://www.electron.build/auto-update), from the same
`desktop/latest.json` the release pipeline publishes (one file for every platform; `src/update-feed.ts`):

- macOS: Squirrel.Mac installs the `StepCode-<v>-mac-<arch>.zip` of the notarized app. It only accepts an update
  signed by the running app's Developer ID, so ad-hoc local builds cannot update; an x64 app on Apple Silicon may
  move to arm64. A copy run from the disk image or from App Translocation offers no update (move it to Applications).
- Windows: the NSIS installer `StepCode-<v>-win-x64.exe` runs silently with `--updated` into the same folder and
  starts the app again. electron-updater refuses an installer not signed by the publisher in `app-update.yml`
  (the EV certificate subject), so an unsigned build cannot be installed as an update.

The channel is baked in at package time: `STEPCODE_UPDATE_URL=<channel directory>` writes `stepcodeUpdateFeed` into
the app's `package.json` and `resources/app-update.yml`; release CI always bakes the production channel
(`https://static-openapi.stepfun.com/stepcode/desktop/`), so installers from the test bucket update from production too
unless started with `STEPCODE_DESKTOP_UPDATE_URL`. A build without it, and `electron .`, has no updates.

The app checks 15 s after start and then every 4 hours, never downloads on its own, and installs only on
**Restart now** or when the user quits after a download. Restarting stops the server first (the installer replaces
`resources/server`), then electron-updater quits into the installer. SHA-512 and size come from `latest.json`; there
are no blockmaps, so differential download is off.

Test an update locally: package two signed versions with the same feed (e.g. release CI with
`MACOS_SIGNING_ENABLED=true` and two `STEPCODE_BUILD_VERSION` values), serve a `latest.json` naming the newer one's
zip/exe from `http://127.0.0.1:<port>/`, install the older one, and start it with
`STEPCODE_DESKTOP_UPDATE_URL=http://127.0.0.1:<port>/`.
