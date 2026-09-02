---
title: Feedback context identity boundaries
status: superseded
---

本计划已并入
`2026-09-01-feedback-migration-and-protocol-alignment.md` 的“后续边界审计与修复（2026-09-02）”小节。保留本文件作为执行记录索引，不再单独推进。

## Scope

Defend feedback envelope `uid` and `sessionId` when they arrive from a host,
stored credential, or command dependency rather than from the normal producer
validation path.

| Step | Tool | Expectation | Rollback |
| --- | --- | --- | --- |
| Inspect existing identity contracts | `context.ts`, `session-manager.ts`, Step CLI contract | Reuse the UID character/length boundary and session-id validator | No changes if the contracts already apply at the feedback boundary |
| Add a single normalization guard | `feedback/context.ts` | Invalid identity values are omitted; valid values are unchanged | Revert the guard only |
| Add focused regressions | `test/feedback-context.test.ts` | Control, path, overlong, and valid identity cases are covered | Remove the new test file |
| Verify | package-local focused Vitest, `npm run check` | Tests and repository checks pass | Revert only this plan's files |
