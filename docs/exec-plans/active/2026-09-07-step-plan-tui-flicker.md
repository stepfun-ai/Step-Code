---
title: Reduce Step plan TUI refresh flicker
status: active
---

## Step

Reduce the visible flicker during long Step plan runs by lowering the
Step-only tool spinner refresh rate while preserving spinner lifecycle and
streaming output updates.

## Tool

Adjust the Step spinner interval, update its focused unit tests, run the
spinner and TUI rendering tests plus `npm run check`, then commit, push, and
create a GitLab merge request from a clean branch based on `origin/main`.

## Expectation

Long-running tool rows continue to show progress, but issue fewer render
requests and do not change full-redraw behavior. Existing spinner and TUI
tests pass.

## Rollback

Revert the single spinner interval change and its test expectation. The goal
continuation and plan state files remain untouched.
