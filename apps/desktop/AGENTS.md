# apps/desktop — StepCode Desktop (Electron shell)

These rules add to the repository rules in `../../AGENTS.md` (commit attribution, Git safety, dependency security,
exec-plans, conversational style). Where the two disagree, this file wins for code under `apps/desktop/`.

`@step-harness/desktop` is a thin Electron shell. It has **no UI and no agent runtime of its own**:

- it starts the StepCode Web host (`@step-harness/web/server`, i.e. `apps/web/dist/server.js`) under Electron's Node;
- it shows the same React client (`apps/web/dist/public`) in a `BrowserWindow`;
- it adds what a browser cannot do, through a small preload bridge (`window.stepcodeDesktop`).

Sessions, settings, credentials and workspaces are shared with the CLI and Web (`~/.stepcode`).

**Rule of thumb:** UI, session or server behaviour is changed in `apps/web` (see `apps/web/AGENTS.md`), never here.
This package only changes when the change needs the OS, the window or the process that hosts the server.

## Tech stack

| Area | Choice | Notes |
|---|---|---|
| Shell | Electron 44.7 | Main process + sandboxed preload; renderer is the web client |
| Language | TypeScript strict, ESM | Type-checked by `tsgo -p tsconfig.json --noEmit` |
| Bundler | esbuild 0.28 (`scripts/build.mjs`) | `src/main.ts` -> `dist/main.js` (ESM); `src/preload.ts` -> `dist/preload.cjs` (CJS: sandboxed preloads cannot load ES modules) |
| Server | `@step-harness/web` (workspace dependency) | Spawned with `ELECTRON_RUN_AS_NODE=1` |
| Lint / format | Biome (root `biome.json`) | Tabs, indent width 3, line width 120 |
| Installers | electron-builder 26.15 (dev dependency, `scripts/package.mjs`) | dmg (mac arm64 / x64), NSIS (win x64); unsigned |

No other runtime dependencies. Adding one needs the user's approval; pin it to an exact version and install with
`pnpm install --ignore-scripts`. Do not add a renderer framework, a second web server or native Node modules.

## Directory layout

```
apps/desktop/
  AGENTS.md / CLAUDE.md
  README.md              architecture, scripts, environment variables, files (keep in sync)
  package.json           main: dist/main.js
  tsconfig.json
  scripts/build.mjs      esbuild bundle; --ensure-web builds @step-harness/web if its output is missing
  scripts/package.mjs    stage the app and the server's dependency closure, write the release envelope, run electron-builder
  scripts/icons.mjs      regenerate resources/icon.{png,icns,ico} from resources/icon.svg (macOS)
  resources/             app icons; icon.svg is the source
  src/
    main.ts              app lifecycle, single-instance lock, wiring, smoke mode
    server-host.ts       resolve server entry, pick a free loopback port, spawn, parse the #token banner, log, stop
    release-envelope.ts  validate the packaged stepcode-release.json and map it to the server's identity environment
    window.ts            BrowserWindow options, navigation pinning, external links, macOS inset title bar
    preload.ts           contextBridge -> window.stepcodeDesktop (implements the web contract)
    ipc.ts               ipcMain handlers + sender validation
    ipc-channels.ts      channel names shared by preload and main
    menu.ts              application and edit context menus (incl. File -> Restart Server / Show Server Logs)
    pages.ts             error / loading pages shown when the server is not available
    shell-environment.ts read the login-shell environment for GUI launches
    node-environment.ts  private Electron-backed node fallback for macOS/Linux child processes
    state.ts             persisted window bounds and last picked folder (<userData>/desktop-state.json)
  dist/                  build output; never edit
  release/               installers and their staging tree (git-ignored)
```

## Security rules (do not relax)

- `BrowserWindow` keeps `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`,
  `webviewTag: false`.
- The window may only navigate within the server origin (`http://127.0.0.1:<port>`). Other http(s) links open in the
  system browser; every other scheme is refused.
- The preload exposes only the functions of `StepcodeDesktopBridge`, each a single `ipcRenderer.invoke` on a named
  channel. Never expose `ipcRenderer`, `require`, `fs`, `shell` or a generic "invoke any channel" helper.
- Every `ipcMain.handle` validates the sender (top frame, server origin) through the existing check in `ipc.ts` and
  validates its arguments (types, absolute paths, http(s) only for `openExternal`).
- The server listens on loopback only. The launch token is redacted in logs; never print it or write it to disk.

## The bridge contract

The contract is `apps/web/client/src/platform/desktop-bridge.ts`, imported here as a type from
`@step-harness/web/desktop-bridge`. Both sides must agree, so adding a capability is one change across both packages:

1. Add the method to `StepcodeDesktopBridge` (doc comment: what it does, what it resolves to).
2. Add the channel name to `src/ipc-channels.ts`.
3. Add the validated handler to `src/ipc.ts`.
4. Expose it in `src/preload.ts`.
5. In the client, call it through `getDesktopBridge()` and keep a browser fallback (or hide the control when there is
   no bridge).
6. Document it in `README.md`.

Type checks of both packages (`pnpm run check`) catch a mismatch; do not cast around them.

## Server hosting rules

- Do not start the server with the workspace as its cwd. macOS privacy (TCC) makes `uv_cwd` fail inside protected
  folders such as `~/Documents`; the server runs from its own directory and gets the workspace via `STEPCODE_WEB_CWD`.
- Pass new server settings as environment variables, documented in both `apps/web/AGENTS.md` and `README.md`.
- The server's stdout/stderr go to `<logs>/web-server.log`. A failed start or unexpected exit shows the error page and
  keeps **Restart Server** working.
- On macOS/Linux, append `<userData>/node-bin` to the server's PATH. Its private `node` wrapper runs Electron with
  `ELECTRON_RUN_AS_NODE=1`, so StepPage works without a system Node while MCP still uses its restricted environment.
  System Node and explicit MCP PATH overrides retain precedence. Do not modify global PATH or shell profiles.
- A packaged app carries `stepcode-release.json` beside the server entry. `src/release-envelope.ts` validates it and
  supplies version, channel, commit, build time, install source and feedback endpoints; its values replace inherited
  identity variables. Do not add a second source for those values, and keep source/dev launches without an envelope.
- Desktop environment variables (`STEPCODE_DESKTOP_*`) are listed in `README.md`; update that table when you add one.

## Coding conventions

- Main-process code is plain functions and small modules; keep each file to one responsibility as listed above.
- Use Electron and Node APIs from their documented types (`node_modules/electron/electron.d.ts`); do not guess.
- No `any`, no inline/dynamic imports, no `enum` / `namespace` / parameter properties.
- Platform branches (`process.platform`) live in the main process; the renderer only reads `data-host` /
  `data-platform` set by the web client from `bridge.platform`.
- Menus and error pages are English only (`menu.ts`, `pages.ts`); keep new strings short and in the same style. Text
  inside the window comes from the web client's i18n, not from here.

## Commands

Run from the repo root.

| Command | Use |
|---|---|
| `pnpm desktop` | Build the web app, bundle the desktop, launch Electron |
| `pnpm --filter @step-harness/desktop dev` | Bundle and launch; builds the web app only when its output is missing |
| `pnpm --filter @step-harness/desktop build` | esbuild bundle only |
| `pnpm --filter @step-harness/desktop typecheck` | Type check source and tests (also part of `pnpm run check`) |
| `pnpm --filter @step-harness/desktop test` | Offline child-process, Node fallback and release-envelope regressions |
| `pnpm --filter @step-harness/desktop package[:mac\|:win]` | Unsigned installers in `release/<version>/` (run `pnpm build` first; see README) |
| `STEPCODE_DESKTOP_SMOKE=1 pnpm --filter @step-harness/desktop dev` | Load hidden, print `STEPCODE_DESKTOP_SMOKE {json}`, exit 0/1 |
| `pnpm run check` | Required before handing back any code change |

The packages the server imports must be built first (`pnpm build` at the root). After a web change, rebuild the web
app (`pnpm --filter @step-harness/web build`) and restart the desktop (or File -> Restart Server for host-only
changes).

## Testing

- Any change here: `typecheck` and `test`, then launch the app and exercise what you changed. Report what you checked.
- Change to the bridge, window or server hosting: also run the smoke mode, and one real session in a scratch
  workspace that edits a file (confirm the change on disk).
- Automation: append `--remote-debugging-port=<port>` to `electron .` and drive the window over CDP. Use an isolated
  profile (`STEPCODE_DESKTOP_USER_DATA_DIR=/tmp/...`) so you do not touch the user's window state.
- macOS privacy: an Electron started from a terminal inherits that terminal's file permissions. To test folders under
  `~/Documents`, `~/Desktop` or `~/Downloads`, launch with `open -n -a .../Electron.app --args <apps/desktop path>` and
  let the user grant access; do not work around the prompt.
- Do not kill Electron or server processes you did not start.

## Not in scope yet

Code signing, notarization and auto-update. Ask before starting any of them; they need decisions from the user
(certificates, update channel). Installers (`scripts/package.mjs`), icons and the bundle id `com.stepfun.stepcode`
exist; changing the bundle id makes the installed app a different application.
