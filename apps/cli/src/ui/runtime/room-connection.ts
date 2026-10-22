/**
 * `/room`: put this session and another person's session in one Feishu group.
 *
 * The command owns the whole lifecycle for one room: reuse or create this person's own room bot,
 * publish a short code, wait for the other terminal to claim it, create the group, and bind it to
 * this session. Inbound messages are arbitrated by `@step-harness/step-room`, which decides whether
 * this agent speaks; this file only moves text and wires events.
 */

import { randomUUID } from "node:crypto";
import type {
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	MessageEndEvent,
} from "@step-harness/coding-agent";
import { BotIdentityError, LarkApi, type LarkCredentials } from "@step-harness/lark-adapter";
import type { TextContent } from "@step-harness/providers";
import {
	decideRoomTurn,
	parseRoomCommand,
	type RoomAgentRecord,
	RoomAgentStore,
	RoomBindingStore,
	RoomCodeBook,
} from "@step-harness/step-room";
import { describeFailure, newRoomSecret, type RoomPeerRecord, RoomRendezvousClient } from "./room-rendezvous.ts";

/** How often the waiting side asks the rendezvous service whether anyone joined. */
const POLL_INTERVAL_MS = 2_000;
const MAX_PEER_TURNS = 4;
const ROOM_TOOL = "room_send";

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
		/** `undefined` when the tenant cannot read members; never conflated with an empty listing. */
		listChatMembers(
			chatId: string,
		): Promise<readonly { openId: string; memberType: "user" | "bot" | "unknown" }[] | undefined>;
		close(): Promise<void>;
	};
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

export interface RoomExtensionOptions {
	/** Where the bot record lives; injected so tests never touch the user's home. */
	recordDirectory: string;
	/** Turn a fresh authorization into credentials. Absent means the room command stays off. */
	authorize?: (
		context: ExtensionContext,
	) => Promise<{ credentials: LarkCredentials; ownerOpenId: string } | undefined>;
	/** Build the live transport from credentials. Absent in tests that supply no platform. */
	transport?: (
		credentials: LarkCredentials,
		onMessage: (message: RoomInbound) => void,
		onBotAdded: (chatId: string) => void,
	) => RoomTransport;
	/** Rendezvous client; defaults to the trial deployment. */
	rendezvous?: RoomRendezvousClient;
	/** Title for the group. */
	roomName?: (selfName: string, peerName: string | undefined) => string;
}

interface ActiveRoom {
	roomId: string;
	code: string;
	secret: string;
	chatId: string;
	appId: string;
	/** The person who started the room; they own the group. */
	ownerOpenId: string;
	botOpenId: string;
	botName: string;
	transport: RoomTransport;
	/** `openId` is the peer's bot; `userOpenId` is the peer himself, and he must be in the group. */
	peer?: { appId: string; openId: string; userOpenId: string; name?: string };
	lastSpoken?: string;
	polling?: NodeJS.Timeout;
}

export function createRoomExtension(options: RoomExtensionOptions): ExtensionFactory {
	const store = new RoomAgentStore({ directory: options.recordDirectory });
	const rendezvous = options.rendezvous ?? new RoomRendezvousClient();
	return (pi) => {
		let room: ActiveRoom | undefined;
		let codes: RoomCodeBook | undefined;
		let bindings: RoomBindingStore | undefined;
		let peerTurns = 0;

		const title = (self: string, peer: string | undefined) =>
			options.roomName?.(self, peer) ?? (peer ? `chat with ${peer}` : `room-${room?.roomId.slice(0, 8) ?? "new"}`);

		const stop = async (notify: boolean, context?: ExtensionCommandContext) => {
			const current = room;
			room = undefined;
			peerTurns = 0;
			if (!current) {
				if (notify) context?.ui.notify("room · 当前不在会议室", "info");
				return;
			}
			if (current.polling) clearInterval(current.polling);
			current.transport.close();
			await current.transport.api.close().catch(() => undefined);
			if (current.secret) await rendezvous.retire(current.code, current.secret).catch(() => undefined);
			codes?.revoke(current.roomId);
			bindings = undefined;
			if (notify) context?.ui.notify("room · 已离开会议室", "info");
		};

		/** Speak into the room; hand the turn to the peer only when the trigger came from a bot. */
		const speak = async (text: string, handOffTo: string | undefined) => {
			const current = room;
			if (!current?.chatId) return;
			const body = handOffTo ? `<at user_id="${handOffTo}"></at> ${text}` : text;
			try {
				current.lastSpoken = await current.transport.api.sendCard(current.chatId, card(body));
			} catch {
				// The room is a projection of the session, never its source of truth.
			}
		};

		const handleInbound = (message: RoomInbound) => {
			const current = room;
			if (!current || !bindings) return;
			if (bindings.resolve(message.chatId).action === "drop") {
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
			// this session's own permission policy still governs whatever it asks for.
			const content: TextContent[] = [
				{
					type: "text",
					text: `[room · ${message.senderType ?? "unknown"} · ${message.senderOpenId ?? "unknown"}] ${message.text}`,
				},
			];
			pi.sendUserMessage(content, { deliverAs: "followUp", expandPromptTemplates: false });
		};

		/**
		 * The one bot this person keeps for rooms.
		 *
		 * A saved bot is reused on every run and only replaced when the platform says its credentials
		 * no longer work. Any other failure — an unreachable platform, a timeout — leaves the record
		 * untouched: asking someone to re-authorize because their connection blinked is how a "fixed"
		 * bot quietly turns into a new app on every flaky day.
		 */
		const ensureRecord = async (context: ExtensionCommandContext): Promise<RoomAgentRecord | undefined> => {
			const existing = await store.read();
			if (existing.status === "found") {
				const probe = new LarkApi(credentialsOf(existing.record));
				try {
					const identity = await probe.getBotIdentity();
					return { ...existing.record, botOpenId: identity.openId, botName: identity.name };
				} catch (error) {
					const code = error instanceof BotIdentityError ? error.code : "unreachable";
					// Only a refusal by the platform proves the credentials are dead.
					if (code === "unreachable") {
						context.ui.notify("room · 连不上飞书，稍后重试 /room（本机机器人凭证未改动）", "warning");
						return undefined;
					}
					context.ui.notify("room · 已保存的机器人不可用（可能已被删除或重置），需要重新授权", "warning");
				} finally {
					await probe.close().catch(() => undefined);
				}
			} else if (existing.status === "invalid") {
				context.ui.notify(`room · 机器人凭证文件不可用（${existing.reason}），需要重新授权`, "warning");
			}
			if (!options.authorize) {
				context.ui.notify("room · 尚未接入机器人授权，无法发起房间", "warning");
				return undefined;
			}
			const authorized = await options.authorize(context);
			if (!authorized) {
				context.ui.notify("room · 授权未完成", "warning");
				return undefined;
			}
			const { credentials, ownerOpenId } = authorized;
			const probe = new LarkApi(credentials);
			try {
				const identity = await probe.getBotIdentity();
				const record: RoomAgentRecord = {
					appId: credentials.appId,
					appSecret: credentials.appSecret,
					botOpenId: identity.openId,
					botName: identity.name,
					ownerOpenId,
					brand: credentials.brand,
					createdAt: new Date().toISOString(),
				};
				await store.write(record);
				return record;
			} catch {
				context.ui.notify("room · 机器人身份校验失败，请重试授权", "warning");
				return undefined;
			} finally {
				await probe.close().catch(() => undefined);
			}
		};

		const connect = async (
			record: RoomAgentRecord,
			context: ExtensionCommandContext,
		): Promise<RoomTransport | undefined> => {
			if (!options.transport) {
				context.ui.notify("room · 传输层未配置", "warning");
				return undefined;
			}
			const transport = options.transport(credentialsOf(record), handleInbound, (chatId) =>
				adoptChat(chatId, context),
			);
			try {
				await transport.start();
				return transport;
			} catch {
				transport.close();
				context.ui.notify("room · 连接飞书失败：请确认应用已发布，并已开启长连接事件订阅", "warning");
				return undefined;
			}
		};

		/** Start side: show a code, publish it, then wait for the newcomer. */
		const startRoom = async (context: ExtensionCommandContext) => {
			const record = await ensureRecord(context);
			if (!record) return;
			const transport = await connect(record, context);
			if (!transport) return;

			const self = await transport.identity();
			const roomId = randomUUID();
			codes = new RoomCodeBook();
			const code = codes.issue(roomId, 8);
			const secret = newRoomSecret();
			const published = await rendezvous.publish(code, secret);
			if (!published.ok) {
				transport.close();
				await transport.api.close().catch(() => undefined);
				context.ui.notify(`room · ${describeFailure(published.failure)}`, "warning");
				return;
			}

			room = {
				roomId,
				code,
				secret,
				chatId: "",
				appId: record.appId,
				ownerOpenId: record.ownerOpenId,
				botOpenId: self.openId,
				botName: self.name,
				transport,
			};
			context.ui.notify(`room · @${self.name} · 房间码 ${code} · 2 分钟内有效，念给对方`, "info");

			room.polling = setInterval(() => {
				void pollForPeer(context);
			}, POLL_INTERVAL_MS);
		};

		const pollForPeer = async (context: ExtensionCommandContext) => {
			const current = room;
			if (!current || current.chatId || !current.secret) return;
			const result = await rendezvous.status(current.code, current.secret);
			if (!result.ok) {
				if (result.failure.kind === "not-found" || result.failure.kind === "throttled") {
					if (current.polling) clearInterval(current.polling);
					current.polling = undefined;
					context.ui.notify(`room · ${describeFailure(result.failure)}，请重新 /room`, "warning");
				}
				return;
			}
			if (!result.value.claimed || !result.value.peer) return;
			if (current.polling) clearInterval(current.polling);
			current.polling = undefined;
			await createGroup(context, result.value);
		};

		/**
		 * Confirm the invite landed.
		 *
		 * `undefined` means the tenant cannot read members at all — the launcher template grants no
		 * chat-read scope, so this is the normal case and proves nothing. Only a listing we actually
		 * received may be read as evidence that the peer's bot is missing.
		 */
		const verifyMembers = async (current: ActiveRoom, context: ExtensionCommandContext) => {
			const members = await current.transport.api.listChatMembers(current.chatId);
			if (!members) return;
			const hasPeerBot = members.some(
				(member) => member.memberType === "bot" && member.openId !== current.botOpenId,
			);
			if (!hasPeerBot) {
				context.ui.notify("room · 群已建好，但对方机器人没进群，请在飞书里手动拉一次", "warning");
			}
		};

		const createGroup = async (context: ExtensionCommandContext, record: RoomPeerRecord) => {
			const current = room;
			const peer = record.peer;
			if (!current || !peer) return;
			current.peer = {
				appId: peer.appId,
				openId: peer.openId,
				userOpenId: peer.userOpenId,
				...(peer.name ? { name: peer.name } : {}),
			};
			let chatId: string;
			try {
				chatId = await current.transport.createChat({
					name: title(current.botName, peer.name),
					// Only the starter's own open id is usable here: the peer's open id is scoped to the
					// peer's app, so passing it back fails with "open_id cross app". Their bot is added by
					// app id instead, which is tenant-wide, and it brings the conversation to them.
					userOpenIds: [current.ownerOpenId],
					botIds: [current.appId, peer.appId],
					ownerOpenId: current.ownerOpenId,
					dedupeKey: current.roomId,
				});
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				context.ui.notify(`room · 建群失败：${detail}`, "warning");
				return;
			}
			current.chatId = chatId;
			bindings = new RoomBindingStore();
			bindings.bind(chatId, context.sessionManager.getSessionId());
			await verifyMembers(current, context);
			await rendezvous.retire(current.code, current.secret).catch(() => undefined);
			context.ui.notify(`room · 群已就绪 · 在群里 @${current.botName} 开始`, "info");
		};

		/** Joining side: publish this bot's identity onto the code the other person read out. */
		const joinRoom = async (code: string, context: ExtensionCommandContext) => {
			if (!/^\d{6,12}$/.test(code)) {
				context.ui.notify("room · 房间码应为 6-12 位数字", "warning");
				return;
			}
			const record = await ensureRecord(context);
			if (!record) return;
			const transport = await connect(record, context);
			if (!transport) return;
			const self = await transport.identity();

			const claimed = await rendezvous.claim(code, {
				appId: record.appId,
				openId: record.botOpenId,
				userOpenId: record.ownerOpenId,
				name: self.name,
			});
			if (!claimed.ok) {
				transport.close();
				await transport.api.close().catch(() => undefined);
				context.ui.notify(`room · ${describeFailure(claimed.failure)}`, "warning");
				return;
			}
			room = {
				roomId: code,
				code,
				secret: "",
				chatId: "",
				appId: record.appId,
				ownerOpenId: record.ownerOpenId,
				botOpenId: self.openId,
				botName: self.name,
				transport,
			};
			context.ui.notify("room · 已登记，等待对方建群后把你拉进群（进群后即可对话）", "info");
		};

		/**
		 * The joining side learns its group id only by being added to it: Feishu reports that through
		 * the bot-added event, and that is the moment this session can start receiving room messages.
		 */
		const adoptChat = (chatId: string, context: ExtensionContext) => {
			const current = room;
			if (!current) return;
			if (current.chatId && current.chatId !== chatId) return;
			current.chatId = chatId;
			if (!bindings) {
				bindings = new RoomBindingStore();
				bindings.bind(chatId, context.sessionManager.getSessionId());
			}
		};

		pi.registerCommand("room", {
			description: "Start or join a room with another person's agent; /room leave to stop",
			handler: async (args, context) => {
				if (context.mode !== "tui") {
					context.ui.notify("room · 需要交互式终端", "warning");
					return;
				}
				const action = parseRoomCommand(args);
				if (action.kind === "leave") {
					await stop(true, context);
					return;
				}
				if (action.kind === "invalid") {
					context.ui.notify("room · 用法：/room、/room join <房间码>、/room leave", "warning");
					return;
				}
				if (room) {
					context.ui.notify("room · 已在会议室中，先 /room leave", "warning");
					return;
				}
				if (action.kind === "join") await joinRoom(action.code, context);
				else await startRoom(context);
			},
		});

		pi.on("session_shutdown", () => {
			void stop(false);
		});

		// Assistant output reaches the room through the existing message stream, not a second loop.
		pi.on("message_end", (event: Pick<MessageEndEvent, "message">) => {
			if (!room || event.message.role !== "assistant") return;
			const text = event.message.content
				.filter((part): part is TextContent => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();
			if (!text || text === room.lastSpoken) return;
			void speak(text, undefined);
		});

		/**
		 * The only sanctioned way for this session to move data out of its machine: a short
		 * conclusion, optionally addressed to the peer bot. A repository's contents cannot leave
		 * through the room because they never leave the machine.
		 */
		pi.registerTool({
			name: ROOM_TOOL,
			label: "Room message",
			description:
				"Send a short conclusion to the room. Use it when the human asks you to share something with the other person's agent. Say only what the other side cannot see on its own; never pass file contents or secrets.",
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
				const target = args.handOff ? current.peer?.openId : undefined;
				void speak(summary, target || undefined);
				return { ok: true };
			},
		} as never);
	};
}

function credentialsOf(record: RoomAgentRecord): LarkCredentials {
	return { appId: record.appId, appSecret: record.appSecret, brand: record.brand };
}

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
