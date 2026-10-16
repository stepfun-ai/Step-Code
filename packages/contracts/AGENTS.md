# packages/contracts

Inherits the [root rules](../../AGENTS.md). This package is `@step-harness/contracts`; it provides independent host contracts and wire framing.

## Responsibilities and entry points

- `src/in-process/index.ts`: default package entry point. `agent-product.ts` and `session-handle.ts`: product capabilities, session driving, events, and approval types.
- `src/in-process/session-record.ts` and `host-event.ts`: record visibility and host events, modeled separately from real-time lifecycle events.
- `src/wire/index.ts`: `@step-harness/contracts/wire` entry point. `events.ts` and `protocol.ts`: wire events, handshake identity, version, and constants.
- `src/wire/frame.ts`: encoding and streaming decoding for uint32 big-endian length-prefixed frames and LF line frames.

## Boundaries and invariants

- Runtime dependencies remain empty. Do not introduce provider SDKs, agent-core, coding-agent, TUI, or concrete host objects.
- Keep contract types self-contained. Represent concrete messages and tool results as `unknown` at the boundary and validate them in consumers; do not bind to product internals through deep imports.
- Model product sessions, persistent records, and telemetry separately rather than combine them into an ambiguous event channel.
- This package defines contracts; do not assume every CLI RPC / stdio entry point already consumes them. Verify actual connections against current caller implementations.
- Wire framing handles serialized bytes or single-line text. It does not own JSON / CBOR serialization, process startup, network connections, or approval policies.
- Streaming decoders preserve incomplete trailing frames and return complete frames in order. Line framing rejects payloads containing LF; length framing counts bytes.
- Check both producers and consumers when changing protocols or event shapes. Do not change version constants without considering compatibility.

## Validation and documentation

- Run root `pnpm run check:contracts-deps-empty`; run the full `pnpm run check` after code changes.
- Run `pnpm exec vitest --run test/frame.test.ts` here. Framing changes cover split and combined chunks, empty payloads, and trailing-frame recovery.
- Update consumer SDK / mode documentation when connections change. Explain the relationship between independent contracts and existing RPC protocols explicitly.
