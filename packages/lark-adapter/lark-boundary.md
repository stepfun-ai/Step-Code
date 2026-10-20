# Lark Adapter

This package owns the external Feishu/Lark protocol boundary. It has no internal
workspace dependencies and does not own an agent, permission policy or transcript.

## Registration

Create one `LarkRegistration` per pairing attempt. `begin(signal)` returns the
verification URL and device code. `waitForAuthorization(code, signal)` polls at
the supplied interval, adds five seconds after slow-down and stops at expiry or
cancellation. Keep returned credentials in memory only.

## Transport

`LarkTransport` requires credentials and the bot's verified open ID. Its host
supplies message, card-action and health callbacks. `start()` resolves only after
`onReady` confirms the initial handshake, not when the SDK's `start()` returns.
An initial error, a 15-second startup deadline or `close()` rejects startup and
forcefully closes the socket; the host can retry with a new transport. After a
successful handshake, health errors report degraded state without closing it.
The first valid input binds the chat. Group inputs require a bot mention. Card actions must carry the
bound chat ID, token and option; the host must additionally validate the token
against `LarkDecisions` and the current UI request.

`close()` forcefully closes the socket, clears routing state and suppresses late
callbacks. A transport cannot restart. SDK logs are silent because SDK errors may
contain credentials and stdout belongs to the terminal renderer.

The SDK is pinned to 1.76.0. Version 1.51.0, used in the reference manifest, lacks
the public close and health callback APIs required for safe teardown. No private
SDK fields or compatibility casts are used.

## Current Limits

Messages must be at most ten minutes old, with at most 30 seconds of future clock
skew. Accepted message IDs remain deduplicated through their timestamp's entire
ten-minute eligibility window (including its inclusive endpoint). The gate holds
at most 4096 live IDs and rejects new messages at capacity rather than evicting
IDs that could still be redelivered. Expired entries are released on valid input.

`LarkApi` discovers the bot identity, sends/updates cards and downloads attachment
resources with cancellation and a streaming 20 MiB limit. Private temporary files
are removed on close. Message callbacks contain references; the CLI chooses when
to download them and routes accepted content through the existing session action.

`LarkDecisions` owns random, chat-scoped card tokens, not permission policy or UI
requests. The host revokes each token when its typed UI decision closes. CLI
composition is documented in [Lark connection](../../docs/lark-connection.md).
Tests are offline, including a real SDK pre-start cleanup test; no live handshake
has been verified.
