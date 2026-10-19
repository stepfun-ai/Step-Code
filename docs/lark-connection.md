# Current-Session Lark Connection

In interactive terminal mode, `/connect lark` starts an in-memory pairing attempt.
Open the displayed link and authorize the personal agent. `/connect off` cancels
pairing or disconnects. The first valid message binds one chat to the current
session; group messages require a bot mention. Duplicate, stale and bot messages
are filtered by the adapter. There is no history backfill or background daemon.

Pairing shows a terminal QR and the complete verification link, with the user code
and server-provided lifetime. Narrow or short terminals show the link without
clipping the QR. After the WebSocket handshake succeeds, a separate notification
shows `connect · lark · connected · @<bot name> · <session ID>`. This confirms the
transport connection, not callback configuration or the first-message chat binding.
Disconnect discards local credentials; it does not revoke the app on the platform.

Text and attachments use the existing session user-message action as follow-ups,
with remote slash-command execution disabled. Downloads are limited to 20 MiB per
resource and eight attachments per message, with at most sixteen pending inbound
deliveries. Files live in private temporary directories removed on disconnect.
Credentials stay in memory and SDK diagnostics are not logged.

The composer footer below the input shows `lark · connected · @<bot name> · <session ID>`
on a separate row above the Ask/model/effort/workspace row, without repeating it
on the bottom row. Transport state changes update this indicator; disconnect
removes it. Narrow terminals truncate the bot name before hiding connection state.
Inbound messages do not receive receipt reactions; feedback is shown in reply
cards. `/connect off` (or `/connect lark off`)
clears the footer and confirms `connect · lark · disconnected`.
Explicit off commands also attempt a disconnect notification card in the bound
chat before closing REST resources. Delivery failure does not prevent cleanup;
unbound pairing and session shutdown do not send this notice.

Pairing polling handles normal pending, slow-down, denied and expired outcomes
even when returned with HTTP 400. Failed connections report a static stage
(pairing initialization, authorization polling, bot identity lookup or WebSocket
handshake), never a raw response or SDK error. Creating the personal agent in the
browser does not confirm connection; wait for the terminal's paired notification.

After connecting, the terminal shows a prefilled callback setup link using the
official CLI launcher addons contract. Open it and confirm `card.action.trigger`
while the terminal remains connected. This is user-confirmed configuration, not
silent provisioning; registration alone does not guarantee remote approvals.
The link contains the application ID and callback name, never credentials.
If the launcher does not support the personal agent, use the application's
Events & Callbacks > Callback Configuration page to select long-connection
delivery and add the new `card.action.trigger` callback (not the legacy version).
Follow the platform's publishing requirements before testing a fresh approval.

Assistant text and tool-name activity update an ephemeral card. Completion waits
for `agent_settled`, not `agent_end`, so retry and automatic compaction do not mark
an unfinished run complete. No second agent loop or persistent transcript is used.
Output cards include the current model and effort. Terminal model and thinking
level selections update the current card, including after the turn has settled;
before the first output card, settings appear when the next turn begins. These
are read-only projections of the existing session, not remote configuration.

Tool confirmations can be answered in the terminal or the bound Lark chat. The
first legal choice wins. Completion, cancellation and teardown revoke card tokens;
disconnect leaves an unresolved terminal dialog available. Login, text input,
editors and arbitrary custom components remain terminal-only. Large decision
content is not truncated into an approval card; review it in the terminal instead.

## Current Limits

Ordinary inbound messages received during a blocking terminal dialog or compaction
are rejected with a terminal warning; compaction-deferred delivery is not yet
implemented. Tool results and thinking content are not projected. Output cards
currently retain only the latest assistant text, not every message in a multi-tool
run. Session replacement, reload and quit use `session_shutdown` for disconnect.

Offline tests cover protocol filtering, SDK cleanup, REST requests, bounded
downloads, pairing cancellation, session shutdown and first-wins decisions.
A live Lark handshake, interactive dual-screen acceptance and binary build have
not yet been verified. This feature remains work in progress.
