# StepCode Desktop local migration

StepCode Desktop and Web share an offline migration service for **sessions,
skills, ordinary MCP declarations and instruction rules**.
This guide describes the implemented local workflow, not a general document,
account or application-state migration. The Host delegates migration to the
coding-agent service; it does not implement a second session store.

- [First use and settings](#first-use-and-settings)
- [Supported resources](#supported-resources)
- [Paths and project selection](#paths-and-project-selection)
- [Preview, confirmation and publication](#preview-confirmation-and-publication)
- [Cancellation and recovery](#cancellation-and-recovery)
- [MCP settings edits](#mcp-settings-edits)
- [HTTP contract](#http-contract)

## First use and settings

The first-use invitation is **Desktop-only**. Bootstrap reports
`migrationAvailable`, `migrationSuggested` and, when readable,
`desktopOnboarding`. The Host suggests the invitation when migration is available,
the invitation state is `unseen`, and discovery finds at least one local Claude
Code, Codex, WorkBuddy or Qoder session that has not been imported yet, at any age
and excluding archived sessions. The check stops at the first such session and
leaves scan results untouched; a failed check withholds only the invitation.
Existing StepCode sessions and explicitly hidden workspaces do not suppress it.
Finding a session is not a claim that it will import cleanly.
The client persists `offered` before displaying the invitation. Web does not
show this automatic Desktop invitation; the settings migration entry remains
available for later use. Migration uses the settings surface's active light/dark
theme, rather than an independent theme setting.

Local scanning, previewing, importing and recovery require **no Step login,
model credential or model request**. The launch cookie still authorizes access
to the local Host. Configuring a model for subsequent conversation is a separate
step; lack of a runnable model does not forbid local migration.

`GET/PATCH /api/v1/desktop-onboarding` owns the durable invitation state.
`schemaVersion` and `flowVersion` are both `1`; statuses are `unseen`, `offered`,
`in_progress`, `completed` and `skipped`. A PATCH supplies `expectedRevision`,
`status` and optionally `lastJobId`. A missing state file returns `unseen` at
revision zero without creating a file. Writes increment the revision under an
exclusive lock. A stale revision is `409 onboarding-revision-conflict`.

`completed` and `skipped` are sticky for flow version 1 across restart, upgrade
and Step sign-out. Completing the invitation records a user decision, not that
every resource imported successfully. `lastJobId` is only a durable pointer;
omitting it preserves the old pointer. A leftover onboarding writer lock is
reported as `onboarding-locked`, not automatically stolen. Unavailable invitation
state does not disable existing chats; use the explicit API to inspect its error.

## Supported resources

| Resource | Implemented sources and discovery | Import behavior and limits |
| --- | --- | --- |
| Sessions | Claude Code, Codex, WorkBuddy and Qoder local supported JSONL history | Import a reviewed history snapshot into an explicitly selected project; preserve source provenance. Archives and child sessions are excluded by default in unified scan. No source process, credentials, approvals, file checkpoints or hidden reasoning are restored. |
| Skills | Claude Code and Codex skills; shared `.agents/skills`; StepCode-owned skills; installed plugin skill declarations; selected-project equivalents | Copy a complete `SKILL.md` package including supporting files when needed. Plain standalone Markdown is not a copyable skill package. Direct references and plugin-owned resources do not need automatic physical migration. |
| Ordinary MCP | Global Claude Code `mcpServers` and Codex `mcp_servers` declarations | Translate supported stdio/HTTP declarations into global StepCode config only, enabled. Project `.mcp.json` and project entries embedded in Claude config are reported unsupported, not imported globally. Equivalent configured/plugin-provided declarations are not duplicated. |
| Rules | Global Claude Code/Codex rule files and direct selected-project rule files | Recognize `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`; write only the destination `AGENTS.md` after rule-impact review and confirmation. Already effective project rules are references, not automatic copies. |

The session adapters support Codex response-item/rollout records, Claude message
chains, WorkBuddy message/tool records and Qoder's final `active-leaf` chain.
Other versions, encrypted or cloud-only history are not guaranteed. Historical
tools retain recorded outcomes, including unknown outcomes; they do not become
running tools or native child-agent relationships. See the package's
[session import contract](../packages/coding-agent/docs/session-import.md#compatibility)
for history conversion and continuation semantics. The existing
`/api/v1/session-imports` API is unchanged by unified migration.

This is **not arbitrary Markdown document migration**. Discovery reads bounded
resource contents to inspect compatibility, settings and trust. In particular,
MCP scan parses JSON/TOML configuration; it is not metadata-only. Reports distinguish
`missing`, `empty`, `error` and `unsupported`. Candidates expose `holding`
(`external`, `reference`, `stepcode`, `plugin`), `readiness` (`ready`, `disabled`,
`shadowed`, `untrusted`, `unsupported`, `unknown`) and `needsMigration`. A file
being present does not establish that it is enabled or safe to activate.

## Paths and project selection

Paths belong to the **Host machine**, not the browser machine. They are resolved
from the injected home, agent directory and configuration namespace. Defaults
are examples, not fixed roots for all embeddings:

| Purpose | Resolution |
| --- | --- |
| Home | Injected `HOME`, then `USERPROFILE`, then the OS home |
| Agent resources/state | Injected `agentDir`; Web supplies `resolveStepAgentDir()` (`STEP_CODING_AGENT_DIR`, otherwise `<home>/<namespace>/agent`) |
| Namespace | `STEPCODE_CONFIG_DIR`, otherwise `.stepcode`; migration requires a single directory name |
| Global config | `config.toml` beside the agent directory, not inside it |
| Skills targets | `<agentDir>/skills/<name>/`; project targets are `<cwd>/<namespace>/skills/` |
| Rules target | `<agentDir>/AGENTS.md` globally, or `<cwd>/AGENTS.md` for a project |
| Sessions | Injected session root (`STEP_CODING_AGENT_SESSION_DIR`), otherwise `<agentDir>/sessions`; item results report the actual published path and scope |
| Durable migration state | `<agentDir>/migration/`; invitation state is `<agentDir>/desktop-onboarding.json` |
| Claude Code sources | `CLAUDE_CONFIG_DIR` or `<home>/.claude` for projects/skills/commands/global rules; ordinary MCP comes from `<home>/.claude.json` |
| Codex sources | `CODEX_HOME` or `<home>/.codex` for sessions/skills/global rules/MCP config |
| WorkBuddy/Qoder sessions | `<home>/.workbuddy/projects` and `<home>/.qoder/projects` |

StepCode discovery also inspects `<home>/<namespace>/skills`, in addition to
agent skills, and plugin declarations from the resolved plugin storage roots.
The original `<home>/.claude/skills` remains a direct-reference discovery source
when `CLAUDE_CONFIG_DIR` differs. Shared `.agents/skills` and supported project
`.claude/skills` references can be loaded directly; scanning them does **not**
physically copy them. Project ancestor shared/Claude skills are inspected up to
the Git root. The settings, ignore patterns, name precedence and trust verdict
still determine their readiness. Uncertain resource configuration is not
presented as certainly active.

`scan.projectCwds` is an explicit list of existing absolute source directories.
The Host canonicalizes each; the invitation's folder picker may choose any
existing directory, not only registered workspaces. Picking a folder is a
read-only source choice: scanning never infers project-resource directories
from every historical session cwd, registers a directory, or grants trust.
Project skills retain the product's path-based trust and enabled rules; workspace
registration alone does not grant trust. Rules use their separate loading-impact
consent and must not be described as blocked solely by workspace registration.
The effective service
limit is 30 selected source projects in both the HTTP adapter and service.
Omitting `projectCwds` retains the previous service selection; `[]` clears it.

Preview project targets must be explicitly chosen existing canonical directories.
The service pins their identities without adding them to the source scan set. A session must have an
explicit project target; ordinary MCP has only a global target. Selecting a
folder is not a trust grant. Untrusted projects block skill activation;
rules have a separate explicit impact acknowledgement rather than silently
changing the trust store. The stricter rule inspection follows default-loader
ancestor precedence and supported nested-worktree deduplication, and rejects
an unsupported inspection rather than claiming safety. Resource-level symlinks
are refused; system-owned macOS `/var` and `/tmp` aliases are canonicalized.

See [configuration and trust](step-configuration.md) for the shared directory
contract. Use returned locations instead of synthesizing paths from the client.

## Grouped selection and destination controls

The wizard has four resource steps followed by the final plan. Sessions, skills and
MCP candidates are grouped by their actual source, scope and root. Expand a group
to inspect individual items; group and overall selection show checked, unchecked
or indeterminate state. Selection starts bounded sequential previews; it does not
confirm sensitive values, scope expansion or AI-rule impact on the user's behalf.
Already usable references, disabled resources and plugin contributions do not
enter the ordinary select-all set.

The footer offers Previous/Continue and an explicit final-plan action. The supported
import mode is shown, not guessed from the source: history creates new copies,
skill packages are independent copies, and ordinary MCP configuration is merged
in global scope and enabled. Link-based migration is not offered.
A category-wide destination change invalidates existing previews and confirmations
and re-previews selected items. Hiding the dialog does not leave some items ready
at their earlier destinations. The category default also applies to new selections;
resetting the default does not silently remap existing explicit destinations.
AI rules retain individual target and content review, never bulk consent.
Historical prompt job results remain readable, but prompts are not a current
scan, preview or selection category.

All controls inherit the active client theme and shared UI primitives.

## Preview, confirmation and publication

1. **Scan** the chosen resource kinds and source projects. No target resource is
   written. `needsMigration: false` prevents automatic duplicate copies of
   configured MCP, directly referenced skills/rules and plugin-owned resources.
2. **Preview** a candidate with target, optional new name and explicit action.
   Review the source/target/result text, skill package file list, blockers,
   activation and, for rules, effective paths before/after and shadowed paths.
   MCP text remains redacted even though literal values are imported.
3. **Confirm** previews by submitting `selections` to `/migrations/plans`, with
   every `requiredAcknowledgements` value in each selection's `acknowledged`.
   Required codes are `rules-impact`, `scope-expansion`, `independent-copy` and
   `sensitive-values`. A plan does not write resources.
4. **Start** only that immutable `planId` and `digest` with an `idempotencyKey`.
   The service reserves reviewed sessions and revalidates the batch before
   publication. The same key/digest returns the previous job. A different
   digest for that key returns `409 idempotency-conflict`.
5. **Poll** the job and inspect each item, including requested versus actual
   destination. `202` means accepted, not that any item completed successfully.

A directly referenced, disabled or shadowed skill is not an automatic copy.
Creating an independent copy requires a new skill name and `independent-copy`
acknowledgement; it does not enable or rewrite the original. Project-to-global
resource movement requires `scope-expansion`. Unsupported, unknown or untrusted
resources remain blocked rather than being promoted by copying; plugin-managed
resources allow only skip. Target ignore/configuration settings may still leave
a copied resource disabled. These verdicts do not replace the shared trust rules.

A rules preview binds **create/append/replace** to consent. A missing `AGENTS.md`
allows `create`; an existing file allows `append` or `replace`, with a backup.
If the default `create` is invalid for an existing file, choose append/replace
and preview again. `skip` is available without applying a change. At most one
non-skipped rules write is allowed per plan so one rule change cannot invalidate
another item's impact review. A higher-priority override that would hide the
target blocks the write. Rules enter default model context on future resource
loads; confirmation is not a reload of an active session.

Previewed source, destination, effective rule files (including absent
higher-priority files), project identity and ignore/configuration state are
fingerprinted. Changing resource inputs or choices requires another preview;
conflicts such as `source-changed`, `target-changed` and `preview-changed` return
409 before publication, or appear in a failed item's diagnostics if detected
during the job. Session history uses its retained reviewed snapshot, not a live
source process. Submitted choices cannot be silently revised at start.

Previews last 15 minutes; the plan expires with its earliest preview. Caches are
in memory and do not survive Host restart. Bounded resource reads allow at most
4 MiB per file, skill packages at most 512 files/32 MiB and depth 12. Resource
discovery caps candidates at 2000 and reports truncation. Preview cache limits
are 500 entries/128 MiB weighted memory and plan cache limit is 100. A plan has
1–200 selections; the session service separately limits a reservation to 100
sessions. A limit or unsupported format is not an empty-success result.

## Cancellation and recovery

Jobs have `queued`, `running`, `stopping`, `completed`, `cancelled` or
`interrupted` status. Items have `pending`, `running`, `imported`, `skipped`,
`failed` or `not-run` status. Keep persisted outcomes separate from activation:
`history` is imported history, `disabled` is stored but disabled, and
`next-resource-load` is future resource loading, not immediate activation;
`unchanged` applies to skipped items. A `completed` job can contain failed or
not-run items; inspect the item list rather than treating the job label as an
all-success verdict.

`POST /migrations/{jobId}/cancel` requests stopping remaining units. It does
**not roll back published items** or forcibly interrupt an atomic publication
already in progress. Poll until the job settles. A failed or uncertain unit also
stops the remaining batch without automatic retry or rollback. Shutdown requests
stopping and waits for owned preparation/publication and session reservation
release before closing the injected session importer and index.

Durable journals record publication intent and hashes. After a Host interruption,
unfinished jobs become `interrupted`; a matching published target can be
reconciled to `imported`. Uncertain outcomes remain visible as diagnostics, not
silently retried. Session reimport does not overwrite a continued native session;
actual target scope may differ from the newly requested scope when a verified
snapshot already exists. No whole-job transactional rollback is promised.

Recovery is narrower than migration:

- Only a rules append/replace with an existing-file backup supports recovery.
  New rules, copied skills, MCP and imported sessions have no undo through
  this API. Recovery does not delete their targets or touch the source app.
- `POST /migrations/recoveries/preview` takes `jobId`/`itemId`. It requires a
  recoverable journal item, matching current-target and backup hashes, and a
  selected project where applicable. Re-select that project after Host restart.
- `POST /migrations/recoveries/apply` takes the recovery `previewId` and
  `acknowledged: ["rules-impact"]`. It rechecks current target, backup and
  effective rule impact under migration/target locks. Changed files or impact
  produce `409 recovery-target-changed` or `recovery-impact-changed`; an expired
  preview requires another review. An already restored item is not restored twice.
- Recovery affects future resource loads only. It cannot remove previously
  assembled model context or reload active sessions. External editors do not
  share the service locks: hash checks guard replacement, but do not provide a
  universal compare-and-swap against every filesystem writer. Interrupted
  recovery is reconciled from its durable intent; uncertainty is reported.

## MCP settings edits

Migration writes ordinary MCP declarations **enabled** and never connects to
the source server during scan or preview. After a job writes MCP declarations the
Host re-syncs its pooled connections (`MigrationService` `onMcpChanged`), and
running sessions reconcile the new declarations before their next request, so
the tools are usable in conversations right away. Migration is not a promise
that the server will connect or expose tools successfully.

By default migration copies literal environment/header values (API keys,
`Authorization` headers), arguments and URL components so the server works
without manual re-entry; no separate confirmation is required. Supported
`${VARIABLE}`/`${VARIABLE:-}` references remain, and their resolution is the
target runtime's responsibility. `includeSensitiveValues: false` in the preview
strips those literals instead (reported as `sensitive-values-omitted`). OAuth/login
state is **never migrated**. Preview and job
DTOs never expose stored commands, arguments, URLs or literal configuration
values; warnings record omitted or untranslated fields.

`GET /api/v1/settings/mcp` returns global user declarations and plugin rows.
User rows contain `revision`, `protectedFields` and `config` as **safe metadata**:
enabled/shared flags, timeouts, tool allow/deny lists and valid environment
reference names. Stored command, args, cwd, env, URL, literal headers and OAuth
are omitted and listed as protected fields. Omitted fields must not be written
back as blanks. Generic connection diagnostics replace raw runtime errors.
Plugin rows have no editable configuration/revision.

`PUT /api/v1/settings/mcp/{name}` now requires `{ "patch": { "revision": "…",
"fields": { … } } }`, not `{config}`. Each field has explicit intent:

```json
{
  "patch": {
    "revision": "<revision returned by GET settings/mcp>",
    "fields": {
      "command": { "operation": "keep" },
      "args": { "operation": "keep" },
      "enabled_tools": { "operation": "set", "value": [] },
      "disabled_tools": { "operation": "remove" }
    }
  }
}
```

This example is illustrative; replace the placeholder with the returned revision.
Omission or `keep` preserves the authoritative value exactly, including protected
values and empty restrictions. `set` supplies a new validated value; `remove`
explicitly deletes one. Switching transport must explicitly remove incompatible
fields. Global config publication is locked and revision checked. A stale edit
returns 409; the current Host exposes only `error: "MCP configuration changed;
reload before editing"` (the service's internal code is `mcp_settings_changed`),
not a wire `code` field. Reload before retrying. Ordinary settings remain
**global-only**; plugin declarations are not replaced by this PUT.

## HTTP contract

The authoritative schemas and all endpoints are in
[OpenAPI](../apps/web/openapi.yaml). Relative paths below are under `/api/v1`:

| Method and path | Request | Response |
| --- | --- | --- |
| `POST /migrations/scan` | Optional `kinds`, `projectCwds` in a JSON object | Candidates, source reports, `truncated` |
| `POST /migrations/preview` | `candidateId`; optional `target`, `action`, `targetName`, `includeSensitiveValues` | Immutable preview and required acknowledgements |
| `POST /migrations/plans` | `selections: [{previewId, acknowledged}]` | Immutable `id`, `digest`, `expiresAt`, preview items |
| `POST /migrations` | `planId`, `digest`, `idempotencyKey` | 202 job; same-key replay returns the recorded job |
| `GET /migrations` | No query | `{jobs}` |
| `GET /migrations/{jobId}` | Path ID | Current job/revision/items |
| `POST /migrations/{jobId}/cancel` | Empty body or `{}` | Current job; poll for settlement |
| `POST /migrations/recoveries/preview` | `jobId`, `itemId` | Guarded rules recovery preview |
| `POST /migrations/recoveries/apply` | Recovery `previewId`, `acknowledged` | `{restored: true}` |
| `GET /desktop-onboarding` | None | Durable invitation state |
| `PATCH /desktop-onboarding` | `expectedRevision`, `status`, optional `lastJobId` | Updated invitation state |

All routes inherit the loopback Host's signed HttpOnly cookie and Origin/fetch
metadata checks. An allowed Origin is required when Origin is supplied; missing
Origin is permitted for local non-browser clients. `Sec-Fetch-Site: same-site`
and `cross-site` are refused. A Step account is not this local authorization.

Migration URLs reject query strings, trailing slashes and encoded segments.
Migration bodies are at most 65536 bytes; when supplied, Content-Type must be
`application/json`. Unknown request keys are rejected. IDs use at most 256 ASCII
alphanumeric/underscore/hyphen characters. The idempotency key is more strictly
limited to 128 such characters by the service. Other adapter text fields have
512-character bounds, paths 4096, target names 255; resource names are further
limited to 64 safe characters, with stricter lowercase skill naming. At most
four acknowledgements are accepted per selection. These migration body limits
do not imply identical limits on the separate onboarding/settings adapters.

Migration errors return `{error: code, code}` using safe known diagnostic codes.
400 denotes invalid input/missing acknowledgement, 404 an unknown candidate,
preview, plan, job or unavailable recovery, 409 stale consent/conflict/busy,
413 an oversized migration body, 415 an unsupported supplied Content-Type,
429 cache limits and 503 unavailable migration. Host authorization failures are
401 with the existing `{error: "Authentication required"}` envelope; a scan
source that is not an existing canonical directory is 400 `invalid-migration-path`. MCP settings
use their existing error envelope rather than the migration envelope.
