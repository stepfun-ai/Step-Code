# packages/lark-adapter

Inherits the [root rules](../../AGENTS.md). This package is `@step-harness/lark-adapter`, the external Feishu/Lark protocol boundary used by `apps/cli`. See [lark-boundary.md](lark-boundary.md) and [Lark connection](../../docs/lark-connection.md).

## Boundaries and invariants

- External Feishu/Lark protocol and SDK only. No internal runtime, session, tool or UI imports.
- Credentials remain in memory. SDK diagnostics are silent; never log raw SDK errors or payloads.
- One socket per connection. Close forcefully and idempotently; late callbacks cannot reach the host.
- Chat binding and decision tokens are input state, not a session or transcript store.

## Validation

- Run `pnpm exec vitest --run` from this directory. Tests use offline protocol and SDK fixtures, never live credentials or network services.
