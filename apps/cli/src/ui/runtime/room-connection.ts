/**
 * `/room`: put this session and another person's session in one Feishu group.
 *
 * The command owns the whole lifecycle for one room: discover or create this person's own room
 * bot, publish a short code, accept a newcomer, create the group, and bind it to this session.
 * Inbound messages are arbitrated by `@step-harness/step-room`, which decides whether this agent
 * speaks; this file only moves text and wires events.
 */

import { randomUUID } from "node:crypto";
import type {
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	MessageEndEvent,
} from "@step-harness/coding-agent";
import { LarkApi, type LarkCredentials } from "@step-harness/lark-adapter";
import type { TextContent } from "@step-harness/providers";
import { decideRoomTurn, RoomAgentStore, RoomBindingStore, RoomCodeBook } from "@step-harness/step-room";

/** What the product needs from the platform; kept small so a test can stand in for it. */
export interface RoomTransport {
	/** Start listening. Resolves once the platform confirms the connection. */
	start(): Promise<void>;
	close(): void;
	/** This bot's own open id and display name. */
	identity(): Promise<{ openId: string; name: string }>;
	/** Create the group with this bot already inside. Returns the chat id. */
	createChat(input: {
		name: string;
		userOpenIds: readonly string[];
		botIds: readonly string[];
		ownerOpenId?: string;
		dedupeKey: string;
	}): Promise<string>;
	/** Provider-side conversation used for every room message in this session. */
	api: {
		sendText(chatId: string, text: string, replyTo?: string): Promise<string>;
		sendCard(chatId: string, card: Record<string, unknown>, replyTo?: string): Promise<string>;
		updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
		close(): Promise<void>;
	};
}

export interface RoomExtensionOptions {
	/** Where the bot record lives; injected so tests never touch the user's home. */
	recordDirectory: string;
	/** Turn a fresh authorization into credentials. Absent means the room command stays off. */
	authorize?: (context: ExtensionContext) => Promise<LarkCredentials | undefined>;
	/** Build the live transport from credentials. Absent in tests that supply no platform. */
	transport?: (credentials: LarkCredentials, onMessage: (message: RoomInbound) => void) => RoomTransport;
	/** Home of the newcomer's bot, learned out of band through the rendezvous. */
	roomName?: (selfName: string) => string;
}

export interface RoomInbound {
	chatId: string;
	messageId: string;
	createdAt: number;
	senderType?: string;
	senderOpenId?: string;
	text: string;
	mentions: readonly { mentionedType?: string; openId?: string }[];
}

interface ActiveRoom {
	roomId: string;
	chatId: string;
	botOpenId: string;
	botName: string;
	transport: RoomTransport;
	code?: string;
	pendingJoin?: { peerBotId: string; peerOpenId: string; peerName: string; peerAppId?: string };
	lastSpokenMessage?: string;
}

const MAX_PEER_TURNS = 4;
const MONITOR_TOOL = "room_monitor";

/** Card shape kept minimal: one markdown block plus an optional setting line. */
function card(text: string, subtitle?: string): Record<string, unknown> {
	return {
		config: { wide_screen_mode: true, enable_forward: false },
		elements: [
			...(subtitle ? [{ tag: "div", text: { tag: "plain_text", content: subtitle } }] : []),
			{ tag: "div", text: { tag: "lark_md", content: text } },
		],
	};
}

export function createRoomExtension(options: RoomExtensionOptions): ExtensionFactory {
	const store = new RoomAgentStore({ directory: options.recordDirectory });
	return (pi) => {
		let room: ActiveRoom | undefined;
		let codes: RoomCodeBook | undefined;
		let bindings: RoomBindingStore | undefined;
		let peerTurns = 0;

		const stop = (notify = true, context?: ExtensionCommandContext) => {
			room?.code && codes?.revoke(room.roomId);
			room?.transport.close();
			void room?.transport.api.close();
			room = undefined;
			peerTurns = 0;
			if (notify) context?.ui.notify("room · 已离开会议室", "info");
		};

		/** Speak into the room and hand the turn to the peer when the last input came from a bot. */
		const speak = async (text: string, handOffTo: string | undefined) => {
			const current = room;
			if (!current) return;
			const body = handOffTo ? `<at user_id="${handOffTo}"></at> ${text}` : text;
			try {
				current.lastSpokenMessage = await current.transport.api.sendCard(current.chatId, card(body));
			} catch {
				// The room is a projection of the session, never its source of truth.
			}
		};

		const handleInbound = (message: RoomInbound, context: ExtensionContext) => {
			const current = room;
			if (!current || !bindings) return;
			const routed = bindings.resolve(message.chatId);
			if (routed.action === "drop") {
				// Unbound chat: nobody in this terminal asked for it, and replying would be noise.
				return;
			}
			const decision = decideRoomTurn(
				{
					id: message.messageId,
					chatId: message.chatId,
					createdAt: message.createdAt,
					...(message.senderType ? { senderType: message.senderType } : {}),
					...(message.senderOpenId ? { senderOpenId: message.senderOpenId } : {}),
					mentions: message.mentions.map((mention) => ({
						...(mention.mentionedType ? { mentionedType: mention.mentionedType } : {}),
						...(mention.openId ? { openId: mention.openId } : {}),
					})),
				},
				{ selfOpenId: current.botOpenId, maxPeerTurns: MAX_PEER_TURNS, peerTurns },
			);
			if (!decision.speak) return;
			peerTurns = decision.addressedBy === "user" ? 0 : peerTurns + 1;
			// A peer bot is untrusted input: it becomes a user message, never a tool instruction, and
			// the session's own permission policy still governs whatever it asks for.
			const content: TextContent[] = [
				{
					type: "text",
					text: `[room · ${message.senderType ?? "unknown"} · ${message.senderOpenId ?? "unknown"}] ${message.text}`,
				},
			];
			pi.sendUserMessage(content, { deliverAs: "followUp", expandPromptTemplates: false });
			void context;
		};

		const startRoom = async (args: string, context: ExtensionCommandContext) => {
			const requestedCode = args.trim();
			if (requestedCode) {
				if (!codes) return context.ui.notify("room · 先执行 /room 发起一个房间", "warning");
				const claim = codes.claim(requestedCode);
				if (claim.status !== "accepted") {
					codes.recordFailure(room?.roomId ?? "");
					return context.ui.notify(`room · 房间码无效（${claim.status}）`, "warning");
				}
				return createRoomFor(claim.roomId, context);
			}
			const roomId = randomUUID();
			codes ??= new RoomCodeBook();
			const code = codes.issue(roomId, 8);
			context.ui.notify(`room · 房间码 ${code} · 2 分钟内有效，让对方面对面念出`, "info");
			await createRoomFor(roomId, context, code);
		};

		const createRoomFor = async (roomId: string, context: ExtensionCommandContext, code?: string) => {
			const existing = await store.read();
			let record = existing.status === "found" ? existing.record : undefined;
			if (existing.status === "invalid") {
				context.ui.notify(`room · 机器人凭证不可用（${existing.reason}），请重新授权`, "warning");
			}
			if (!record) {
				if (!options.authorize) return context.ui.notify("room · 尚未配置机器人授权，无法发起", "warning");
				const credentials = await options.authorize(context);
				if (!credentials) return context.ui.notify("room · 授权未完成", "warning");
				const probe = new LarkApi(credentials);
				try {
					const identity = await probe.getBotIdentity();
					record = {
						appId: credentials.appId,
						appSecret: credentials.appSecret,
						botOpenId: identity.openId,
						botName: identity.name,
						brand: credentials.brand,
						createdAt: new Date().toISOString(),
					};
					await store.write(record);
				} finally {
					await probe.close().catch(() => undefined);
				}
			}
			if (!options.transport) return context.ui.notify("room · 传输层未配置", "warning");
			const transport = options.transport(
				{ appId: record.appId, appSecret: record.appSecret, brand: record.brand },
				(message) => handleInbound(message, context),
			);
			try {
				await transport.start();
			} catch {
				transport.close();
				return context.ui.notify("room · 连接飞书失败，请检查应用是否已发布并开启长连接事件", "warning");
			}
			const self = await transport.identity();
			room = { roomId, chatId: "", botOpenId: self.openId, botName: self.name, transport };
			if (code) room.code = code;
			const name = options.roomName?.(self.name) ?? `room-${roomId.slice(0, 8)}`;
			const owner = await pendingPeer(context);
			if (!owner) {
				context.ui.notify(`room · 已就绪 @${self.name} · 等待对方加入房间码 ${code ?? ""}`, "info");
				return;
			}
			const chatId = await transport.createChat({
				name,
				userOpenIds: [owner.peerOpenId],
				botIds: owner.peerAppId ? [owner.peerAppId] : [],
				ownerOpenId: owner.peerOpenId,
				dedupeKey: roomId,
			});
			room.chatId = chatId;
			bindings = new RoomBindingStore();
			bindings.bind(chatId, context.sessionManager.getSessionId());
			codes?.revoke(roomId);
			context.ui.notify(`room · 群已就绪 · 在群里 @${self.name} 开始对话`, "info");
		};

		/**
		 * The joining side's identity arrives through the rendezvous, which is not part of this
		 * build. Until it exists the room can start listening but cannot create its group; the
		 * command says so instead of pretending the room is ready.
		 */
		const pendingPeer = async (_context: ExtensionCommandContext): Promise<ActiveRoom["pendingJoin"] | undefined> =>
			undefined;

		pi.registerCommand("room", {
			description: "Join or start a room with another person's agent; /room leave to stop",
			handler: async (args, context) => {
				if (context.mode !== "tui") return context.ui.notify("room · 需要交互式终端", "warning");
				const value = args.trim();
				if (value === "leave" || value === "off") {
					stop(true, context);
					return;
				}
				if (room) return context.ui.notify("room · 已在会议室中，先 /room leave", "warning");
				await startRoom(value, context);
			},
		});

		pi.on("session_shutdown", () => stop(false));

		// Assistant output reaches the room through the existing message stream, not a second loop.
		pi.on("message_end", (event: Pick<MessageEndEvent, "message">) => {
			if (!room || event.message.role !== "assistant") return;
			const text = event.message.content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();
			if (!text || text === room.lastSpokenMessage) return;
			void speak(text, undefined);
		});

		/**
		 * The only sanctioned way for this session to move data out of its machine: a short
		 * conclusion, optionally addressed to the peer bot. Arbitrary repository content cannot
		 * leave through the room because it never leaves the machine.
		 */
		pi.registerTool({
			name: MONITOR_TOOL,
			label: "Room message",
			description:
				"Send a short conclusion to the room. Use it when the human asks you to share something with the other person's agent. Keep it to what the other side cannot see on its own; never pass file contents or secrets.",
			parameters: {
				type: "object",
				properties: {
					summary: { type: "string", description: "The conclusion, a few sentences at most." },
					handOff: { type: "boolean", description: "Address the other agent so it continues." },
				},
				required: ["summary"],
			},
			execute: async (args: { summary: string; handOff?: boolean }) => {
				const current = room;
				if (!current) return { ok: false, error: "not in a room" };
				const summary = String(args.summary ?? "").slice(0, 2000);
				const target = current.pendingJoin?.peerOpenId;
				void speak(summary, args.handOff && target ? target : undefined);
				return { ok: true };
			},
		} as never);
	};
}
