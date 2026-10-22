/**
 * Live Feishu wiring for `/room`.
 *
 * Two adapters, nothing else: authorization turns this person's browser consent into a room bot's
 * credentials, and the transport wraps `LarkTransport` + `LarkApi` behind the small `RoomTransport`
 * surface the command uses. Keeping them here means the command stays testable without a tenant.
 */

import type { ExtensionContext } from "@step-harness/coding-agent";
import { LarkApi, type LarkCredentials, LarkRegistration, LarkTransport } from "@step-harness/lark-adapter";
import type { RoomInbound, RoomTransport } from "./room-connection.ts";

/** Device-code consent: the person scans a QR, the credentials arrive in memory and nowhere else. */
export async function authorizeRoomBot(
	context: ExtensionContext,
): Promise<{ credentials: LarkCredentials; ownerOpenId: string } | undefined> {
	const controller = new AbortController();
	const registration = new LarkRegistration({ version: "room" });
	try {
		const code = await registration.begin(controller.signal);
		context.ui.notify(`room · 扫码或打开链接创建机器人：${code.verificationUrl}`, "info");
		const result = await registration.waitForAuthorization(code, controller.signal);
		if (result.status !== "authorized") {
			context.ui.notify(
				result.status === "expired" ? "room · 授权已过期，请重试 /room" : "room · 授权被拒绝",
				"warning",
			);
			return undefined;
		}
		// The consenting person, not their bot, owns the room's group. Without their open id the group
		// would have to be owned by a machine, which Feishu does not allow for a private group.
		const ownerOpenId = result.userInfo?.openId;
		if (!ownerOpenId) {
			context.ui.notify("room · 授权未返回你的身份，无法建群", "warning");
			return undefined;
		}
		return { credentials: result.credentials, ownerOpenId };
	} catch {
		context.ui.notify("room · 授权过程失败，请重试 /room", "warning");
		return undefined;
	}
}

/**
 * Build the live transport. The group is always created by app identity with an explicit bot list,
 * which is why this adapter exposes the creation call the command expects rather than re-deriving it.
 */
export function liveRoomTransport(
	credentials: LarkCredentials,
	onMessage: (message: RoomInbound) => void,
	onBotAdded?: (chatId: string) => void,
): RoomTransport {
	const api = new LarkApi(credentials);
	let transport: LarkTransport | undefined;
	let botId = "";
	return {
		async start() {
			const identity = await api.getBotIdentity();
			botId = identity.openId;
			transport = new LarkTransport({
				credentials,
				botId,
				onMessage: (message) => {
					onMessage({
						chatId: message.chatId,
						messageId: message.id,
						createdAt: message.createdAt,
						text: message.text,
						...(message.senderType ? { senderType: message.senderType } : {}),
						...(message.senderOpenId ? { senderOpenId: message.senderOpenId } : {}),
						mentions: message.mentions,
					});
				},
				onCardAction: () => undefined,
				onState: () => undefined,
				...(onBotAdded ? { onBotAdded } : {}),
			});
			await transport.start();
		},
		close() {
			transport?.close();
		},
		async identity() {
			const identity = await api.getBotIdentity();
			botId = identity.openId;
			return identity;
		},
		createChat(input) {
			return api.createChat({
				name: input.name,
				userOpenIds: input.userOpenIds,
				botIds: input.botIds,
				...(input.ownerOpenId ? { ownerOpenId: input.ownerOpenId } : {}),
				dedupeKey: input.dedupeKey,
			});
		},
		api: {
			sendText: (chatId, text, replyTo) => api.sendText(chatId, text, replyTo),
			sendCard: (chatId, card, replyTo) => api.sendCard(chatId, card, replyTo),
			updateCard: (messageId, card) => api.updateCard(messageId, card),
			listChatMembers: (chatId) => api.listChatMembers(chatId),
			close: () => api.close(),
		},
	};
}
