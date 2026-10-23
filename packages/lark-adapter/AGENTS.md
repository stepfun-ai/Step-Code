# Lark Adapter Boundary

- External Feishu/Lark protocol and SDK only. No internal runtime, session, tool or UI imports.
- Credentials remain in memory. SDK diagnostics are silent; never log raw SDK errors or payloads.
- One socket per connection. Close forcefully and idempotently; late callbacks cannot reach the host.
- Tests use offline protocol and SDK fixtures, never live credentials or network services.
- Chat binding and decision tokens are input state, not a session or transcript store.
