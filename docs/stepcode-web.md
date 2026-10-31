# StepCode Web Host

StepCode Web is a loopback-only Node Host plus a browser projection.

- `AgentSessionRuntime` owns the agent lifecycle.
- `AgentSession` owns the active session and event stream.
- `StepSessionManager` wraps Pi's current JSONL v3 `SessionManager`.
- `packages/agent-core`'s JSONL v4 `JsonlSessionRepo` is not used by Step CLI or  
  this Web Host.

The Web Host does not parse, repair, migrate, or write session JSONL directly.  
It projects session snapshots and agent events over HTTP/SSE and sends user  
actions back through the runtime. The browser never receives credentials.

Authentication is a one-time launch token exchanged for a signed, HttpOnly,  
SameSite cookie. API requests require the cookie and a local Origin. The  
server binds to `127.0.0.1` by default. `POST /auth/logout` expires the page  
cookie; re-entry then requires a fresh terminal launch link. That is page access  
only; the Step sign-out is `POST /api/v1/logout` (see Account below).

### Local migration

Desktop and Web use the shared offline migration service for sessions, skills,
ordinary global MCP, prompt templates and instruction rules. The first-use
invitation is Desktop-only; settings provides the later entry. Local migration
requires the Host launch cookie but no Step account, model credential or model
request. See [Desktop local migration](desktop-migration.md) for supported
sources, explicit project selection, immutable consent, cancellation and guarded
rules recovery, and [OpenAPI](../apps/web/openapi.yaml) for the wire contracts.

The credential lives in `~/.stepcode/auth.json` (`STEPCODE_AUTH_PATH` overrides  
it). It is written by `step login` in a terminal or by the sign-in dialog of  
Web and Desktop (see "Sign-in dialog" below), in the same shape, so CLI, Web and  
Desktop share one sign-in, and the Host reuses that credential exactly as the  
CLI does:

- It calls `syncStepLoginProfileEndpoint` before building the ModelRuntime, so the  
  credential is sent to the region its stored profile names. The CLI does the  
  same before every session; without it a `step_plan` credential goes to the  
  default endpoint and discovery fails.
- It reads the persisted `defaultProvider` / `defaultModel` from `config.toml`  
  (`readGlobalStepDefaults`) and passes them as the session defaults, which is  
  what the CLI injects into argv through `withStepDefaults`. The result is that  
  the Web UI lists the same models and starts on the same model as the CLI.
- It refreshes the model catalog *before* a session resolves its model. The Step  
  catalog is discovered over the network and ships no built-in baseline, so an  
  unrefreshed runtime offers zero models and the session would be left on  
  agent-core's `unknown` placeholder, where sending fails with "No API key found  
  for the selected model" — an error that names no provider.
- If resolution still yields no model, the session adopts the first model the  
  runtime lists rather than staying on the placeholder.

`GET /api/v1/login` (and the `login` field of `/api/v1/bootstrap`) reports where  
the credential comes from: `environment` or `auth.json`, with the provider,  
login profile, validity, and the `step login` command that changes it. The  
credential itself is never part of the response. A separate Account settings  
page shows the channel, region and credential verdict. Optional `userId` is a  
bounded stored OAuth UID matching the kernel's valid checked account; profile  
labels and environment keys never stand in for an identity. General settings  
retain language only. Account uses the Step platform mark and four\
channel choices, without balance or allowance placeholders.

The Account page reuses the existing browser/API-key sign-in routes, including  
authorization waiting, reopening, cancellation and error feedback. Closing the  
page cancels its browser authorization and prevents late client updates. API-key  
submissions cannot be undone after the Host saves them. An environment credential  
is read-only here because it takes precedence over a saved credential; change it  
in the launch environment and restart instead. Switching is disabled while the  
page knows of running/waiting sessions. Account retains the upgrade link.

Account (and the sidebar account menu) logs out of Step through  
`POST /api/v1/logout`, which performs the same sign-out as `step logout`: it  
cancels the page sign-ins still in flight and waits for them to settle (so a  
late credential write cannot outlive the sign-out), stops the Host's running  
sessions, then removes the stored `step` credential, the legacy copies and  
`step-login.json`, and invalidates the cached login and account reports. Only  
Step is removed: custom `models.json` providers and their keys stay. The launch  
cookie is kept on purpose, so Desktop reloads into `#loginGate` without a new  
link; plain Web opens the same gate for this explicit sign-out (a first visit  
still signs in from Account). When a custom model is still usable  
(`customModels: true` in the reply), neither host shows the gate: the page  
reloads into the app and says it continues on custom models. When  
`STEP_API_KEY` supplies requests, the host cannot remove it and answers  
`remainingSource: environment`; the stored credential and account session are  
still removed.

Presence, reachability, and the account session are reported separately.  
`configured` reflects the stored credential, `validity` reports what the provider  
said (`valid`, `invalid`, `unavailable`), and `session` reports  
`step-login.json` (`ready`, `expiring`, `expired`, `missing`). An API-key sign-in  
has no account session and is still configured; an expired session only loses  
the account name and avatar, never model requests.

### System prompt

The browser host and Desktop pass the app product prompt,  
`STEP_APP_SYSTEM_PROMPT_PRODUCT` from `@step-harness/coding-agent`  
(`packages/coding-agent/src/step/system-prompt.ts`), into  
`createAgentSessionFromServices`. Desktop runs this same host, so one definition  
covers both. The CLI declares its terminal product in `apps/cli/src/main.ts`;  
the two are intended to differ only in `role` and `introduction` (the identity,  
plus the app's rule for reporting what the app already shows), with the same  
`includeDocumentation: false` and the same operating contract. A test in  
`apps/cli/test/` asserts the CLI side against the shared builder.

The Step operating contract (`buildStepSystemPromptAppendix`) is attached inside  
that shared definition rather than at the host. It carries the tool selection  
rules, the operating mode, the sections the active tools enable (plan mode, task
tracking, coordination, long-running goals, scheduled work), and an
`<env>` block (working directory, platform, date, Git branch and uncommitted  
count). Sharing one definition means a host does not need to, and should not,  
assemble its own identity: doing so drops the contract that the same tool set  
advertises. Change the app prompt in the package; `apps/web/src/` passes the  
value and assembles no prompt.

Planning instructions are carried by collaboration-mode announcements;
delegation guidance and authorization are owned by the `subagent` tool description.

The app product also declares `interaction: "one-shot"`. The composer's plan,  
goal, and ultracode picks mark a single message: the client prefixes the text  
(`/plan `, `/goal `, `ultracode: `) and drops the pick once the message is  
accepted. The product name is **Ultracode**; `ultraloop` remains the kernel's  
alias for the same keyword and is what older sessions carry. The appendix  
renders that model, and the CLI keeps the default `session` rendering:

- **plan** — `/plan <task>` still enters plan mode and sends the task. Planning  
  means investigation and a written proposal, never carrying the work out, and  
  exiting is part of that: `exit_plan_mode` reports that the investigation is  
  finished. The tool leaves plan mode immediately (`ctx.mode` is `rpc` and  
  `ui.custom` is unsupported), returning the proposal in its structured  
  `details` (`planFilePath`, `planContents`, `planHash`). The client renders  
  those details as a review card — see [Plan review card](#plan-review-card) —  
  and the prompt tells the model to end the turn there and wait for the user's  
  decision. The pick marks one message, but plan mode itself stays on until the  
  model calls `exit_plan_mode` or the user toggles `/plan`. A picked skill rides  
  after the prefix (`/plan /skill:<name> <task>`); the plan command expands it.
- **goal** — the goal is still how it always was: started once, then continued  
  automatically at idle boundaries until complete (the one-shot pick changes  
  only how the user starts it). The prompt forbids starting a goal on the  
  model's own initiative and forbids replacing an unfinished goal with  
  `create_goal`; a second `/goal` is rejected by the kernel while one is active.
- **ultracode** (`ultraloop` is the kernel alias) — there is no session-standing switch. The host passes  
  `ultraloopSessionMode: false`, so `/ultracode` and `/ultraloop` are not  
  registered, a persisted `ultraloop-session-mode` entry from a CLI session is  
  ignored instead of reviving consent the UI cannot revoke, and no session  
  reminder is emitted. Only the per-turn keyword/phrase opt-in applies, and the  
  prompt drops the CLI's "standing for the session" guidance.

The capabilities extension registers compact, plan, tasks, subagent, workflow,  
and ultracode; goal and cron are separate extensions the host must also mount  
(`webExtensions` in `src/runtime.ts`, asserted by `test/extensions.test.ts`).  
Losing one is silent — its slash command and tools simply never register, and a  
typed `/goal` then reaches the model as ordinary text. Extensions are keyed by  
command and tool name, so a duplicate would silently override the option above.

A subagent child runs as its own `--mode rpc` process, so its Step permission
controller cannot show anything by itself: without a handler the kernel cancels
the child's confirmation as "nobody to answer", which reads as a denial — under
Ask, a subagent's `write_file` then failed and the main agent retried the write
itself. The host passes `subagent.requestApproval`, which routes the child's
prompt into this session's `ApprovalBroker`; the card names the child's tool and
shows the dialog body (path, content, command) the child summarized, and the
verdict travels back over the child's rpc stream. Only `confirm` is forwarded:
select/input/editor dialogs stay auto-cancelled. A host without a handler keeps
the old cancel, never a silent approve.

A host that renders no terminal must still answer `ExtensionUIContext.theme`:  
extensions style status text unconditionally. The Web host returns the kernel's  
identity-styled `plainTheme`, and `step-plan.ts` falls back to plain text when a  
host answers nothing.

### Session state on screen

Two pieces of kernel state are host-rendered rather than transcript text, so the  
snapshot carries them and the client draws controls from them:

- `goal` (`projectGoal`) is the running goal: objective, status, tokens, rounds.  
  The client shows it as `#goalStrip` above the composer, with pause / resume,  
  edit, and delete. Each control calls `PATCH /sessions/{id}/goal`, which runs  
  the same `/goal pause|resume|edit|clear` slash command the CLI's TUI issues —  
  one implementation, and the action lands in the transcript as the command it  
  is. A goal outlives the message that started it, which is why it needs  
  persistent controls instead of the one-shot mode chip.
- `planMode` (`projectPlanMode`) reports whether plan mode is active, from the  
  latest `step-plan` branch entry rather than an in-memory flag, so a restored


session answers correctly before the extension replays `session_start`.

Both are read from `getStepGoal` / `getStepPlanState` in the package, never  
inferred from UI text.

Snapshots and every SSE event carry `revision`, monotonic per bound session. The
client keeps the newest revision it has applied, stream events included, and
ignores a snapshot that was serialized before it: a slow read that was issued
while a turn ran would otherwise repaint the running status, the stop control
and a live thought after the reader stopped that turn. Each stream connection
starts a new order — its opening snapshot is authoritative — so a reconnected
page, a restarted Host and a host that predates revisions all still render.

### Restarting with a turn in flight

The kernel writes an assistant message on `message_end`, so a turn that is only
half-streamed exists on no disk until it ends. Host shutdown therefore refuses new
work and stops running turns before closing sessions
(`WebSessionStore.interruptAndClose`, called from the SIGINT / SIGTERM / SIGHUP
handler with a 3s bound): the abort records the reply as `aborted` with everything
that had streamed, thinking included, and the page shows the same transcript it
already had. The bound covers each turn stop, not the rest of shutdown — session
disposal, MCP release and terminal cleanup stay unbounded, so Desktop's SIGKILL
lands mid-teardown only if one of those blocks. A Step sign-out calls the same
method without a bound, because nothing kills it.

A prompt accepted but not yet running — the kernel is still doing auth, the
compaction check, or `before_agent_start` hooks such as MCP reconciliation — is
not a run yet, so `abort()` has nothing to cancel. The host counts those prompts
as busy and waits for the run to start before aborting it; otherwise a shutdown in
that window disposed the session with the prompt still in memory, and the model
request fired with nowhere to write. A turn that ignores the abort — or a host
that is killed outright — still loses its partial reply; there is no per-delta
write to fall back on.

`interruptedTurn` in the snapshot tells the client the newest turn was cut off,
derived from the entries (`hasInterruptedTurn`): a prompt with no reply, a branch
ending in tool work (a tool result, or an assistant that stopped with calls), or a
reply recorded as `aborted`. Errors and truncated replies are not interrupted; the
transcript already renders them. It is false while a turn runs or is starting, so
a prompt waiting for its first token is not called interrupted. The client draws
it as a quiet divider under the transcript. Because it is read from the file, a
reopened session says the same thing a live page did, instead of the run silently
disappearing. Imported message tails are source snapshots with unobserved outcomes,
not evidence of native interruption; later native continuation messages still use
the same interruption checks. Shutdown drains imports alongside stopping live turns,
then closes their shared session index after both cleanup operations settle.

The transcript file itself starts at the first prompt, not at the first reply
(`SessionManager`'s conversation guard), so a first turn cut off by a restart
still appears in the sidebar: previously the header had never been written and
the whole conversation vanished with the process.

### Plan review card

An `exit_plan_mode` result without a host dialog is a decision waiting for the  
user. The client turns the tool's persisted `details` into `#planReviewCard`: the  
proposal, "view full plan", and two buttons. The card is projected from the tool  
result in the session entries, not only from the live stream event, because every  
finished message refreshes the snapshot; a card that existed only on the stream  
disappeared before anyone could answer it, and a reopened session showed none.

- **Request changes** sends the notes through `/plan`, so the revision round is  
  planned again and produces a new proposal. Plan mode is already off when this  
  card is shown, and a plain message would have let the model implement instead  
  of revise.
- **Approve and run** sends a normal message that authorizes implementation.

Both are ordinary user messages: the decision is in the transcript, starts one  
turn, and needs no separate execution channel. Only the newest proposal without a  
user message after it is actionable; an older or already-decided card stays in the  
transcript as the record of that round but offers no buttons. `planHash` identifies  
the reviewed text.

Building a prompt runs `git symbolic-ref` and `git status` synchronously, now in  
the multi-session host rather than a single CLI process. The appendix bounds each  
call with a 1.5 s timeout, caches per working directory for five seconds, and  
omits the Git lines when a call fails. The cache is keyed by directory, so  
sessions in different workspaces do not share branch or dirty-count facts. No  
host calls `invalidateGitEnvironmentCache` from product code, so the cache only  
expires by that five-second window.

The prompt is rebuilt when a session starts and whenever its active tool set or  
extended resources change (`setActiveToolsByName`, extension skill / prompt /  
theme paths), not on every turn. An uncached rebuild therefore stalls the host's  
event loop while its bounded `git` calls run: up to three spawns of 1.5 s each  
(`symbolic-ref`, a `rev-parse` fallback only when the first fails, and `status`)  
on a repo where git hangs, freezing every session's event stream until they  
return. The host already blocks synchronously elsewhere (file discovery runs  
`git rev-parse`, resolved config values run shell commands), so this is not a new  
class of blocking; making environment collection asynchronous is tracked as a  
follow-up rather than part of the prompt change.


### Sign-in dialog

When the bootstrap report says `configured: false` (no `auth.json`, an empty  
one, or no `step` entry, and no `STEP_API_KEY`) and `customModels: false` (no  
custom `models.json` model with a usable key, checked offline by the kernel's  
availability rules), bootstrap stops before it opens any session and shows  
`#loginGate`, a dialog with no close control; Escape and global shortcuts are  
ignored while it is open. The gate is enabled for Desktop, and for plain Web  
after an explicit Step sign-out; a first plain-Web visit can still sign in from  
Account settings.

The gate offers only Step Plan and API-key sign-in, for the mainland or (via  
the link under the buttons) the international platform. Custom `models.json`  
models still count: once such a model is usable, later starts skip the gate.  
Signed out, the sidebar account button opens Settings > Account directly.

A session fixes its model catalog and provider endpoint when it is built, so  
one opened before the credential existed (another tab, or a page loaded before  
the dialog) would stay on the `unknown` model and fail with "No API key found  
for the selected model". After a credential is saved the Host therefore releases  
every idle open session (`WebSessionStore.reloadCredentials`): its SSE streams  
end, the page's EventSource reconnects, and the next request rebuilds it from  
its file with the new credential. A session without a file yet (no message  
sent) is recreated under the same id. Sessions in a running turn are left  
alone.

The dialog offers the four `step login` profiles, split by region  
(`GET /api/v1/login/methods`):

| Region          | Step Plan (browser) | API key                                                          |
| --------------- | ------------------- | ---------------------------------------------------------------- |
| China (default) | `step_plan`         | `platform_cn`, key page `platform.stepfun.com/interface-key`     |
| International   | `step_plan_oversea` | `platform_oversea`, key page `platform.stepfun.ai/interface-key` |

- **Step Plan**: `POST /api/v1/login/browser` runs the kernel's  
  `loginStepInBrowser`, the same cloud flow as `step login`, and answers with the  
  authorize URL, which the client opens in the system browser. The client polls  
  `GET /api/v1/login/browser` until `completed` or `failed`; Cancel sends  
  `DELETE`, which aborts the wait so a later approval writes nothing.
- **API key**: `POST /api/v1/login/api-key` runs `loginStepWithApiKey`, which  
  calls `GET <profile base>/v1/models` with the key and saves it only on 2xx. A  
  401/403 is reported as `invalid_key`; any other failure as `unavailable`, and  
  nothing is saved.

Without a stored choice, Desktop starts in the system language  
(`navigator.language`: `zh*` is Chinese, anything else English); the browser  
keeps its zh-CN default.

The approval path is an adapter: Step extensions call  
`ExtensionUIContext.confirm`, the Web Host's approval broker emits an SSE  
request, and the browser returns `approve`, `approve_for_session`, or `deny`.  
Missing or cancelled approvals fail closed. A plan-mode denial never reaches  
`confirm`: the kernel blocks a mutation outside the plan file before the  
permission policy runs, so no approval card is emitted for it.

Approval snapshots and SSE requests include the full captured tool `input` and  
the specific policy `reason`. The browser renders a neutral card with a localized  
approval title and the complete command or file-change preview, instead of the  
clipped Call/batch diagnostic message. Content initially shows three lines and  
can expand; the full arguments remain available before a verdict. The card offers  
only Deny and Allow for Session. Allow for Session is keyed by the canonical tool  
name, so later calls with different call IDs reuse the grant; other tools still  
ask. Specific danger or incomplete-analysis prompts still require a verdict per  
call, even with a session grant. These presentation changes do not alter the permission policy or the  
existing verdict endpoint.

Kernel selectors (`ExtensionUIContext.select`) go through the same kind of  
adapter. The Web Host's selection broker emits `selection_required` with the  
kernel's title and option labels, lists pending selections in snapshots as  
`pendingSelections`, and `POST /api/v1/sessions/{id}/selections/response`  
returns the chosen label verbatim (or nothing, for a dismissed dialog). The  
kernel parses the answer; the host never picks an option itself. This carries  
the Full Access risk acknowledgment: `PATCH .../policy` with `full-access` runs  
`/permissions full-access`, returns with the question pending and the tier  
unchanged, and the tier changes only after the user grants it. Cancel, Escape  
or the close button keeps the previous tier. A session whose settings already  
name Full Access without a remembered acknowledgment asks at start and runs as  
Approve for Me until answered. A draft (no session yet) asks the same question  
in the browser and hands the answer to the new session's kernel on the first  
send. The snapshot's `permissionPreset` is the tier the kernel enforces now,  
reported by the Step extension's `onPermissionChange` hook, because a "this  
session" grant is not persisted.

Clarification uses the existing `clarify_user` tool and the optional structured  
`ExtensionUIContext.clarify(questions, signal)` capability. The coding tool owns  
normalization and tool-result text; the Web Host transports the complete question  
set through `clarification_required` SSE and `pendingClarifications` in snapshots.  
The extension runner brackets this capability with the existing `custom`  
`ui_prompt_start` / `ui_prompt_end` lifecycle, so runtime consumers see the same  
user-wait interval as a terminal dialog.  
`POST /api/v1/sessions/{id}/clarifications/response` validates question order and  
option indexes, derives canonical option values, and resumes the pending tool  
call. It never sends the answer as a new user prompt. `clarification_resolved`  
removes the card on every connected page. Abort, session replacement and shutdown  
cancel pending calls. Browser reload restores pending questions while the Host is  
alive; restarting the Host does not replay interrupted tools.

The composer shows a paginated question card above its input. Clicking a choice  
or skipping saves that answer and advances. The last outstanding answer submits  
the complete set automatically. Custom replies use Enter (Shift+Enter inserts a  
newline; IME confirmation does not submit). Paging preserves selections and text  
drafts. Navigating ahead never implicitly answers an earlier question. The close  
button cancels the set; failed sends retain answers for retry. Voice input is not  
part of this flow. The shared React client renders the same card in desktop hosts.  
`clarify_user` is classified as a non-mutating tool, so Ask opens the questions  
directly; explicit per-tool confirm/deny overrides still apply. Escape cancels  
the waiting turn through the existing interrupt action.

Within one Web Host process, an in-memory per-session writer lease prevents two  
Web session objects from appending to the same JSONL file. This is not a  
cross-process lock. An older CLI that does not participate in a lease protocol  
must be closed before the Web Host opens the same session.

Desktop and Web are separate Host processes over the same `~/.stepcode`, on the
same machine. Each page reads the session and workspace lists when it loads, so
a conversation the other Host created, archived or deleted is only on disk. The
client re-reads both lists when its window regains focus or its tab becomes
visible (`features/shell/ShellEffects.tsx`, coalesced to one read per second),
which is how a session started in one appears in the other without a reload.
Nothing pushes between Hosts and no state is shared beyond the files, so a Web
Host on another machine cannot see a local Desktop's conversations.

Workspaces are folders the user registered through "Add workspace" (sidebar  
button, or Alt+Cmd+O / Ctrl+Alt+O). The Host opens the operating system's  
folder chooser when that dialog would appear on the machine in front of the  
user: a loopback bind, no SSH session, and a desktop (on Linux also a display  
and zenity or kdialog). A browser cannot do this itself — its directory pickers  
return file contents, never a path — so the page asks the Host  
(`POST /api/v1/workspaces/pick`) and the request stays pending while the dialog  
is open. `?` reports the mode so the page knows which to offer. The helpers are  
`osascript` on macOS, `powershell.exe` on Windows (PowerShell compiles a small  
C# wrapper around the Vista `IFileOpenDialog` in folder mode, so no extra  
dependency is needed and non-ASCII paths survive the pipe), and zenity with a  
kdialog fallback on Linux. One dialog at a time; a second request is refused  
with 409. When the mode is `browse`, or when the helper fails, the page falls  
back to the in-folder browser, so the button is never dead.  
`STEPCODE_WEB_DIRECTORY_PICKER=native|browse` overrides the detection. The registry is Web Host metadata in  
`web-workspaces.json` beside the session metadata. Its `workspaces` array lists  
registered folders; `removedWorkspaces` records explicitly removed folders,  
including folders inferred from existing sessions. `GET /api/v1/workspaces`  
returns removed folders with `hidden: true` so session refreshes and page reloads  
cannot recreate their project group. Hidden folders are excluded from recent  
folder choices; their conversations remain readable under Recent and searchable.  
Adding the folder again clears its removal marker and restores its project group.

A removed folder also stops being a target for new work. "New conversation"
inherits the folder of the conversation on screen, so starting one from a removed
folder's retained chat used to create a session there — in a workspace the picker
could no longer even list, where folder-scoped requests (file tree, git, `@`
completion) then answered "Folder is not a known workspace". `startDraft` reroutes
a hidden cwd to the launch folder, else to a workspace still on offer, then to the
host's default workspace: the launch folder, or the home folder when the launch
folder itself was removed. A draft open in the folder being removed is moved the
same way. Desktop launches the host in the folder it last picked and stores that
pick, so removing that folder used to leave it as the launch folder and every
"New conversation" with an empty workspace list started in the deleted folder;
the host now reports `defaultCwd` and `defaultCwdFallback` (on bootstrap and
`GET /api/v1/workspaces`) and the page names the fallback "默认项目" in the
composer's folder pill and the sidebar's project list. A usable launch folder
keeps its own name. `bootstrap.cwd` is the launch folder's resolved path, so it
matches the cwd a session header records and the paths the registry stores; a
launch spelling that differed (a symlink, a trailing slash) would otherwise keep
the removed real folder in the picker.

Every project header offers removal, with or without conversations. An in-app  
dialog names the project and explains that files and existing chats are retained.  
Cancel has initial focus; Cancel, close, backdrop and Escape dismiss without a  
request. Confirmation disables the controls while deletion of the navigation  
entry is pending. Failures leave the dialog available for retry; the endpoint is  
idempotent so a failed refresh after a successful removal can be retried. Removal  
does not close or interrupt the active conversation, modify its history, or  
change access to the cwd of an existing session.

The conversation list has two views. The project view groups conversations by  
workspace folder (plus Recent); the grouped view lists them by tag group.  
"Add workspace" and the archive toggle belong to the project view and are hidden  
in the grouped view, which has no workspace sections to add to or filter. The  
Alt+Cmd+O / Ctrl+Alt+O shortcut stays global: it opens the same chooser from  
either view.

Each reader's own arrangement of that list is local, like the theme. The row's  
more menu pins a conversation (or unpins it), and pinned rows are a fixed block  
at the top of the list they belong to — they do not move into a separate  
section, and the row pinned last is the one nearest the top. Dragging only  
rearranges the unpinned rows inside the same list: a row dropped on another  
project or tag section, and a row dropped on a pinned row, does nothing, so a  
drag can never enter the pinned block or push a row above it. Alt+↑ / Alt+↓  
moves the focused row past its visible neighbour and keeps focus on it for the  
next press. Pinning never rewrites the unpinned order, so a row that had a place  
keeps it while pinned and returns to it when unpinned from the menu; a row  
pinned before it was ever arranged has no place to return to and leads the  
unpinned rows once unpinned, like a conversation the Host lists for the first  
time.

Both preferences live in browser local storage (`state/session-order.ts`,  
`stepcode.pinnedSessions` / `stepcode.sessionOrder`), not in Host metadata, and a  
deleted session's pin and place are pruned with it. The stored order covers the  
lists the reader actually moved: another project keeps following the Host, and a  
conversation the Host lists for the first time keeps its newest-first position,  
ahead of the arranged rows. A place belongs to the session, so retagging or  
unarchiving one keeps the rank it already had and it joins its new list at that  
point. A different browser profile or machine keeps the Host's order; two pages  
of one profile share the stored arrangement without watching each other. In the  
grouped view a row dropped on another tag section still retags it, as before.

Ultracode (the `ultraloop` mode) is hidden from the composer's ＋ mode picker in  
Web and Desktop while its interaction is unfinished. Nothing behind it was  
removed: typing `ultracode:` or `/ultraloop` still stages the same lead chip and  
kernel prefix, and recorded messages keep their badge.

File browsing is keyed by folder, not by session, so an empty workspace can be  
browsed. `GET /api/v1/workspace/{files,file,raw,search,completions}` take a `cwd` and answer  
403 unless it is the launch folder, a registered workspace, or the cwd of an  
existing session. Inside a workspace every path is resolved with `realpath` and  
refused (400) when it lands outside the root, which also covers symlinks that  
point out of the workspace.

- `files` lists one directory level (directories first, at most 1000 entries,  
  `truncated` when cut). The tree is lazy: the browser asks for a level only  
  when its folder is expanded, and remembers which folders were open.
- `search` is a bounded breadth-first name search. It runs on the Host because  
  the browser only holds the levels already opened. It does not descend into  
  `.git`, `node_modules`, or symlinked directories.
- `completions` provides the composer's ranked workspace-relative `@path`  
  candidates. An empty basename lists one directory level; a name fragment  
  searches below its directory, preferring exact names, prefixes and substrings  
  before in-order fuzzy matches. It returns at most 20 candidates and bounds  
  each walk to 4000 directories / 20 000 entries. Dependency and build folders  
  are not walked recursively unless explicitly scoped; outside and dangling  
  symlinks are omitted. Cancellation stops the walk. `truncated` reports a result  
  limit, exhausted walk budget or unreadable descendant, so partial search is  
  not labelled complete. Candidate queries never read file contents.
- `file` classifies a file as `text` (up to 1 MB, returned as UTF-8), `image`,  
  `binary` (NUL byte in the first 8 KB), or `too-large`; only `text` carries  
  content. Images over 10 MiB (`MAX_IMAGE_BYTES`, the size the page prints as
  "10.0 MB") are `too-large` instead of a broken image. `raw` streams images,
  and nothing else, for the preview.

An empty workspace also shows a branch switcher beside the folder pill, above  
the composer card. Both pickers choose where the next conversation starts, so  
both hide once a session is open: the session stays on the folder and branch it  
was created in. `GET /api/v1/workspace/git` takes the same `cwd` and answers  
with `state` (`repository`, `root`, `branch`, `detached`, `dirtyFiles`) plus  
the local `branches`, most recently committed first. `repository` is false for  
a folder outside a git work tree or when git is missing, and the pill hides.  
`POST /api/v1/workspace/git/switch` switches to an existing branch, or with  
`create: true` creates it at HEAD and switches. It runs `git switch` without  
`--force`, so a switch that would overwrite uncommitted work is refused instead  
of discarding it; the 400 body carries a stable `code` and the blocking `paths`,  
which the page renders in its own words. Git runs as an argv array with  
`--no-optional-locks` (a background read never takes `index.lock` from a  
session's own commit) and a timeout, and the branch name is validated before it  
reaches git.

Clicking a file opens a preview panel on the right: one tab per file, line  
numbers, wrap toggle, reload, copy, a rendered view for Markdown, and inline  
images. Highlighting is a small regex tokenizer per language family (comments,  
strings, numbers, a shared keyword list), not a grammar per language; files over  
300 KB are shown uncoloured and only the first 10 000 lines are rendered. The  
panel is closed by default and takes its width from the main column, so the  
shell remains two-column when nothing is being previewed. Shift+Cmd+B toggles  
it; Alt+Cmd+P opens the tree for the current workspace.

The token indicator left of the model picker derives input/output totals from  
the usage each assistant turn reports and hides until a turn reports usage.  
Task summaries live in the content-height floating Summary board instead of the original\
floating banner. Task completion comes from canonical task state, not completed  
`task_create` / `task_update` calls.

A settled turn's deliverables render as file cards under the answer that  
closed it: a type tile, the file name, and its Markdown link label (or kind and  
folder) as the description, one full-width card or a two-column grid. The  
recognized kinds are supported document, image, website, spreadsheet,  
presentation, audio and video references. Recognition combines explicit local  
Markdown links with successful structured write/edit paths. Code-styled  
basenames qualify only when they identify an unambiguous observed output;  
fenced examples, failed tools, reads and shell prose do not prove delivery.  
The grid initially shows four cards and can expand. These are references or  
observed writes, not proof that files still exist; opening a missing file  
shows the existing preview error.

A page the embedded browser can render (`.html`, `.htm`, `.xhtml`, `.svg`)
opens there when its card is clicked. When the card's turn changed the file,
the card shows that turn's `+added -removed` lines, its first action opens the
turn's diff in the changes view unfolded at the file (the same records as the
"Edited N files" card). Every card opens its page as its own turn left the
file (`POST /api/v1/sessions/{id}/turns/{turnId}/site`), served from memory
beside the file, so successive edits of one page each show their own version.
The Host replays the session's records up to the end of that turn: the latest
full content a write recorded (Step's `write_file` included, even when the
file already held it), then each later patch applied forward. That does not
depend on what the file holds now. Without such a write (the file predates the
session) it reverses later turns' patches from the file on disk instead; when
neither reaches the version (an untracked change, a recreated file, or an edit
outside the session), a card whose turn changed the file opens the current file
with a notice. Changes count Step's `edit_file` and `write_file`, which record
the same patches as `edit` and `write` (a `write_file` from sessions recorded
before that has no patch and stays untracked; one that changed nothing is no
change). A card whose turn only referenced the file keeps a source
action instead of the diff. The pill also opens
the page in the system browser, named and shown  
with its icon: on Desktop the system default browser with its OS icon (macOS  
and Windows), in Web a new tab of the browser showing the page, detected from  
its user agent and Client Hints (Chrome, Safari, Edge and Firefox get bundled  
brand marks; other or unknown browsers a generic glyph). PDF  
cards keep the system-browser action only, because the embedded browser has  
no PDF viewer (Desktop guests run without plugins). Both browsers load the page from the Host's site preview  
(`POST /api/v1/workspace/site`, `apps/web/src/site-preview.ts`): a separate  
loopback origin that serves one known workspace under an unguessable token,  
GET/HEAD only, with workspace containment and no directory listings, so a  
page's relative CSS, scripts and images load. Agent-written HTML never runs on  
the client's origin, and the Host refuses `Sec-Fetch-Site: same-site` and  
`cross-site` requests, so a previewed page cannot use the page cookie.

Assistant local links and other cards open the same workspace-bound Files  
inspector. Repeating a card (or its source or changes action) closes its selected preview  
while preserving tabs and trigger focus; selecting another file switches the  
preview. Markdown opens rendered, and links inside it resolve relative to the  
document. Windows paths, encoded file URLs and line suffixes normalize before  
the existing file API is called. Paths outside the workspace are rejected;  
the Host remains responsible for realpath and symlink checks. There are no  
automatic historical content reads or new Office/PDF renderers.

The conversation header ends with a button that shows the workspace folder  
in the system file manager: Finder (with its icon) on macOS, File Explorer  
(a folder icon) on Windows, the default handler elsewhere. The Host launches it  
through `POST /api/v1/workspace/open` for a known workspace only, without a  
shell (`apps/web/src/open-folder.ts`), so Web and Desktop behave the same.

Each finished turn (one user message up to the next, including a message with  
images only) that changed files gets a card under its last row: "Edited N  
files", the summed `+added -removed` lines, and the files (three, then "show N  
more"). The data is the unified patch in the tool result `details.patch`, which  
both `edit` and `write` record themselves inside the file mutation queue, so it  
is persisted with the session entry and survives a reload. A `write` patch is  
taken after approval and after earlier calls of the same batch, and the result  
also records `created` and the overwritten file's line ending and BOM  
(`previous`). A write over 1 MB or of a binary file gets no patch  
(`details.untracked` says why); the card marks such files as not revertable,  
and a turn that ran `bash` says that what those commands changed is neither  
listed nor reverted. Clicking a file opens the preview panel in its changes view  
(turn picker, one row per file, inline diff with line numbers).  
"Undo" calls `POST /api/v1/sessions/{id}/turns/{turnId}/revert`. Each card undoes  
only its own turn: the turn's patches are reverse-applied newest first, and  
nothing is written unless all of them apply. Like `patch -R`, a hunk may have  
moved (later turns added lines elsewhere in the file) and its unchanged context  
lines may have been edited since; only the lines the turn itself changed must be  
intact. Otherwise the request is refused with 409 before anything is written,  
with a `code`: `conflict` only when undoing later turns first was simulated to  
work: the later turns not yet reverted that changed one of this turn's files  
(and, transitively, the turns that changed one of theirs), one of them having  
changed the blocking file, are reverted newest first, each as a whole, and then  
this turn, all in memory against the files as they are now; the card then tells  
the user to undo the later turns first, newest first. Otherwise the code is  
`modified` with the file's path: the file does not match and that order of  
undoing does not help (a `bash` command or an outside edit changed it). Also  
`missing`, `busy` while a turn runs or another revert of the session is in  
progress, and `reverted`. A prompt sent during a revert also gets 409. What a  
command changed cannot be undone, so a turn whose file a command rewrote stays  
refused. A failure while writing is reported as an error and is not rolled  
back. Paths that name the same file (letter case on a case-insensitive disk, a  
symlink) are reverted as one file. A file the turn created is deleted only when  
reversing reaches the `write` that created it with nothing left and the turn has  
no unpatched change to the same file (`created` describes that one write, not  
the whole turn); an overwritten file gets its previous line ending and BOM back.  
Patches compare LF text without a BOM, so a change to only the line endings, the  
BOM or the final newline is not detected. Files without a patch are left alone  
and listed in the response's `skipped`, which the toast names.  
A successful undo appends a `stepcode-web.turn-revert` custom message (in the  
model's context, not a new turn) naming the request and the restored files, so  
the model does not assume its edits are still on disk; the snapshot's  
`revertedTurns` is derived from these entries, so the state follows the branch  
and survives a host restart.

The composer's slash menu opens when the whole prompt is a single `/word`. It  
lists two groups, fuzzy-matched with the CLI's scoring (a client copy of  
`packages/tui/src/fuzzy.ts`): commands (`/goal`, `/init`, `/plan`, `/btw`,  
`/compact`, `/feedback`, `/mcp`) and the session's skills; a `skill:` prefix  
lists skills only. Arrow keys move through both groups, Enter or Tab picks,  
Escape closes. Picking a command inserts `/<name> ` so arguments can follow; the  
kernel runs it on send. `/compact` and `/feedback` therefore follow the same  
kernel command the CLI runs, and only the host's presentation differs:  
`/compact` appends a collapsible compaction row, and `/feedback` (typed without  
arguments or picked from the menu) opens the feedback dialog instead of a  
prompt. `/btw` opens its own rail tab (see below). Command replies reach the page through  
the kernel's `ui.notify` → SSE `notice`, never as a user or assistant message,  
so they do not enter the session file or the model's context; notices live for  
the page load and can be dismissed. Kernel `ui.input` prompts travel as  
`text-input-required` / `text-input-resolved` events and are answered through  
`POST /api/v1/sessions/{id}/text-inputs/response`.  
Skills come from `GET /api/v1/sessions/{id}/skills`  
(the session's resource loader, so plugin skills are included); a draft uses  
`GET /api/v1/workspace/skills`, which resolves the folder's skill resources  
without extensions. Picking a skill inserts `/skill:<name> `; the kernel  
expands it into the skill's instructions when the prompt is sent, and the  
conversation shows the skill as a chip above the request. Picking `/mcp` shows  
`GET /api/v1/mcp` in place: every server with its state, tool count and start  
error, including servers disabled in `config.toml`. The MCP status list is  
process-wide (written by the session that started last).

A compaction is a transcript fact, not a toast: the kernel's `compaction` entry  
is projected as a collapsed `compact` row (`已压缩 N 条历史记录（约 M tokens）`)  
whose summary opens on click and survives a reload. While it runs, the row says  
`正在压缩…`; a prompt sent then queues and starts when compaction ends.

Forking branches the session the way the kernel defines it: a new session id and  
file, `parentSession` pointing back, and the host rebound to the branch. The  
response's `sessionId` is that new id, and the store is re-keyed in the same  
step, so the client's next read and the inspector resolve instead of 404ing. The  
branch is titled `<parent title>_fork`, derived from the parent's current title,  
so forking a fork gives `<title>_fork_fork`. A fork is refused while a turn runs,  
while the context is compacting, or while another fork is in flight. A branch
gets its file with its first prompt, so an explicit fork at a recorded user
message works as soon as that message is on the branch; the implicit fork
branches *before* the newest prompt, so an untouched branch has nothing to keep
and reports "cancelled" (the client's generic notice).

`/btw` is the one command that bypasses the queue: asking a side question while  
the main task runs is its purpose, and the kernel runs extension commands before  
its streaming gate. Every other command is queued like a message, so `/compact`  
takes effect when the turn ends.

A `/btw` answer is its own thread, so it gets its own tab in the preview rail  
(`kind: "btw"`) instead of a transcript row: the conversation, its entries and the  
model's context are untouched, and the tab strip's × closes one answer without  
deleting it. The composer intercepts `/btw <question>` before it becomes a  
message: the tab opens at once with the question and a waiting state, because the  
answer takes a model round trip and the reader should see where it will appear.  
The kernel's `ui.sideAnswer` fills that tab in, rendering the answer as Markdown;  
a host without that surface keeps the Markdown notice, and the terminal keeps its  
panel. Answers live in host memory for the session (bounded, like the terminal  
panel's history), appear in the snapshot so a reloaded page can show them again,  
and are cleared by `POST /sessions/{id}/side-answers/clear`.

Plan mode is visible to the model as well as to the page. Only the user starts
it with `/plan` or `--plan`; there is no `enter_plan_mode` tool. `/plan <task>`
enters plan mode and sends the task as an ordinary user message, expanding picked
skills and prompt templates. The runtime appends a hidden `step-plan-mode`
custom message containing a `<collaboration_mode>` block on mode changes. It
names the plan file (`.stepcode/plans/session-<id>.md`), limits file mutations to
that file, and explains how to submit a decision-complete proposal. The system
prefix and existing tool order stay unchanged. Context projection restores a
missing announcement after compaction and announces Default mode after exit;
it does not append a new reminder on every unchanged request. The app's external
handoff instruction permits leaving without a new proposal but never treats
submission as approval to implement.

Announcement details record whether the current host can leave planning without
a proposal, so restoring the same plan on another host refreshes its handoff
instructions. A pending Default announcement is reused by context projection
rather than appended twice before it reaches the transcript.

Plan mode ends the way it does in the terminal: the model calls  
`exit_plan_mode`, or the user toggles `/plan`. A request that needs no proposal  
calls the tool once without writing the file; with nothing new to review it just  
leaves plan mode and the model answers directly. "Nothing new" means the plan  
file still holds the content it had when this round entered plan mode  
(`planHashAtEnter` in the `step-plan` entry) or the proposal already submitted in  
an earlier round (`submittedPlanHash`). The first check covers a file left over  
from an earlier round or from an older build, which the submitted hash alone  
cannot recognise; either way, re-entering with the Plan chip never posts the old  
plan for review again. The terminal, which has a review  
dialog, keeps refusing a missing file and tells the model to let the user leave  
with `/plan`. Tool results say the outcome plainly and persist it: after a  
submit or a plain exit they report that plan mode (which the host turned on for  
`/plan`) is now off and not to call the tool again. A call while already off
reports that only the user can start another plan round. The hidden Default-mode
announcement reaches the model, not the visible transcript: the strip closing
and (for a proposal) the review card are the user-facing report.

The host mounts the same tool profile as the CLI (`createStepToolProfile`), so  
the model is offered `read_file` / `write_file` / `edit_file` / `run_command`  
rather than Pi's builtins. Without it, plan mode enabled names that did not  
exist and a proposal could not be written at all ("Tool write_file not found").

State the client already draws is never narrated into the conversation: plan mode  
(`snapshot.planMode` → the composer's `Plan · <file>` strip) and the permission  
tier (`policies`) announce themselves with `notify(…, { transient: true })`, which  
the host forwards and the client shows as a short toast, not a row. Command  
answers (`/status`, `/usage`, `/todos`, `/cron`, `/btw` on a text-only host) still  
become dismissible notices, because those are answers to something the user  
typed.

The shared Web/Desktop composer also completes workspace files and folders at  
an `@` token after whitespace or at the start of a line. It follows the actual  
collapsed caret, not the whole prompt; email addresses and closed quoted  
references do not trigger it. Arrow keys select candidates; Enter or a row click  
inserts a plain-text reference and closes the list. Tab on a directory, or its  
right-hand arrow, inserts `@directory/` and continues into that directory.  
Spaces in paths use `@"path with spaces"`; a directory drill keeps the caret  
inside the closing quote. Escape closes the list without aborting a running  
turn, and dismissal survives refocusing the same unchanged token.

Completion replaces the active token, including any remaining token text to the  
right of the caret, without replacing surrounding prose or pasted file chips.  
Selection moves, edits, workspace/session changes and IME composition invalidate  
stale picks; queries are debounced and cancelled when replaced or closed. Enter  
and Tab during loading cannot pick an old result or accidentally send a prompt.  
References are sent as text, like TUI path completion; they are not uploaded or  
automatically inlined. Existing file uploads and image attachments keep their  
separate send paths. Electron does not expose any new filesystem capability.

Session archive flags are Web Host metadata in `web-sessions.json`; canonical  
conversation history remains the StepCode v3 JSONL file. Deleting a session  
closes the runtime, removes the metadata entry, and removes that session's  
canonical JSONL file.

Run from the repository root:

```bash
pnpm run web
pnpm run web:build
pnpm run web:serve
```

`pnpm --filter @step-harness/web test:e2e` runs the browser suite: it starts the  
Host on a free port with a temporary agent directory and drives headless Chrome  
over the DevTools protocol (set `CHROME_PATH` if Chrome is not in a default  
location; the suite is skipped when none is found). It needs no model  
credentials. The system folder chooser cannot be clicked by a test, so the  
suite puts a stand-in with the real helper's name first on the server's PATH  
and answers from a file; the real spawn, argv and parsing are still covered.

The production build emits `apps/web/dist/server.js`, the browser assets, and  
`apps/web/dist/openapi.yaml`.

The browser UI retains its cwd-grouped conversations and centered composer.  
The local presentation update adds a right tool rail and a mutually\
exclusive inspector area; it does not add a main-area header or Goal HUD.

The first release connects sessions, message/tool streaming, approvals, status,  
cwd file browsing, the three CLI permission presets, model selection, known-workspace  
selection, interrupt, archive/restore, rename, and deletion. The project module  
retains the original MVP's project/group views, in-memory categories, category  
filter, file tree, and in-place new conversation. Workspace selection is  
available only when composing a new conversation; adding a workspace is always  
available from the sidebar.

The avatar opens a Kimi-style account menu with Step Plan upgrade navigation,  
light/dark/system appearance, zh-CN/en-US language, a local settings dialog,  
and logout. Appearance and language persist in browser local storage. Search is  
a first-release modal that filters session titles, message text, and workspace  
paths with keyboard navigation.  
Sessions whose stored working directory no longer exists stay readable under  
Recent instead of being exposed as a file-browsable project.

Workspace selection appears only while composing a new conversation. It first  
offers recent folders and then an in-app folder browser. Existing conversations  
do not show a workspace switcher.

Attachments, agent-mode selection, and cron management UI remain outside the  
10/15 first release. Cron capabilities remain available through conversation  
tools.

## One-time import from a local stepgo launcher

The Web host (and therefore Desktop, which runs it) imports the providers a  
local stepgo launcher (`sc` / `stepgo`) injects into Step, once, before it starts  
serving. The implementation is  
[`apps/web/src/stepgo-import.ts`](../apps/web/src/stepgo-import.ts). It is  
Host code, not a kernel feature: the CLI does not run it, and it writes only  
through coding-agent's public `models.json` / `auth.json` APIs.

- Sources, read-only: `~/.stepgo/config/config.json` (`apiKey`, `baseUrl`) and  
  `~/.stepgo/config/agent/managed/config.json` (one provider per API dialect with  
  its model catalog). `STEPGO_HOME` / `STEPCODE_HOME` relocate the stepgo home.
- Each provider becomes a `models.json` declaration under its own id  
  (`tokens.maxContext` / `tokens.maxOutput` become `contextWindow` / `maxTokens`).  
  Its key becomes an `api_key` entry in `auth.json` under the same id; the  
  declaration never holds the key. The `step` account id is never written.
- An id already declared in `models.json`, or already holding a credential in  
  `auth.json`, is left untouched.
- A completed import writes `<agent dir>/stepgo-model-import.json`. While that  
  file exists stepgo is not read again: the imported providers are ordinary  
  custom providers the user edits or deletes on the model settings page. Delete  
  the marker to import again. Without stepgo installed, or when a provider fails  
  to write, no marker is written and the next start retries.
- `STEPCODE_STEPGO_IMPORT=0` (or `false` / `off` / `no`) disables the import; the  
  web e2e suite and `scripts/check-web-runtime.mjs` set it.
- Failures never stop the host; the host logs one `[models]` line when it  
  imports something, never the key.

## Editing a custom model provider

The model settings page declares providers and keys through
[`apps/web/src/model-providers.ts`](../apps/web/src/model-providers.ts). The form
shows the address, protocol, name and, per model, the id, context window, max
output, input kinds, reasoning flag and thinking-level map; a save rebuilds
exactly those. Everything it cannot show is kept from the stored declaration:
provider-level `headers`, `compat`, `cacheRetention`, `authHeader` and `modelOverrides`, and
per-model `api`, `baseUrl`, `cost`, `samplingParams`, `cacheRetention`, `headers` and `compat`. A
model row the form no longer sends is removed, because deleting a model is an
edit too.

For those fields the page header has an "打开配置文件" (Open config file) button:
`POST /api/v1/settings/models/open-config` opens the `models.json` the kernel
reads in the application the system associates with it (on macOS, the default
text editor when none is), creating an empty `{ "providers": {} }` file first if
there is none. The provider list reloads when the window regains focus, and
like form edits, hand edits apply to sessions started afterwards.

That rule is not cosmetic: `compat.forceAdaptiveThinking`
([models](../packages/coding-agent/docs/models.md#anthropic-messages-compatibility))
turns an Anthropic request from the legacy budget payload into adaptive thinking,
so a save made only to rotate a key must not silently change how requests are
built.

## Subagent presentation

The Web client uses fixed task rows: a persistent Bot icon, a\
separate status icon, an agent label, task summary and trailing disclosure.  
Structured `details.results` own the six task states; missing legacy statuses  
remain unknown. Planned single, parallel and chain calls show queued tasks,  
not fabricated running tasks. A rejected dispatch stays an ordinary failed  
tool with its original input/output; per-task errors remain inspectable.

Selecting a task opens the existing read-only child transcript API in the  
shared right inspector. Narrow screens use an overlay; expand, close and the existing Escape chain  
retain the parent session. The inspector follows the selected tool/task index  
as results arrive, shows model/turn metadata when recorded, and has no prompt,  
execution or permission controls. Pending child records poll sequentially  
without overlapping requests; late replies cannot replace another selection.

Background dispatch results are snapshots, not completion records.  
Custom `agent-notification` entries expose only a validated  
`details: { agentId, event, status }` projection. Known event/status pairs  
update registered lanes without parsing message text. Settled chain steps  
are preserved; a lane's terminal state cannot prove that a queued step ran.  
This does not change orchestration, permissions, JSONL persistence or model  
context. A host restart is needed for the added notification projection;  
client-only task rows and inspector changes need only a page refresh.

## Right inspector

The rail exposes Summary, Context, Changes, File preview, Subagents and Browser, plus the  
Terminal toggle right after Context. The toggle is not a rail panel: it opens the dock below  
the conversation, so it stays available beside any inspector. Summary is excluded from the  
Escape chain while a turn is running or waiting, so Escape stops the turn as it does with no  
inspector open.  
Summary replaces the original floating task/subagent banner, rather than  
coexisting with it. Summary is an independent content-height surface, not the  
full-height inspector used by other rail entries. The compact board is 320px  
wide with a 20px top inset, a 12px rail-side gap and a close-only header.  
It scrolls internally only when its content exceeds the viewport, and it always  
floats out of flow: it never reserves a grid column, so opening or closing it  
does not narrow or reflow the conversation at any workspace width. It shows plan  
tasks with completion counts and completed-task  
folding, a task progress track, agent records below the tasks, MCP and Skills.  
The header retains the Summary title and close control, with compact task  
completion and agent-record counts. Its activity dot pulses only for explicit  
in-progress tasks or running agent records. Missing task data or unknown agent  
statuses show an unknown indicator rather than implying completion; otherwise  
the indicator is idle. It does not represent the parent model's streaming state.  
The task track uses canonical completed/total tasks, never completed tool calls  
or agent counts. Width changes use a 300ms cubic ease-out and become immediate  
under reduced-motion; empty plans have no invented percentage.  
A current-task headline and collapsed capsule are excluded.  
Conversation navigation is intentionally excluded.

Session restoration is one page load's worth of work: after the credential and the launch  
folder are known, the page lists workspaces and sessions and then opens the newest  
conversation in the launch folder, or starts a draft there. A conversation the user opens, or a  
draft they start, while those lists are still loading wins: the late list must not replace the  
choice, so an early "new chat" click is never overwritten by the restored session.

Agent records reuse validated timeline subagent states, including queued,  
running, completed, failed, stopped, skipped and unknown. Counts refer to task  
or dispatch records, not distinct runtime agents. Structured per-task records  
take precedence over legacy child links to avoid double-counting one dispatch.  
Missing legacy status stays unknown regardless of parent tool outcome.  
Selecting a record opens the existing read-only task, child or workflow  
inspector while retaining the parent conversation. No execution controls or  
new session authority are introduced; background updates use the same  
structured projection as the transcript.

Task or subagent activity in the latest user turn automatically opens Summary  
when no inspector is active, including when restoring that turn from history.  
The trigger is consumed once per selected session/turn: same-turn updates do  
not undo manual dismissal, and activity never displaces another inspector.  
Tool outcomes only trigger presentation; they do not determine task completion.

Summary uses a scoped light/dark neutral palette, rose running tint, green\
completion and amber MCP failure status. Task and MCP disclosures animate their  
height; task chevrons appear on hover, focus or expansion. A live task completion  
contracts and regrows its fixed icon slot over 660ms, then draws the check mark;  
the row stays visible for 1100ms before folding. Initial completed history does  
not replay this transition. Reduced-motion disables spinner, disclosure and  
status animations. MCP switch-shaped indicators are decorative and read-only.  
These tokens and effects are scoped to Summary, not the transcript or app theme.

Files retain multiple tabs, image/Markdown previews, copy, wrap and refresh. Tool-triggered file, turn-change  
and child-agent opens select the same right panel rather than competing overlays.  
Closing a panel retains its selection; switching panels restores the standard  
layout. Non-Summary inspectors retain draggable persisted widths,  
standard/wide presets and an expanded view. Screens at 1200px or below start  
closed and use an overlay for these inspectors.  
Escape restores an expanded view first, then closes the panel without  
interrupting the parent turn. Existing higher-priority dialogs still dismiss first.

`GET /api/v1/sessions/{id}/inspector` provides whitelisted active-plan task fields,  
the session's available skill count, process-scoped MCP names/statuses and the  
kernel's session statistics. Tasks come from the latest canonical `step-tasks`  
snapshot on the active branch; a successful task tool is not evidence that a task  
completed. Statistics use `AgentSession.getSessionStats()` without reassembling  
model context. Totals include compacted history. Context usage is the kernel's  
estimate; recorded-message inspection is not a claim to show the assembled request.  
Provider transport fields, image payloads and opaque thinking signatures are  
excluded from the recorded JSON view. Missing statistics display unknown values.  
Polling is sequential, aborted on selection changes, and stale replies cannot  
replace the new session's panel.

Per-turn tool changes remain accessible in the transcript and Changes inspector,  
not as a substitute for Summary's repository overview. Repository comparison  
remains pending. Interactive terminals use the separate adapter below. No Desktop runtime  
or package is changed.

## Embedded browser

The Browser inspector shows pages drawn by Chromium itself; there is no
Host-side browser engine, screenshot stream or input forwarding, and
`playwright-core` is not a runtime dependency. Pages animate, scroll and take
input at the display's own rate and pixel density, with native keyboard,
input-method, clipboard and context-menu behaviour.

| Host | Surface | Owner of policy |
| --- | --- | --- |
| StepCode Desktop | One Electron `<webview>` per tab | Desktop main process (`apps/desktop/src/browser-guests.ts`) |
| Plain browser (Web) | One sandboxed `<iframe>` per tab | The client (`features/browser`) and the Host's framing headers |

The client chooses the webview when the Desktop bridge offers `browserGuest`
and the iframe otherwise (including an older Desktop build).

**Desktop.** Each tab reserves a one-time lease from the main process and
renders `<webview src="about:blank#<lease>">` in the lease's partition. The
main process refuses any webview without an unused lease issued to that
window, replaces the guest's preferences with a fixed sandbox (no Node, no
preload, context isolation, web security, dialogs disabled, no referrer) and
binds the lease when the inert start page is ready. All guests share one
in-memory partition: no StepCode cookie, storage or permission reaches it,
and it is gone when the app quits. Permission, device and screen-capture
requests are denied and downloads cancelled with a notice. The partition's
request filter refuses the StepCode Host port on every hostname, embedded
credentials and non-network schemes other than `about:`, `data:` and `blob:`;
main frames navigate to http(s) only. Native windows are never created: one
http(s) popup within 1.5 seconds of a click or key press in its page becomes a
panel tab, and other popups are dropped. While a page has focus, Cmd (macOS)
or Ctrl with R, L, T or W is kept from the page and from the application menu
and handled by the panel (reload the tab, focus the address bar, new tab,
close tab), so Cmd+R never reloads the StepCode window. A user can still choose
files for an upload in the native file chooser.

**Web.** Each tab is an iframe with
`sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"`
and no referrer: a page cannot navigate the StepCode page, download or open
modal dialogs; popups open as tabs of the user's own browser. A cross-origin
frame hides its address, title and history, so the surface keeps the history of
the navigations it started (address bar, back, forward, reload). A later
`load` means the page moved by itself: the address bar keeps the last known
address with a notice, and the next Back returns there. Tabs are labelled
with the page's host. Many sites refuse to be framed (`X-Frame-Options`, CSP
`frame-ancestors`); the frame cannot report that, so remote pages carry a hint
to use the external-open control. Framing protection is never stripped.

**Addresses.** The address bar completes a bare host with `https://`, or
`http://` for this machine (`localhost:5173`), and accepts http(s) without
embedded credentials only. It refuses the port the StepCode page is served
from on any loopback name. Independently, the Host sends
`Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`
on every response, so no frame can become same-origin with the client and lift
its sandbox. The Host's existing `Sec-Fetch-Site` and `SameSite=Strict` cookie
rules keep framed pages from using the page cookie.

**Previews.** Workspace previews (`src/site-preview.ts`) are addressed as
`http://localhost:<port>/...` although the server listens on 127.0.0.1. The
client is served from 127.0.0.1, and a page on another port of the same host
is same-site: measured in Chrome, a busy same-site iframe shared the client's
renderer process and dropped the conversation UI from 60 to about 25 fps,
while the same page from `localhost` ran in its own process and left the UI at
60 fps. A loopback dev server typed as `127.0.0.1:<port>` is still same-site.

**Tabs.** The panel keeps up to twelve tabs. They belong to the page:
addresses, titles and zoom (50-200%) are kept in sessionStorage, validated
when read, and reopened after a page reload. Hiding the panel keeps the pages
mounted; no page is created before the panel has been shown. Closing a tab
destroys its page (Desktop releases its lease). Back, forward, reload, stop
(Desktop), zoom and the external-open control act on the active tab.

Browser storage and navigation have no connection to Agent model context, tool
execution or the user's provider credentials. Agents cannot drive the
embedded browser.

## Composer performance

A compact performance row below the composer shows run elapsed time, average\
output throughput, cumulative session input/output tokens and cache hit rate.  
The existing usage menu remains available. Tokens come from the SDK statistics  
on the existing inspector endpoint, not rendered message rows; input includes  
cache reads/writes and totals include compacted history and tool-only responses.  
Cache hit is cacheRead / (input + cacheRead + cacheWrite), and remains unknown  
when no cache usage was reported. Missing or failed statistics are not zero.

Timing is temporary browser-local observation, separate from persisted thinking  
timing. Elapsed time starts at an observed agent start and freezes at settlement,  
including approval and retry waits. Throughput uses reported output tokens over  
completed, observed assistant response intervals, including thinking but excluding  
tool execution and retry backoff. It is response throughput, not the provider's  
decoder speed or an estimate from text length. Switching sessions, disconnecting  
the stream or reloading clears timing; historical timing is never synthesized.  
Statistics reads are sequential, aborted on selection changes, and polled only  
while the selected session is active. Hints explain each measurement's scope.  
The row wraps complete metrics on narrow screens and uses the existing themes.  
No new HTTP/SSE fields, dependencies, persistence or Desktop-specific code are added.

## Interactive terminals

The terminal is a resizable dock below the conversation, toggled from the right  
rail or with Ctrl+`, and stays available beside any inspector. Its header shows
the shell and one tab per terminal, named after the workspace folder (`name`,
`name 2`, ...). Opening an empty dock starts one shell; ending the last tab hides
the dock. The dock height is remembered; whether it is open is not. It uses
`@xterm/xterm`with`@xterm/addon-fit`; the Host
owns isolated Node helper processes using `node-pty`. This is a real interactive
shell, not a model tool log or a pipe-based command runner. Creating a terminal
is explicit. Windows chooses installed PowerShell 7 or Windows PowerShell;
macOS/Linux choose the user's `$SHELL` when it is bash, zsh or sh, otherwise an
available one. A shell starts in the workspace folder as a login, interactive
shell, like a desktop terminal: it runs the user's startup files
(`~/.zprofile` and `~/.zshrc`, `~/.bash_profile`, `~/.profile`), so PATH,
aliases, history and the prompt (for example a theme showing the Git branch)
match the user's own terminal. PowerShell likewise loads the user's `$PROFILE`and keeps PSReadLine history; only the console encoding is set to UTF-8 after it.
Without a prompt module (posh-git, oh-my-posh, starship) PowerShell shows its
default`PS <path>>` prompt, without a branch.
Inherited startup-injection variables (`BASH_ENV`, `ENV\`, Node loader options)  
are not passed on: the environment keeps an OS-variable allowlist plus the SSH  
agent socket, not the Host's API keys or Node loader configuration. The user's  
startup files may export their own credentials, as in any terminal.  
This is not a sandbox: entered commands run with the Host user's filesystem  
and network privileges and can read credentials available to that OS user.

`/api/v1/terminals/*` is behind the existing HttpOnly cookie and Origin checks.  
Creation accepts a known workspace and bounded dimensions, not a caller-chosen  
executable or startup command. There are at most eight tabs per workspace and  
24 per Host, including exited/failed tabs. Tabs belong to workspaces, not Agent  
sessions. Changing conversation within the same workspace retains the tabs.  
Multiple authenticated pages may view/control the same shell; dimensions and  
input are shared. There is no per-page terminal ownership lease.

Hiding the dock disconnects its output stream, not the shell.  
Switching terminal tabs does the same. Refresh lists existing terminals and  
replays retained output without creating a second process. Closing a terminal  
tab terminates its owned process tree before removing it. Normal Host shutdown  
attempts cleanup of all owned terminals and reports failures with a nonzero  
exit status; unrelated externally launched services are untouched. Host restart  
does not restore terminals. Crash recovery and processes deliberately detached  
from terminal ownership are not guaranteed to be cleaned up.

Natural shell exit keeps helper ownership until Host cleanup settles. On  
Windows, cleanup also enumerates descendants of the exited shell, bounds them  
by creation time and verifies process identity against an open handle before  
termination, so a stale PID does not authorize killing a replacement process.  
Close and shutdown await the same cleanup; failures keep a retryable failed  
tab. Startup cancellation waits for the shell identity or startup failure  
before terminating the helper, avoiding a shell spawned after tree enumeration.  
On macOS/Linux the helper runs in its own process group and cleanup kills the  
shell's session, process group and controlling-tty members (plus their  
descendants), including background jobs that outlive the shell.  
This does not provide Job Object containment: descendants whose intermediate  
parents have already disappeared, deliberate detachment and abrupt Host  
failure remain outside the guarantee.

SSE snapshots carry sequenced output and lifecycle metadata. The Host retains  
at most 512 KiB / 2048 chunks per terminal; a replay gap produces a visible  
truncation notice. Replaying a truncated ANSI tail is not a full terminal-screen  
snapshot and may produce an incomplete screen layout. The adapter writes no  
output files; the shell keeps its own history as the user's startup files  
configure it. The helper pauses output at 256 KiB of unacknowledged  
IPC and resumes below 64 KiB; Host acknowledgement is independent of UI presence.  
Network backpressure reads from the bounded ring rather than accumulating a  
subscriber queue. Input is bounded to 64 KiB per request, 32 outstanding Host  
commands and 64 client commands. Timed-out input is not automatically repeated.

The client fits the PTY to the panel, supports ANSI rendering, selection,
Cmd/Ctrl+C copy, Cmd/Ctrl+V paste and normal terminal input including IME.
Paste is the browser's native `paste` event, which carries the clipboard text
with the event: the client never reads the clipboard from script, so pasting
needs no clipboard-read permission (Desktop grants none) and a refused read can
no longer surface as a transient error. A paste over the Host's 64 KiB input
limit is refused before xterm forwards it, because the Host would close the
stream. Copy still uses the clipboard API and reports a refusal. OSC 52
clipboard writes and link activation are disabled. Clear affects the local
display only and does not stop the shell or erase the Host replay buffer.
Native PTY startup has been verified on Windows and macOS; Linux requires its
own acceptance.
Dependencies are pinned and installed without lifecycle scripts. The list route  
reports `support` before any shell starts, so the dock can explain a missing  
native build instead of offering a broken button. A missing or incompatible  
native binary fails the terminal without taking down the Web Host; it does not  
trigger an automatic download, compilation or toolchain install. The one repair  
the Host makes is restoring the exec bit of node-pty's published macOS  
`spawn-helper`, which the package tarball ships without and which installs  
that skip lifecycle scripts never fix.

## Thinking presentation

The browser projects structured `thinking`, `text` and `toolCall` blocks in  
source order, both from saved entries and live `message_update` events.  
Non-redacted thinking supplied by the provider remains expandable in history;  
sessions without thinking blocks do not acquire invented records. Opaque  
thinking signatures and redacted blocks are never rendered.

The main transcript uses compact process groups as a fixed presentation default, without\
a complexity setting. A single thinking or ordinary tool record shows only its  
own disclosure, without a second group heading or group indentation. Two or more  
consecutive records share one folded process row. Member components retain their  
identity as the group grows or shrinks; a manually opened singleton remains visible  
when another member arrives. While active, the group label and short preview  
follow the current pending tool or thinking block; settled groups summarize completed tool kinds.  
Thinking-only history stays a thinking record, not a fabricated tool result.  
Expanding preserves every original thinking/tool row, input/output and file  
or diff action. Ordinary collapsed tool rows keep their icon and label while  
arguments remain inside the disclosure. A single observed thought's duration  
also remains visible on the folded process row; individual durations remain  
available in expanded multi-thought groups.

Prose, images, model request failures, approvals, retry rows and dedicated
Subagent/workflow, plan and clarification calls end a process group. A failed
ordinary tool call stays inside its group and counts in the settled summary;
opening the group shows its failed label and red glyph. Calls awaiting approval and
unresolved historical calls are never summarized as completed or running.  
User-turn boundaries, reply attachment areas, change cards and settled footers  
remain outside process folds. Search can reveal recorded thinking inside a  
folded group. This grouping changes no session entries or model context.

Thinking retains its folded disclosure with a Brain icon. Only the  
currently streaming thinking block has the tool-style running label, shimmer  
and a short content preview. Text/tool output, message completion or a settled  
session stops the running state and folds an open live thought. A settled  
thought can be reopened manually. Reduced-motion skips folding/shimmer effects.  
The host observes each block's structured thinking start/delta/end events.  
The label shows elapsed seconds, ticks once per second only while\
that block is active, and freezes before prose or tool arguments start.  
Each assistant message's completed observations are saved through  
`SessionManager.appendCustomEntry` as `stepcode-web.thinking-timing` metadata  
(version 1, message timestamp identity and per-content-index intervals).  
These custom entries do not enter model context or change provider messages.  
Validated `thinkingTimings` are projected onto saved assistant entries and  
live agent SSE envelopes; browser refresh and host restart restore completed  
observations. No elapsed time is inferred from message timestamps, tokens or  
browser receipt times. Legacy sessions and unobserved child-agent histories  
show no duration. Abrupt host termination cannot reconstruct an unrecorded  
interval. Metadata write failures are reported without preventing the  
canonical assistant message from being persisted.

Thinking is not a tool and does not enter task/tool counts or response-copy  
text. The response footer remains once per settled user turn and is revealed  
only on hover or keyboard focus. Thinking timing is host-owned presentation  
metadata; agent context, provider behavior and tool permissions remain unchanged.
