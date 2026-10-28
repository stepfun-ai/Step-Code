# apps/web — StepCode Web host and React client

These rules add to the repository rules in `../../AGENTS.md` (commit attribution, Git safety, dependency security,
exec-plans, conversational style). Where the two disagree, this file wins for code under `apps/web/`.

`@step-harness/web` is two programs in one package:

- **Host** (`src/`): a loopback Node HTTP/SSE server that runs StepCode sessions through `@step-harness/coding-agent`
  and serves the built client.
- **Client** (`client/`): a React single-page app, the only UI of both StepCode Web and StepCode Desktop. The desktop
  app (`apps/desktop`) loads exactly this build; it has no UI of its own.

A change to the client is a change to the desktop app. Check both hosts when it matters (see Testing).

## Tech stack

| Area | Choice | Notes |
|---|---|---|
| Host runtime | Node.js (>= 22.19), `node:http`, no web framework | ESM, compiled by `tsgo -p tsconfig.json` to `dist/` |
| Agent | `@step-harness/coding-agent` | Sessions, tools, permissions, models. The host never reimplements them. |
| Client | React 19.3, react-dom 19.3 | Function components and hooks only |
| Build / dev server | Vite 8.2 + `@vitejs/plugin-react` | `vite.config.ts`: root `client/`, output `dist/public/` |
| State | Own store on `useSyncExternalStore` (`client/src/state/store.ts`) | No Redux, Zustand, React Query, router |
| Styling | Plain CSS per feature + CSS Modules for `ui/` primitives | **No Tailwind**, no CSS-in-JS, no UI kit |
| Markdown, highlighting, i18n | In-house (`lib/markdown.ts`, `features/files/highlight.ts`, `i18n/`) | No libraries |
| Types | TypeScript strict, `erasableSyntaxOnly`, `verbatimModuleSyntax` | Type-checked by `tsgo` (both tsconfigs) |
| Lint / format | Biome (root `biome.json`) | Tabs, indent width 3, line width 120, double quotes, semicolons |
| Tests | `node:test` + `tsx` (unit), headless Chrome over CDP (e2e) | No Jest, Vitest or Playwright Test runner; the browser adapter itself uses playwright-core |

The runtime dependencies are `react`, `react-dom`, `playwright-core`, `node-pty`, `@xterm/xterm`, `@xterm/addon-fit` and the workspace `@step-harness/coding-agent`. Adding any dependency
needs the user's approval first; pin it to an exact version and install with `pnpm install --ignore-scripts`.

## Directory layout

```
apps/web/
  AGENTS.md / CLAUDE.md
  package.json           exports: ./server (dist/server.js), ./desktop-bridge (bounded client contract + validator)
  openapi.yaml           HTTP API description; copied to dist/ by `build`
  tsconfig.json          host (src/**), emits dist/
  tsconfig.client.json   client (client/src), noEmit, DOM libs, react-jsx
  vite.config.ts         client build + dev proxy (/api, /auth, /healthz -> host)
  src/                   HOST
    server.ts            HTTP routes, auth/Origin checks, SSE, static files from dist/public
    runtime.ts           session runtime: create/open/prompt/abort, snapshots, event fan-out
    approval.ts          ApprovalBroker: pending tool approvals per session
    workspaces.ts        workspace registry (newest first)
    files.ts             workspace file tree / read / search / @path completion
    auth.ts, login.ts    cookie secret, launch-token exchange, credential status, desktop sign-in
    browser.ts           isolated Chromium ownership, leased controller, bounded frames and input
    browser-routes.ts, browser-policy.ts  authenticated browser HTTP/SSE adapter and input/URL policy
    browser-proxy.ts     private authenticated network boundary for redirect-safe port blocking
    terminal.ts          bounded host-owned terminal sessions and process cleanup
    terminal-process.ts  isolated node-pty helper; native failures must not crash the Host
    terminal-cleanup.ts  owned process discovery: POSIX session/group/tty, Windows identity-validated descendants
    terminal-native.ts   node-pty native build probe and macOS spawn-helper exec-bit repair
    terminal-routes.ts, terminal-policy.ts  authenticated HTTP/SSE and shell/environment/input policy
    site-preview.ts      token-scoped loopback static origin for rendered workspace pages
    open-folder.ts       show a known workspace folder in Finder / File Explorer (no shell)
    directory-picker.ts  server-side folder chooser
    settings.ts          settings back end: MCP servers, plugins/marketplaces, skills
    model-providers.ts   model settings back end: models.json declarations, auth.json keys, model discovery
    stepgo-import.ts     one-time import of a local stepgo launcher's providers and key (first start only)
    attachments.ts, feedback.ts, banner.ts, bootstrap.ts, writer-lease.ts
  client/
    index.html           <div id="root">, loads /src/main.tsx
    MIGRATION_MAP.md     legacy app.js -> React map (historical; this file is authoritative)
    src/
      main.tsx           CSS order, host attributes, theme/locale before first paint, render, bootstrap()
      App.tsx            page skeleton: mounts each feature's slot components
      platform/          desktop-bridge.ts (window.stepcodeDesktop contract), host.ts (host detection)
      state/             store.ts (AppState, setState/setUi, useAppStore), session.ts (lifecycle, SSE), types.ts
      lib/               pure helpers: api, format, markdown, storage, ime, clipboard
      i18n/              messages.ts (zh + en dictionaries), index.ts (t, useT)
      styles/global.css  design tokens (light/dark), reset, app grid, shared rules, [data-host] rules
      ui/                reusable primitives, one folder each (Component.tsx + Component.module.css), barrel index.ts
      features/<name>/   index.tsx (public slots), actions.ts (state changes), *.tsx, <name>.css
        composer conversation files login market settings shell sidebar workspace
  test/
    *.test.ts            host unit tests (node:test)
    e2e/web.e2e.mjs      builds the client, starts the host, drives headless Chrome
  dist/                  build output (server.js, public/, openapi.yaml); never edit
```

## Boundaries

- **Host and client never import each other.** The client talks to the host only over HTTP/SSE (`lib/api.ts`,
  `state/session.ts`). The client mirrors the wire types it needs in `state/types.ts`; keep them in sync with
  `src/runtime.ts` / `src/approval.ts` by hand when a payload changes.
- **The client imports no `packages/*` code.** Agent, session, prompt and tool semantics live in
  `@step-harness/coding-agent` and below; the client renders what the host sends.
- **The host stays thin.** Do not put agent-loop, prompt assembly, tool or permission logic in `src/`. Call the
  coding-agent APIs; translate their events into SSE. Pending approvals go through `ApprovalBroker`.
- **Desktop-only behaviour goes through the bridge.** Use `getDesktopBridge()` / `isDesktopHost()` from
  `platform/host.ts`, and always keep a browser fallback (e.g. folder picking: bridge, then the host's picker, then the
  in-page browser). Desktop-only CSS goes under `[data-host="desktop"]` in `styles/global.css`.
- The shared composer owns workspace `@path` completion in `features/composer`.
  Host `/api/v1/workspace/completions` ranks bounded metadata-only candidates;
  keep known-workspace auth, containment and request cancellation. Enter/row
  picks insert reference text; Tab/chevron drills into a directory. The DOM
  projection treats upload chips as non-text, preserving them and surrounding
  prose on completion. IME, moved selections and session/workspace replacement
  invalidate picks; stale/pending candidates must not send or overwrite input.
  Escape belongs to the shell chain and closes the list without aborting a turn.
- `platform/desktop-bridge.ts` is a cross-package contract with `apps/desktop/src/preload.ts`. Change it only together
  with the desktop side (see `apps/desktop/AGENTS.md`).
- Appearance is restored before mounting the React client. Desktop `getTheme` / `setTheme` use the profile's
  `desktop-state.json`, not the changing server origin; a valid localStorage choice migrates only when no desktop
  choice exists. Plain browsers retain localStorage. Keep all four choices (`system`, `light`, `dark`, `violet`),
  persist the system selection rather than its resolved color, and report bridge failures without blocking the UI.

## Client conventions

1. **Where code goes.**
   - A reusable, product-agnostic control goes to `ui/<Name>/` with a CSS Module, exported from `ui/index.ts`. `ui/`
     must not import from `features/`, `state/` or `i18n/`.
   - Product UI goes to `features/<name>/`. Other features use only what its `index.tsx` and `actions.ts` export;
     do not reach into another feature's components or CSS.
   - Shared state shape changes go to `state/store.ts` (`AppState` / `UiState` + initial value). Session and stream
     logic stays in `state/session.ts`.
   - A new top-level area is a new feature folder, mounted in `App.tsx` and documented in the `App.tsx` comment.
2. **State.** Read with `useAppStore(selector[, shallowEqual])`; write with `setState` / `setUi`. Never mutate store
   values: replace arrays, objects, Maps and Sets (`mapWith`, `mapWithout`, `setWith`, `setWithout`, `setToggled`).
   Keep selectors narrow so a stream update does not re-render the whole tree; memoise heavy rows (`memo`, `useMemo`).
3. **DOM contract.** Ids, class names, `data-*`, `aria-*` and roles that tests, `scripts/check-browser-smoke.mjs` or
   cross-feature CSS select on are an API. Do not rename or remove them; grep `test/e2e/web.e2e.mjs` and the smoke
   script before you do.
4. **Overlays stay mounted.** Popovers, modals, banners and panels toggle the native `hidden` attribute
   (`hidden={!open}`) or an `open` class; do not unmount them. Tests read `element.hidden`. Exception: `Popover`
   renders its panel only while open (one per trigger, e.g. per sidebar row); tests check the panel's presence.
5. **Text.** Every user-visible string comes from `useT()` / `t()`. Add each new key to both the `zh` and the `en`
   dictionary in `i18n/messages.ts`. Do not reuse a key whose wording you need to change in only one place; add a
   new key.
6. **CSS.**
   - Use the tokens in `styles/global.css` (`--ink`, `--surface`, `--line`, `--focus-border`, `--control-h-md`,
     radii...) instead of literal colors and sizes, so light and dark themes both work.
   - Feature CSS keeps global class names (tests depend on them); CSS Modules are for `ui/` only.
   - Load order is global.css, then ui modules, then feature CSS.
   - Reuse the `ui/` components (see [Shared UI components](#shared-ui-components)) instead of restyling native
     elements in feature CSS: `Tooltip` for hover hints (not `title`), `SearchInput` for search fields, `IconButton`
     for icon buttons.
7. **Accessibility.** Every `<button>` has `type`; icon-only buttons have `aria-label`. Clickable non-buttons need a
   role, `tabIndex` and a keyboard handler. Biome's a11y rules must pass.
   - Icon-only buttons use `IconButton` (`icon` / `iconSize`, or `Icon` children for several icons), never a hand-written
     `<button>` wrapping an `<Icon>`. Keep the feature class (`className`) tests and CSS select on; the feature CSS
     overrides size and colour, and a feature `:hover` rule needs an ancestor class to outrank IconButton's own.
   - Icon buttons never set the `title` attribute. Show
     their hint with `Tooltip` (`<Tooltip content={label}>{button}</Tooltip>`); when the button opens a `Popover`,
     put the `Tooltip` inside the `Popover` and pass `content={open ? null : label}`.
   - Text cut by an ellipsis shows the full text in a `Tooltip`, not `title`; measure on hover
     (`scrollWidth > clientWidth`) so untruncated text gets no hint. A list row whose label is cut wraps the whole
     row (`placement="right"`), so hovering anywhere on it shows the card (see `features/sidebar/SessionRow.tsx`).
8. **Inputs driven by tests.** The e2e suite sets `input.value` and dispatches a non-bubbling `input` event. React's
   `onChange` misses that; for such inputs use a native listener or `onInputCapture` on an uncontrolled input (see
   `ui/SearchInput`).
9. **Escape and global keys** are handled in one place, `features/shell/ShellEffects.tsx` (`handleEscape` closes the
   topmost overlay first). Add new overlays to that chain instead of adding document listeners.
10. **Icons** are `<symbol id="i-<name>">` entries in `ui/IconSprite/IconSprite.tsx`; add the name to `ICON_NAMES`
    and use `<Icon name>`.

## Shared UI components

`client/src/ui/` holds the product-agnostic primitives; import them from the barrel (`import { Modal } from
"../../ui"`), never from a component file. Each one forwards `id`, `className`, `aria-*` and `data-*`, so feature code
keeps the ids and classes tests and feature CSS select on. Most styled ones take `bare` to drop the module styles and
keep only the classes passed in. Read the component's doc comment before using it; it states the DOM it renders.

| Component | Use it for | Notes |
|---|---|---|
| `Button` | Text buttons; `variant` `plain` (default, native look reset), `primary` / `secondary` (dialog footer actions) | `type="button"` by default |
| `IconButton` | Square icon-only buttons (`icon`, `iconSize`) | Always has `.icon-button`; pass `aria-label`; wrap in `Tooltip` for a hint. Use it instead of `<button><Icon /></button>` |
| `Icon` | Sprite icons: `<Icon name size>`; `LEGACY_ICONS` holds preset name+size pairs | Sizes `2xs xs sm md lg menu`. New icons: add a `<symbol id="i-<name>">` to `IconSprite` and the name to `ICON_NAMES` |
| `IconSprite` | The `<symbol>` sheet every `Icon` references | Rendered once in `App.tsx`; do not render again |
| `Tooltip` | Hover / keyboard-focus hints: `<Tooltip content={text or element}>{trigger}</Tooltip>` | Placement top, centered, shifts only at viewport edges; `placement="right"` sits beside the trigger, top edges aligned (flips up / left when there is no room). One child that forwards `style`, `ref` and `aria-describedby`; the hint is its next sibling (no wrapper). Empty `content` = no hint. Rendered in the top layer (manual popover), so a neighbouring panel never covers it. Can itself be a `Popover` trigger |
| `Modal` | Dialogs: backdrop + `section[role=dialog][aria-modal]`, toggled by `open` | `id` / `overlayClassName` on the overlay, `className` / `dialogProps` on the dialog, `labelledBy`. Escape belongs to the shell's chain unless `closeOnEscape` |
| `Popover` | A panel or menu opened from a trigger (dropdowns, pickers, overflow menus): `<Popover content={panel} open onClose>{trigger}</Popover>` | The child is the trigger (forwards `ref` and `style`; may be a `Tooltip`); other div props go to the panel. The panel renders only while open, portaled to `body`, `--popover-gap` (4px) from the trigger: `placement` `bottom-start` (default) / `bottom-end` / `top-start` / `top-end`, or `bottom` / `top` centred on the trigger (shifted at a viewport edge), flipped when there is no room. `dismissOn`, `closeOnEscape` (refocuses the trigger) |
| `Menu`, `MenuItem`, `MenuDivider` | Rows inside a `Popover` | `MenuItem`: `icon`, `trailing`, `danger`; pass `role="menu"` / `"menuitem"` where it is a real menu |
| `SegmentedControl` (alias `Tabs`) | Mutually exclusive options or tabs: `items`, `value`, `onChange` | `selection` marks the chosen item with `aria-pressed` or an `active` class |
| `Switch` | On/off settings: `<button role="switch" aria-checked>`; `checked`, `onChange(boolean)` | Pass `aria-label` |
| `SearchInput` | Search fields (icon + `input[type=search]`); input props go to the `<input>` | For test-driven inputs use `onInputCapture` on an uncontrolled input (convention 8) |
| `Toast` | `role="alert"` message, `tone` `danger` / `neutral`; fixed at the top centre of the window | Empty `message` hides it; timing is the caller's. The app has one, `#errorToast` (`showError`); do not restyle it in feature CSS |
| `EmptyState` | The muted "nothing here" line (`.empty-list`) | |
| `Spinner` | Decorative running dot (`aria-hidden`) | Put the status text next to it |
| `ShimmerText` | Animated "working on it" label | Put it in a status region to announce it |
| `Kbd` | Keyboard shortcut hints | |
| `DiffStat` | `+12 -3` line counts (`additions`, `deletions`) | |
| `MarkdownView` | Rendering `lib/markdown` output (`html`), with code-block copy buttons (`onCopyCode`; unless it resolves `false`, the button shows `copiedLabel` briefly) | Only HTML from `renderMarkdown`; never other HTML |
| `ResizeHandle` | Draggable / keyboard splitter between panels | Holds no size: `getSize`, `onResize` (live), `onCommit` (persist), `onReset`; `orientation="horizontal"` for stacked panels |
| `useCopiedFlag` | `[copied, flash]` for a copy button that confirms in place | Pair with `copyText(value, null)` to skip the toast |
| `useDismiss` | Outside-press and Escape dismissal for a mounted overlay | Include the trigger in `insideRefs` |
| `useMergedRef` | One ref callback feeding two refs (own + forwarded) | |

When to add or change one:

- Check this table before writing a control in a feature. A one-off look is a feature class on the shared component
  (`className`), not a copy of it.
- A new primitive goes to `ui/<Name>/<Name>.tsx` + `<Name>.module.css`, is exported from `ui/index.ts`, follows the
  rules in that file's header (no `state/`, `lib/api`, `features/` or `i18n/` imports; strings arrive as props;
  overlays stay mounted and toggle `hidden`), and gets a row in this table.

## Host conventions

- Every route is under `/api/v1/` (plus `/auth/*`, `/healthz`). It must pass the auth cookie and Origin checks in
  `server.ts`; the server listens on `127.0.0.1` only. Never log the launch token or the cookie secret.
- Adding or changing a route or payload: update `openapi.yaml` in the same change, update `client/src/state/types.ts`,
  and add a unit test.
- Session snapshots and every SSE event carry `revision`, monotonic per bound session. `renderSnapshot` ignores a
  snapshot older than the newest revision the page has applied, so a read answered late cannot repaint a stopped turn
  as running (or restore its stop control); each stream connection starts a new order, and its opening snapshot is
  authoritative. Never apply an HTTP snapshot without that gate.
- Anything a reloaded page must show again belongs in the session snapshot (e.g. `pendingApprovals`), not only in
  an SSE event.
- The kernel persists an assistant message only on `message_end`, so a turn that is still streaming lives nowhere but
  process memory. Shutdown must refuse new work and stop running turns before closing their sessions
  (`WebSessionStore.interruptAndClose`, bounded below Desktop's 5s SIGKILL) so the partial reply and its thinking reach
  the transcript as `aborted`; a bare `close()` disposes mid-stream and drops what the page already showed. A prompt the
  kernel has accepted but not started is not a run yet — `abort()` cannot cancel it — so it counts as busy and the stop
  waits for the run first (`pendingPrompts` / `stopTurnWithin`). Applying the same rule to a new host path (another
  embedding, a CLI quit) is a session-lifecycle change: stop, wait for idle, then dispose.
- `interruptedTurn` is derived from the recorded entries (`hasInterruptedTurn`), never from a process flag, so a
  reopened session reports the same thing a live page did. Do not infer it from UI text or from a missing live row.
- Thinking elapsed time is host-observed presentation metadata (`src/thinking-timing.ts`), persisted through
  the session manager's `stepcode-web.thinking-timing` custom entries outside model context. Snapshots and agent
  envelopes project validated `thinkingTimings` by original content index. Never infer durations for unobserved
  history or start clocks from browser receipt times.
- The main transcript uses fixed compact process groups, not a complexity
  setting. Group consecutive thinking and ordinary tools only; singleton groups
  show the member's own disclosure without a group heading or indentation.
  Retain keyed member components and a manually opened singleton when siblings
  arrive. Keep failed tools, approvals, retries and dedicated lifecycle calls
  separate. Preserve original
  timeline indices for turn footers, file deliveries and search reveal. Group
  completion counts tool results, never canonical Tasks or child-agent success.
- A subagent record is context the main agent produced, so its inspector has no prompt surface:
  the child's input is a collapsed "task message received" receipt, never a bubble or box. Do not add a
  composer, inline editor or send control to the child view. Inspection is read-only; the session is not.
  The parent composer stays mounted and usable underneath the record (the "read-only" badge, not a hidden
  field, marks the panel), because inspecting a subagent must not take away typing, stop or queued messages.
- Subagent rows project structured per-task results and use the existing read-only child transcript API.
  Planned arguments mean queued, not running; missing legacy statuses stay unknown. A dispatch the kernel
  rejected never started a child, so its planned rows stay as failed attempts carrying the tool result's own
  error: a refused run must not read as "status not recorded" or vanish from the rail and Summary. Only steps
  that never settled become failed; a completed chain step keeps its own result. Background custom messages
  expose only validated agentId/event/status fields through `src/subagent-notification.ts`. Do not parse
  notification prose, infer per-task success from the parent tool, or add child execution controls in the inspector.
- `features/inspector` owns the shared right rail, Summary and Context views.
  Summary uses an independent content-height floating board with a close-only
  header and fixed compact width. It floats over the conversation and reserves no
  grid space; where there is room the reading column slides aside without
  narrowing. Do not wrap it in the full-height inspector chrome used by the other panels.
  Summary's surface colors are scoped to that surface. Keep grid disclosures,
  fixed-slot completion motion and reduced-motion support; never replay a
  live completion animation for initially loaded completed history.
  Its MCP switch-shaped indicators are decorative, not configuration controls.
  Latest-turn task/subagent activity can reveal Summary once per selection/turn;
  respect manual dismissal and never displace an already active inspector.
  Its task progress uses canonical completed/total tasks, not tool-call counts.
  Agent rows below the task list reuse validated timeline statuses and existing read-only
  inspector actions; count records, never infer distinct live agents or success.
  The header repeats canonical task completion and agent-record counts; its
  activity dot uses explicit running states and preserves unknown history.
  File and Subagent entry points select the shared panel through `state/right-panel.ts`.
  The read-only `/sessions/{id}/inspector` route projects canonical `step-tasks`
  snapshots and SDK statistics; task-tool completion is not task completion.
  MCP status is process-scoped, unlike the session's skill count. Do not label
  recorded messages as assembled model context or turn patches as Git net changes.
  Conversation navigation is excluded. Terminal uses its separate Web adapter.
  `features/terminal` renders xterm in `#terminalDock`, a resizable bottom dock
  under the conversation toggled from the rail (`data-terminal-toggle`) or
  Ctrl+`; it is independent of the exclusive inspector. Keys typed in the shell
  stay there (Escape, Ctrl chords). Cmd/Ctrl+V is left to the browser's native
  paste event — the dock never reads the clipboard, so no clipboard-read
  permission is needed — and an oversized paste is refused before xterm sends
  it. Only opening an empty dock or explicit tab creation starts a shell;
  ending the last tab hides the dock. Hiding/switching tabs disconnects streams
  without killing processes; closing a tab awaits owned process-tree cleanup.
  Refresh replays bounded sequenced output, never creates replacement shells.
  Shell exit retains helper ownership until Host cleanup;
  Windows descendant discovery checks creation times, not just reusable PIDs.
  Startup cancellation waits for a shell identity or startup failure before
  terminating the helper. Retention gaps must be visible; do not claim full-screen
  restoration from a truncated ANSI tail. Keep input/IPC/SSE queues bounded,
  disable OSC 52 and automatic links, and do not inherit Host API keys or
  startup-injection environment variables. Never load sibling-project binaries
  as runtime dependencies or silently install/compile native modules; the only
  repair is restoring the exec bit of node-pty's published macOS spawn-helper.
  POSIX cleanup kills the shell's session, process group and controlling-tty
  members, never the Host or helper.
  `features/browser` uses the authenticated host-owned Chromium adapter in
  `src/browser.ts` / `browser-routes.ts`, not a Desktop bridge or iframe.
  Hiding releases its stream/controller but keeps tabs. Refresh rotates a
  leased controller token; late cleanup must not release its replacement.
  Coalesce pointer moves and wheel deltas per frame in event order: a fast
  trackpad must keep its scroll distance instead of filling the input queue,
  but never sum wheels at different places or in opposite directions. An
  attached frame stream keeps control past the lease deadline, and requests,
  competing pages and the expiry timer must use the same rule. A same-id
  replacement sends `replaced` to the displaced stream, which must not
  reconnect by itself. Only a lost stream reconnects with backoff; restore the
  retry budget after a healthy connection, not when connect resolves.
  Keep frame/input queues bounded and block host/client ports for subresources
  and WebSockets too. The browser-owned authenticated loopback proxy checks
  connection destinations across redirects and tunnels; keep loopback bypass
  disabled, strip proxy credentials upstream, and await proxy shutdown.
  All client snapshot sources share one monotonic revision gate per connection.
  Never attach a personal profile, expose arbitrary CDP,
  download a browser automatically or disable its sandbox.
- File delivery recognition is a frontend projection, not a persisted or
  filesystem-verified registry. Settled turns collect local Markdown links
  and supported structured successful write/edit outputs; inline basenames
  require an unambiguous observed output. References use the existing
  workspace file API and containment checks, never browser `file:` navigation.
  Delivery cards (under the closing reply of a turn) toggle only their own
  visible Files preview, retaining tabs and trigger focus; other files or
  panels switch to the requested file. A card whose turn changed the file
  opens that turn's diff (`collectTurnChanges`, not a second change model)
  and renders the page as that turn left it (`fileAtTurnEnd` replays the
  recorded writes and patches, else reverses later patches from disk; never
  write while rebuilding); otherwise it keeps a source action. Every card
  requests its own turn's version. Turn changes recognize the Step tool
  profile Web sessions use (`edit_file` and `write_file` record the same
  patches as `edit` / `write`; a `write_file` from older sessions has none and
  stays untracked; `changed: false` is no change) as well as `edit` / `write`.
  Browser-renderable pages open in the
  embedded browser on click, with a system-browser action; both
  browsers load them from `src/site-preview.ts`, a separate token-scoped
  loopback origin, never the Host's. Keep that origin separate and the Host's
  `Sec-Fetch-Site` same-site/cross-site refusal in `WebAuth.authorize`.
  Markdown opens rendered; preview links resolve relative to that document.
  Preview file tabs belong to the session that opened them
  (`features/files/session-scope.ts`): switching sessions stashes them in page
  memory and restores only the entered session's tabs, a new draft starts
  empty, and a draft's tabs carry into the session its first send creates.
  Never leave another session's file on screen beside a conversation.
- Workspace navigation metadata is separate from sessions: `web-workspaces.json` stores registered `workspaces`
  and explicit `removedWorkspaces`. Removed entries are returned with `hidden: true`; clients must not recreate
  their project groups from session cwd values. Re-adding restores the group; removal never deletes chats or files.
  A removed folder also stops being a *target*: its chats stay readable, but `startDraft` reroutes any request for a
  hidden cwd to `workspaceForNewConversation` (launch folder, then a workspace still on offer, then the host's
  `defaultCwd` — the home folder when the launch folder itself was removed), so "New conversation"
  from one of those chats — and a draft open in the folder being removed — never creates a session in it. The host
  reports `defaultCwd` / `defaultCwdFallback` alongside the workspace list, and the client names that fallback
  "默认项目" in the composer pill and the sidebar instead of the last path segment. The host
  refuses folder-scoped requests for a folder it no longer knows (`Folder is not a known workspace`), which is what a
  draft pinned to a removed folder used to hit.
- Session tag groups are presentation metadata, not session data: names, colours and assignments persist through
  the dedicated `state/tag-group-persistence.ts` owner (Desktop bridge/userData; Web localStorage). Desktop recovery
  precedes session-list pruning, failed reads never overwrite storage, and edits during loading queue after recovery.
  Edits validate against confirmed groups plus retained unconfirmed operations, persist before publishing store changes,
  and reject colour/name collisions. Unchanged refresh snapshots do not write. Load and save failures are independent
  store fields displayed by the existing ErrorToast; ordinary notices still expire after 4200ms, then the durable group
  error reappears. Only successful recovery clears the load error; only a changed full snapshot write clears the save
  error. Failed writes retain their operations in subsequent full snapshots. Group reads have a 10s wait bound and
  expired responses cannot publish. Session lists load immediately; recovery gates only pruning against the latest
  successful list and current/unlisted projection, with a stale-list/prune race gate.
  Desktop ShellEffects synchronously vetoes unload only for accepted unconfirmed operations, freezes new edits and
  drains recovery/ordered writes through the invoke-only beginTagGroupClose/completeTagGroupClose handshake. Main
  owns a one-time window/document-bound intention with a 10s deadline. Failure/expiry cancels close or restart and
  releases editing without dropping operations. Manual reload has no native token and never becomes a window close.
  Clean/loading/error pages do not start group recovery merely to close.
  A group exists exactly as long as a listed session carries its tag
  (`state/tag-groups.ts`). Deleting a session or untagging its last member removes the group from the grouped view
  and the row's picker together, and frees its colour; clearing the filter when its group disappears keeps the
  sidebar from going blank. Never keep an empty group record for the picker to re-offer.
- The sidebar's arrangement is a page preference, not session data (`state/session-order.ts`, keys
  `stepcode.pinnedSessions` / `stepcode.sessionOrder`). Pinned rows are a fixed block at the top of the list they
  already belong to (its project, Recent, or its tag section), ordered newest pin first: the row pinned last is the
  row nearest the top. Membership changes only through the row menu — `moveSession` refuses any drag that starts on or
  lands on a pinned row, and the row is not `draggable`, so a drag can neither enter the pinned block nor push a row
  above it. A pin is display only: it never rewrites the unpinned order, so a row that had a place keeps it while
  pinned. A drag reorders an unpinned row only within the list it came from (`features/sidebar/drag.ts`:
  `canReorder`, `dropPlaceAt`), so the grouped view's cross-section drop stays a retag. Alt+↑/↓ reorders the focused
  unpinned row and restores focus to it, so the arrangement is not pointer-only. The stored order covers only the
  lists the reader actually moved, so another project keeps following the host; unarranged sessions keep the host's
  newest-first position ahead of arranged rows, and a deleted session's pin and place are pruned on refresh and
  delete. Add-workspace and the archive toggle belong to the project view; the grouped view hides them and has no
  workspace sections of its own (the Alt+Cmd+O shortcut stays global).
- Ultracode (`ultraloop`) is hidden from the composer's ＋ mode picker in Web and Desktop while its interaction is
  unfinished (`features/composer/modes.ts`, `PICKABLE_MODES`). Keep the mode, its `ultracode:` keyword and `/ultraloop`
  alias, its lead chip and its message badge: hiding the picker row is not removing the feature.
- `GET /api/v1/bootstrap` reports the running build's identity: `version` always, and `buildTime` when the
  installer staged a release envelope (`STEPCODE_BUILD_TIME`, set by `apps/desktop/src/release-envelope.ts`).
  Settings › General shows it as "当前版本", so a window can be told apart from a stale install or a source
  checkout. Keep it a report of what the host runs; never synthesize a build time in the client.
- Environment variables: `STEPCODE_WEB_PORT` (default 3077), `STEPCODE_WEB_CWD` (default workspace),
  `STEPCODE_WEB_DOCUMENTS_DIR` (Documents folder; when set, a blank installation gets the first-use workspace
  `<Documents>/StepCode/default-workspace` as its launch folder — Desktop sets it only when it has no folder to launch
  in; see `WorkspaceRegistry.initializeDefault`),
  `STEPCODE_WEB_PUBLIC_DIR` (client directory), `STEPCODE_WEB_AUTH_SECRET`, `STEPCODE_WEB_OPEN` (below),
  `STEPCODE_WEB_CLIENT_PORT` (the launch URL points at this port instead of the host's; `web:watch` sets it to the
  Vite dev server, default 5173).
  `STEPCODE_WEB_BROWSER_PATH` optionally names an installed Chrome/Edge/Chromium executable.
  The browser adapter detects common locations otherwise and reports missing engines without installing one.
  `STEPCODE_STEPGO_IMPORT=0` disables the one-time import of a local stepgo launcher's providers and key into
  `models.json` / `auth.json` that runs before the host listens (`src/stepgo-import.ts`, `docs/stepcode-web.md`);
  hosts started by tests must set it, because they inherit the developer's HOME.
  Document new ones here and in `apps/desktop/README.md` if the desktop passes them through.
- Opening a browser on start is **opt-in**, because Desktop shows the client in its own window and the tests must stay
  headless. `STEPCODE_WEB_OPEN=1|true|on` makes the host open the launch URL right after printing the banner; unset or
  any other value leaves it closed. The developer commands set it; Desktop, the e2e suite and
  `scripts/check-web-runtime.mjs` force it to `"0"` so a variable exported in the caller's shell cannot open a window.
  `STEPCODE_WEB_OPEN_MARKER=<path>` names a file recording "this run already opened a tab", so the restarts `tsx watch`
  performs stay quiet; `web:watch` creates it in a per-run temporary directory and removes that directory on exit. One
  open per run is the right unit: the cookie a page holds survives a host restart (the signing secret is persisted), so
  the tab that is already open reconnects by itself.
- `/api/v1/settings/*` is the settings screen's own surface (MCP servers, plugins, marketplaces, skills). It reads
  and writes the user's global StepCode configuration through `@step-harness/coding-agent` — the same files
  `step mcp`, `/plugin` and the TUI resource selector use — and never project scope. Only user-scope state moves;
  a change reaches a session when that session starts (MCP tools register at `session_start`, skills load with its
  resources), so the client says so instead of reloading sessions. The host holds the global MCP servers from
  startup (`createStepMcpHostWarmup`) and re-syncs them after MCP/plugin settings changes, sign-in and sign-out;
  sessions share those pooled connections. `send` waits for the session's extension startup, so a first message
  carries the MCP tools.
- Account settings are separate from General and reuse `features/login/actions.ts`
  and the existing Host sign-in routes. Keep credential presence (`configured`)
  separate from validity, and both separate from the account session
  (`step-login.json`, reported by `session`); an unavailable check is not a
  rejected credential. Optional UID is only a bounded stored OAuth identity
  matching the kernel's valid account, never a profile name, key or token.
  Environment credentials remain read-only. Cancel page-owned browser
  authorization on exit and ignore late callbacks. A Step sign-out waits for
  every in-flight sign-in to settle (`WebLoginController.cancelAll`) before it
  removes files.
  `POST /api/v1/logout` is the Step sign-out (same as `step logout`: stop running
  sessions, remove the credential and account session); `POST /auth/logout` only
  expires the page cookie. Keep the launch cookie through a Step sign-out so
  Desktop reloads into `#loginGate` without a new terminal link. A Step account
  is optional: the gate opens only when no model can run (no Step credential
  and `customModels: false`); the gate itself has no "Use your own models"
  link. Signed out, the sidebar account button opens Settings > Account
  directly (no menu), not the gate. Never remove custom providers on a
  Step sign-out. No
  balance/allowance placeholders.
- Do not depend on `process.cwd()` being the workspace; the desktop starts the server elsewhere (macOS privacy
  blocks a cwd inside `~/Documents`).

## Commands

Run from the repo root.

| Command | Use |
|---|---|
| `pnpm web` | Build the client, run the host from source with the current folder as workspace (port 3077), and open the launch URL in the default browser (`STEPCODE_WEB_OPEN=0` to skip) |
| `pnpm web:watch` | Host from source plus the Vite dev server (port `STEPCODE_WEB_CLIENT_PORT`, default 5173); the launch URL opens Vite, so client edits apply by HMR. The host is not watched, so an agent editing this repo does not restart it and drop its own turn; restart the command for host or package changes, or set `STEPCODE_WEB_WATCH_HOST=1` to restart the host on every change (drops running turns). The browser opens once per run |
| `pnpm --filter @step-harness/web dev:client` | Vite dev server with HMR, proxies to a host on `STEPCODE_WEB_PORT` (start the host first) |
| `pnpm --filter @step-harness/web typecheck` | Host and client type check |
| `pnpm --filter @step-harness/web test` | Host unit tests (`tsx --tsconfig`, so it also runs under the Windows `cmd` shell pnpm uses) |
| `pnpm exec tsx --tsconfig ../../tsconfig.json --test test/<name>.test.ts` | One unit test file (from `apps/web/`, any shell); without the tsconfig, workspace packages resolve to `dist/` and fail. `TSX_TSCONFIG_PATH=../../tsconfig.json node --import tsx --test ...` is the POSIX-shell equivalent |
| `STEPCODE_WEB_BROWSER_TEST=1 TSX_TSCONFIG_PATH=../../tsconfig.json node --import tsx --test test/browser.test.ts` | Opt-in installed-Chromium adapter acceptance against a local fixture only; no account, provider or engine download |
| `STEPCODE_WEB_TERMINAL_TEST=1 TSX_TSCONFIG_PATH=../../tsconfig.json node --import tsx --test test/terminal.test.ts` | Opt-in real local-shell acceptance in temporary folders; no account/provider calls |
| `pnpm --filter @step-harness/web test:e2e` | Client build + e2e in headless Chrome (`CHROME_PATH` to override; skipped without Chrome) |
| `pnpm run check` | Required before handing back any code change: Biome, guards, type checks, web unit tests, web runtime, browser smoke, desktop type check |

`pnpm run check` runs `biome check --write`, so it may reformat files; review the diff afterwards. The packages the
host imports must be built (`pnpm build` at the root) before the host runs.

## Testing

- Host change: add or update a unit test in `test/` and run it.
- Client change: `typecheck`, then `test:e2e` when the change touches a tested surface (sidebar, workspace, files,
  preview, settings, auth). Then check the real UI in a visible browser, and say what you checked.
- Change that affects a session (streaming, approvals, tools, file edits): run one real turn that edits a file in a
  scratch workspace and confirm the change on disk, in Web and, when the client or host changed, in Desktop
  (`pnpm desktop`).
- Never point manual tests at a real project folder without the user's say-so; use a scratch folder.
- Do not kill a host you did not start (e.g. a user's server on port 3077); pick another port.

## Do not

- Add Tailwind, a CSS-in-JS library, a component kit, a state library, a router or a Markdown library.
- Edit `dist/`, or reintroduce the deleted vanilla client (`public/app.js`).
- Put UI strings in only one language, or hard-code colors that the theme tokens cover.
- Use `any`, inline/dynamic imports, `enum`, `namespace` or parameter properties.
- Change `desktop-bridge.ts` without the matching desktop change.
