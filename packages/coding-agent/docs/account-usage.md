# Account usage and local activity

`/usage` opens two tabs: **Overview** and **Account**. `/usage overview` and `/usage account` open either tab directly. `/usage --refresh` and `/usage account --refresh` refresh Account. Session and History are not separate tabs or commands.

## Overview

Overview reads this machine's Step session JSONL files and shows the last 365 local calendar dates. It includes an activity heatmap, daily token/chat totals, reasoning settings recorded at dispatch, discovered/used skills, and plugin/skill runs. `P` switches all projects/current project; `[` and `]` select a date. Narrow terminals show recent weeks while totals still cover the year.

All active heatmap cells use the theme's accent color. Denser blocks indicate more tokens; `▣` marks the selected date and `·` indicates no token usage.

Tokens include assistant replies, tool-reported usage, compaction/branch summaries, and incremental AutoCLM records. Input includes ordinary input plus cache reads/writes. All main-session entries are counted, including restored history and branches; cumulative AutoCLM summaries are not counted again. Subagent tokens contribute to Overview, attributed to their parent project; subagent sessions do not increase the chat count.

Forks/exports carry small origin manifests so copied entries retain their original session/project. Missing legacy parent files and older sessions without activity/provenance records are reported as limited coverage. Skill activation means an actual read of a loaded SKILL.md; plugin ownership comes from discovered manifests/tool registrations. Historical metadata is not inferred from today's configuration.

Reading runs in a worker and does not migrate or rewrite session files. Only statistics/identity metadata is retained in a rebuildable private cache. Message text, prompts, tool arguments, credentials and errors are not copied to that cache. Append-only prefixes are verified, incomplete tails wait for the next scan, corrupt caches rebuild, and concurrent commits compare source identity/prefix under a short lock.

Limits are explicit: 10,000 files, 25,000 selected records, 16 MiB per source line, depth 64, 200,000 JSON tokens, 256 KiB retained metadata per line, 4 KiB per retained string, 1 second per parse and 30 seconds per scan. Budget-limited/invalid records produce coverage notices. Node additionally limits worker heap; the same parser budgets apply in Bun. A process crash can leave a cache lock until its 5-second stale threshold; it does not affect source sessions.

## Account

Account queries the personal Step Plan usage endpoint with the stored CN/Global Plan credential. Model/gateway keys supplied by `STEP_API_KEY` or `--api-key`, platform profiles and unknown profiles do not query that endpoint. Redirects are rejected. Keys stay in the controller, outside renderer/output data.

CODING plans show 5-hour and weekly percentages **remaining** and reset times. Nonpositive upstream limits mean Unlimited. TOKEN plans show the remaining percentage for each subscription/top-up Credit bucket and reset/expiry times, without displaying raw Credit balances. Account and Status use compact 12-column bars with reduced-height blocks to represent remaining quota. A missing percentage, including a zero-total bucket, is shown as unavailable rather than 0% or 100%. Credit quantities remain exact decimal strings in the snapshot; percentages use the API's validated `used_percent` without converting Credit quantities to floating point. Unknown future bucket types are marked unsupported; partial bucket errors are not displayed as zero balance.

The current main-session summary is local and includes restored/inherited history and incremental compression usage. It excludes separate child-session files. Cache hit is cache reads divided by complete input; an empty denominator is Unknown.

Account responses have a 30-second memory cache and a 5-minute display lifetime. Identity/profile/endpoint/key changes invalidate it. Requests are single-flight, time out after 12 seconds and are cancelled when the panel closes or changes tabs/sessions. Attempt generations reject late responses. TTL/cooldown use a monotonic clock; HTTP Retry-After supports seconds and HTTP-date. Visible temporary failures retain a stale snapshot; 401/403 clear the snapshot without deleting credentials. No background polling runs.

## Status and controls

`/status` reads the live local model, provider, reasoning, directory, permissions, loaded AGENTS.md files, account metadata, collaboration mode and session identity. It shows cached quota **remaining**; it never triggers an account request. `D` expands local diagnostic details. Credential presence is not a claim of online validity.

`1`/`2` or left/right arrows switch Usage tabs, `R` refreshes Account, up/down arrows scroll, and Esc closes. The panel uses the editor area, with the footer underneath, and restores editor input on close.

RPC command output uses `extension_ui_request` notifications. Other noninteractive CLI modes use stderr, keeping protocol stdout clear. SDK embedders can use `PlanUsageController`, `scanUsageOverview`, `collectSessionUsage` and the exported presentation types; a custom command host supplies its own presenter/output sink.

## Implementation boundaries

The existing `core/usage-totals.ts` owns entry selection and token validation for session statistics, Account and Overview. `AgentSession.getSessionStats()`, the cost breakdown and Account also share its accumulator; Overview groups validated increments by date and original project after deduplication. Account's complete input includes cache reads/writes; the existing session-stat input retains its provider convention and reports caches separately. Invalid token increments are skipped consistently, while absent/invalid cost does not discard otherwise valid tokens. No second session ledger is maintained.

`step/usage/recording.ts` records activity through existing extension hooks and custom session entries. `commands.ts` owns command parsing and presentation lifecycle; `apps/cli` supplies the presenter and output sink. The bounded historical scanner/cache stays in the product layer because the ordinary session loader materializes complete messages and migrates legacy data. Fork/export hooks preserve origins when parent files disappear; removing those hooks would lose attribution. They do not change model context or dispatch behavior.

## Release verification

Node packages emit `activity-worker.js` beside the chunk that creates it. Bun standalone builds explicitly embed `activity-worker.ts`; release archives still need the existing theme/assets. Test workers from a directory outside the checkout.

The backend must provide schema 1 at `GET /step_plan/v1/usage` before Account is available. A 404 explains that the endpoint is not deployed. Overview and Status remain local. Platform bill amounts, organization Credit and cross-device activity history are outside this feature.
