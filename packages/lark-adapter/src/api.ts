import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { LARK_OPEN_HOSTS, type LarkCredentials } from "./registration.ts";

/** In-memory authenticated REST boundary; never forwards SDK diagnostics. */
export class LarkApi {
	private readonly client: Client;
	private readonly controller = new AbortController();
	private readonly downloads = new Set<Promise<{ path: string; size: number }>>();
	private readonly directories = new Set<string>();
	private closing: Promise<void> | undefined;

	constructor(credentials: LarkCredentials) {
		this.client = new Client({
			appId: credentials.appId,
			appSecret: credentials.appSecret,
			domain: LARK_OPEN_HOSTS[credentials.brand],
			logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} },
			loggerLevel: LoggerLevel.error,
		});
	}

	async getBotIdentity(): Promise<{ openId: string; name: string }> {
		try {
			this.controller.signal.throwIfAborted();
			const response = await this.client.request<{ code?: number; bot?: { open_id?: string; app_name?: string } }>({
				url: "/open-apis/bot/v3/info",
				method: "GET",
				signal: this.controller.signal,
				timeout: 15_000,
			});
			this.controller.signal.throwIfAborted();
			if (response.code !== 0 || typeof response.bot?.open_id !== "string" || !response.bot.open_id)
				throw new Error("Invalid bot identity");
			return {
				openId: response.bot.open_id,
				name: typeof response.bot.app_name === "string" ? response.bot.app_name : "bot",
			};
		} catch {
			throw new Error("Lark bot identity request failed");
		}
	}

	/**
	 * Create a group with the caller already inside and every listed bot invited in the same call.
	 * `botIds` are application ids (`cli_…`), not open ids. A natural person owns the group when
	 * `ownerId` is given, which requires a user token.
	 */
	/**
	 * Create a group with the caller already inside and every listed bot invited in the same call.
	 * `botIds` are application ids (`cli_…`), not open ids. `ownerOpenId` names the person who owns
	 * the group; the bot's own credentials may set it when that person is the app's owner.
	 */
	async createChat(options: {
		name: string;
		userOpenIds?: readonly string[];
		botIds?: readonly string[];
		ownerOpenId?: string;
		dedupeKey?: string;
	}): Promise<string> {
		try {
			const response = await this.client.im.chat.create({
				params: {
					user_id_type: "open_id",
					...(options.dedupeKey ? { uuid: options.dedupeKey } : {}),
				},
				data: {
					name: options.name,
					chat_mode: "group",
					chat_type: "private",
					// Confidential mode blocks message reads server-side; a room must never enable it.
					restricted_mode_setting: {
						status: false,
						screenshot_has_permission_setting: "all_members",
						download_has_permission_setting: "all_members",
						message_has_permission_setting: "all_members",
					},
					...(options.ownerOpenId ? { owner_id: options.ownerOpenId } : {}),
					...(options.userOpenIds?.length ? { user_id_list: [...options.userOpenIds] } : {}),
					...(options.botIds?.length ? { bot_id_list: [...options.botIds] } : {}),
				},
			});
			const chatId = response.data?.chat_id;
			if (!chatId) throw new Error("Invalid chat response");
			return chatId;
		} catch {
			throw new Error("Lark chat creation failed");
		}
	}

	/**
	 * Members of a chat, for confirming an invite landed. Needs a chat-read scope the launcher's
	 * default template does not grant, so callers treat a failure as "cannot verify", not "wrong".
	 */
	async listChatMembers(
		chatId: string,
	): Promise<readonly { openId: string; memberType: "user" | "bot" | "unknown"; name: string }[]> {
		try {
			const members: { openId: string; memberType: "user" | "bot" | "unknown"; name: string }[] = [];
			for await (const page of await this.client.im.chatMembers.getWithIterator({
				params: { member_id_type: "open_id", page_size: 100 },
				path: { chat_id: chatId },
			})) {
				for (const item of page?.items ?? []) {
					if (!item?.member_id) continue;
					const type = item.member_id_type;
					members.push({
						openId: item.member_id,
						memberType: type === "user" ? "user" : type === "app" ? "bot" : "unknown",
						name: item.name ?? "",
					});
				}
			}
			return members;
		} catch {
			throw new Error("Lark chat member lookup failed");
		}
	}

	/** Send a plain text message. Mentions use the `<at user_id="ou_…"></at>` form inside `text`. */
	async sendText(chatId: string, text: string, replyTo?: string): Promise<string> {
		try {
			this.controller.signal.throwIfAborted();
			const response = await this.client.request<{ code?: number; data?: { message_id?: string } }>({
				url: replyTo
					? `/open-apis/im/v1/messages/${encodeURIComponent(replyTo)}/reply`
					: "/open-apis/im/v1/messages",
				method: "POST",
				signal: this.controller.signal,
				timeout: 15_000,
				params: replyTo ? undefined : { receive_id_type: "chat_id" },
				data: {
					...(replyTo ? {} : { receive_id: chatId }),
					msg_type: "text",
					content: JSON.stringify({ text }),
				},
			});
			this.controller.signal.throwIfAborted();
			if (response.code !== 0 || typeof response.data?.message_id !== "string" || !response.data.message_id)
				throw new Error("Invalid message response");
			return response.data.message_id;
		} catch {
			throw new Error("Lark message send failed");
		}
	}

	/**
	 * Read chat history newest-last, for filling a gap the event stream reported. Bot identity needs
	 * the group read scope, so failure here is expected on partially provisioned applications.
	 */
	async listMessages(
		chatId: string,
		options: { sinceMs?: number; limit?: number } = {},
	): Promise<
		readonly {
			id: string;
			createdAt: number;
			senderOpenId?: string;
			senderType?: string;
			messageType: string;
			text: string;
		}[]
	> {
		try {
			const messages: {
				id: string;
				createdAt: number;
				senderOpenId?: string;
				senderType?: string;
				messageType: string;
				text: string;
			}[] = [];
			const limit = options.limit ?? 50;
			let pageToken: string | undefined;
			do {
				this.controller.signal.throwIfAborted();
				const response = await this.client.request<{
					code?: number;
					data?: {
						has_more?: boolean;
						page_token?: string;
						items?: {
							message_id?: string;
							create_time?: string;
							msg_type?: string;
							sender?: { id?: string; sender_type?: string };
							body?: { content?: string };
						}[];
					};
				}>({
					url: "/open-apis/im/v1/messages",
					method: "GET",
					signal: this.controller.signal,
					timeout: 15_000,
					params: {
						container_id_type: "chat",
						container_id: chatId,
						sort_type: "ByCreateTimeAsc",
						page_size: Math.min(limit, 50),
						...(options.sinceMs ? { start_time: String(Math.floor(options.sinceMs / 1000)) } : {}),
						...(pageToken ? { page_token: pageToken } : {}),
					},
				});
				this.controller.signal.throwIfAborted();
				if (response.code !== 0) throw new Error("Invalid history response");
				for (const item of response.data?.items ?? []) {
					const id = item.message_id;
					const createdAt = Number(item.create_time);
					if (typeof id !== "string" || !id || !Number.isFinite(createdAt)) continue;
					messages.push({
						id,
						createdAt,
						...(item.sender?.id ? { senderOpenId: item.sender.id } : {}),
						...(item.sender?.sender_type ? { senderType: item.sender.sender_type } : {}),
						messageType: typeof item.msg_type === "string" ? item.msg_type : "unknown",
						text: extractText(item.msg_type, item.body?.content),
					});
					if (messages.length >= limit) break;
				}
				pageToken =
					messages.length < limit && response.data?.has_more === true ? response.data.page_token : undefined;
			} while (pageToken);
			return messages;
		} catch {
			throw new Error("Lark chat history request failed");
		}
	}

	async sendCard(chatId: string, card: Record<string, unknown>, replyTo?: string): Promise<string> {
		try {
			this.controller.signal.throwIfAborted();
			const response = await this.client.request<{ code?: number; data?: { message_id?: string } }>({
				url: replyTo
					? `/open-apis/im/v1/messages/${encodeURIComponent(replyTo)}/reply`
					: "/open-apis/im/v1/messages",
				method: "POST",
				signal: this.controller.signal,
				timeout: 15_000,
				params: replyTo ? undefined : { receive_id_type: "chat_id" },
				data: {
					...(replyTo ? {} : { receive_id: chatId }),
					msg_type: "interactive",
					content: JSON.stringify(card),
				},
			});
			this.controller.signal.throwIfAborted();
			if (response.code !== 0 || typeof response.data?.message_id !== "string" || !response.data.message_id)
				throw new Error("Invalid card response");
			return response.data.message_id;
		} catch {
			throw new Error("Lark card send failed");
		}
	}

	async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
		try {
			this.controller.signal.throwIfAborted();
			const response = await this.client.request<{ code?: number }>({
				url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
				method: "PATCH",
				signal: this.controller.signal,
				timeout: 15_000,
				data: { content: JSON.stringify(card) },
			});
			this.controller.signal.throwIfAborted();
			if (response.code !== 0) throw new Error("Invalid card response");
		} catch {
			throw new Error("Lark card update failed");
		}
	}

	async download(
		messageId: string,
		key: string,
		name: string,
		type: "image" | "file",
	): Promise<{ path: string; size: number }> {
		const operation = this.downloadResource(messageId, key, name, type);
		this.downloads.add(operation);
		try {
			return await operation;
		} finally {
			this.downloads.delete(operation);
		}
	}

	private async downloadResource(
		messageId: string,
		key: string,
		name: string,
		type: "image" | "file",
	): Promise<{ path: string; size: number }> {
		let stream: Readable | undefined;
		let directory: string | undefined;
		let oversized = false;
		const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]);
		try {
			signal.throwIfAborted();
			const response = await this.client.request<unknown>({
				url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}`,
				method: "GET",
				params: { type },
				responseType: "stream",
				signal,
				timeout: 15_000,
			});
			if (!(response instanceof Readable)) throw new Error("Invalid resource stream");
			stream = response;
			signal.throwIfAborted();
			directory = await mkdtemp(join(tmpdir(), "step-lark-"));
			this.directories.add(directory);
			signal.throwIfAborted();
			const safeName = name
				.replaceAll("\\", "/")
				.split("/")
				.pop()
				?.replace(/[\x00-\x1f\x7f]/g, "_")
				.slice(0, 120);
			const path = join(directory, !safeName || safeName === "." || safeName === ".." ? "attachment" : safeName);
			let size = 0;
			const limit = new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					size += chunk.length;
					if (size > 20 * 1024 * 1024) {
						oversized = true;
						callback(new Error("Oversized attachment"));
					} else callback(null, chunk);
				},
			});
			await pipeline(stream, limit, createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal });
			signal.throwIfAborted();
			return { path, size };
		} catch {
			stream?.destroy();
			if (directory) {
				await rm(directory, { recursive: true, force: true });
				this.directories.delete(directory);
			}
			throw new Error(oversized ? "Lark attachment exceeds 20 MiB" : "Lark attachment download failed");
		}
	}

	close(): Promise<void> {
		if (!this.closing) {
			this.controller.abort();
			this.closing = (async () => {
				await Promise.allSettled(this.downloads);
				await Promise.all(
					[...this.directories].map((directory) => rm(directory, { recursive: true, force: true })),
				);
				this.directories.clear();
			})();
		}
		return this.closing;
	}
}

/**
 * Plain text from a message body. History returns text as `{ "text": "…" }`; anything else is left
 * to the caller rather than guessed at, so a shape change cannot masquerade as an empty message.
 */
function extractText(messageType: string | undefined, content: string | undefined): string {
	if (messageType !== "text" || typeof content !== "string") return "";
	try {
		const parsed: unknown = JSON.parse(content);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const text = (parsed as Record<string, unknown>).text;
			return typeof text === "string" ? text : "";
		}
	} catch {
		// A malformed body yields no text; the message still reaches the caller with its id.
	}
	return "";
}
