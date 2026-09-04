# Loop, Cron, and Workflow MR execution plan

## Step

Finish the third, Workflow-focused merge request on top of `origin/main`. Add a
feature-gated isolated-vm workflow runtime with a small JavaScript DSL, durable
journaling/resume, bounded budget/concurrency, role tool profiles and path ACLs,
progress reporting, and the built-in HoH iterate pattern. Keep the three
directions independent: Loop and Cron are separate schedulers, and HoH is a
workflow pattern rather than a fourth scheduling layer.

## Tool

- Inspect the existing extension, subagent, telemetry, and session APIs.
- Add the exact `isolated-vm` dependency and refresh the package lock.
- Implement and test the workflow modules and wire the extension into the Step
  capability composition behind `STEP_ENABLE_WORKFLOW` (default off).
- Run targeted Vitest/Biome checks and the repository check command, then push a
  dedicated branch and create MR !23.

## Expectation

Inline and saved scripts execute through the isolated VM; parallel/pipeline
barriers, schema validation, resume journal, budget/concurrency limits, ACLs,
progress output, and HoH evidence carry-over have deterministic tests. A build
without the native dependency does not register the workflow tool, and existing
Step capabilities remain unchanged when the flag is off.

## Rollback

Revert the Workflow commit/MR or remove its capability registration and the
feature flag. Do not delete user workflow runs or journals; they are inert when
the extension is disabled and can be read by a later version.
