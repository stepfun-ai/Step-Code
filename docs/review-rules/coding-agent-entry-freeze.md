# Review rule: coding-agent entry-surface freeze (S0-6)

**Status:** active for the whole refactor (steps 0–7).
**Enforced by:** `scripts/check-coding-agent-entry-freeze.mjs` (in `npm run check`).
**Baseline:** `scripts/__baseline__/coding-agent-bin.json` (captured at `1cfed08`).

## Rule

`packages/coding-agent` must **not grow new process-entry responsibility** during the refactor. Its `bin` keys and `exports` subpaths must stay a **subset** of the baseline snapshot:

- baseline `bin`: `pi`, `step`
- baseline `exports`: `.`, `./rpc-entry`, `./client`

- ✅ Removing a `bin`/`export` is allowed and expected — step 1 deletes `pi`, `./rpc-entry`, `./client`; step 3 moves `step` out to `apps/cli`.
- ❌ Adding a new `bin` key or a new `exports` subpath fails the gate. New entry points (argv parsing, TTY init, a new CLI) belong in `apps/cli`, not here.

## Why

The refactor moves the process entry (argv / TTY / exit codes / extension registration) out of `packages/coding-agent` into `apps/cli`. If new entry points can still be added to `coding-agent` mid-refactor, the boundary we are trying to establish erodes silently. This soft gate lets the surface shrink toward zero while blocking backsliding.

## If this check fails

You (or an agent) added a `bin` or `exports` entry to `packages/coding-agent/package.json`. Move that entry point to `apps/cli` (host layer). If a removal legitimately happened and the baseline is now stale for a *reason unrelated to growth*, the check still passes (subset holds) — the baseline snapshot itself is only updated deliberately, not to accommodate new growth.
