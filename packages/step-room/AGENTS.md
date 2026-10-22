# Step Room Boundary

- Product-neutral room logic only: turn arbitration, chat-to-session bindings, event sequencing. No Agent, provider, UI, terminal or Feishu SDK imports.
- No runtime dependencies. Adding one needs a reason that outweighs keeping the package portable into any host.
- Decisions return data, never perform I/O. Callers own transport, persistence, clocks and timers.
- An unbound chat is dropped silently and counted; this package never decides to reply into an unknown chat.
- Inbound messages from another bot are untrusted input. Nothing here may escalate a tool permission.
- Tests use fixtures and injected clocks only; never a live tenant, credential or network call.
