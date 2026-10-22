import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { LARK_OPEN_HOSTS, type LarkCredentials } from "./registration.ts";

/** One member of a chat, as far as a room cares: who it is and whether it is a person or a bot. */
export interface ChatMember {
	openId: string;
	memberType: "user" | "bot" | "unknown";
	name: string;
}

/** Why a bot identity lookup failed, which decides whether a saved bot may be replaced. */
export type BotIdentityFailure = "credentials" | "unreachable" | "unusable";

export interface BotIdentity {
	openId: string;
	name: string;
}

export class BotIdentityError extends Error {
	readonly code: BotIdentityFailure;
	constructor(code: BotIdentityFailure, message: string) {
		super(message);
		this.name = "BotIdentityError";
		this.code = code;
	}
}

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

	/**
	 * This bot's own identity.
	 *
	 * Fails in two ways that must not be confused: the credentials no longer work (the app was deleted
	 * or its secret reset), which is the only reason to replace a saved bot, and the request could not
	 * reach the platform, which means nothing about the bot. `code` separates them.
	 */
	async getBotIdentity(): Promise<BotIdentity> {
		try {
			this.controller.signal.throwIfAborted();
			const response = await this.client.request<{ code?: number; bot?: { open_id?: string; app_name?: string } }>({
				url: "/open-apis/bot/v3/info",
				method: "GET",
				signal: this.controller.signal,
				timeout: 15_000,
			});
			this.controller.signal.throwIfAborted();
			if (response.code !== 0 || typeof response.bot?.open_id !== "string" || !response.bot.open_id) {
				throw new BotIdentityError("unusable", "Lark bot identity request failed");
			}
			return {
				openId: response.bot.open_id,
				name: typeof response.bot.app_name === "string" ? response.bot.app_name : "bot",
			};
		} catch (error) {
			if (error instanceof BotIdentityError) throw error;
			// An HTTP response means the platform answered and refused; no response means we never got
			// there. Only the refusal is evidence about the credentials themselves.
			const answered = (error as { response?: { status?: number } })?.response !== undefined;
			throw new BotIdentityError(answered ? "credentials" : "unreachable", "Lark bot identity request failed");
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
		} catch (error) {
			// Keep the platform's code: a create failure is either a permission gap or a bad invitee, and
			// the caller cannot tell which from a generic message. Codes carry no secrets.
			const data = (error as { response?: { data?: { code?: number; msg?: string } } })?.response?.data;
			throw new Error(
				data?.code
					? `Lark chat creation failed (${data.code}: ${data.msg ?? "no message"})`
					: "Lark chat creation failed",
			);
		}
	}

	/**
	 * Members of a chat, for confirming an invite landed.
	 *
	 * Returns `undefined` rather than an empty list when the members cannot be read. The SDK's
	 * paginated helper neither throws nor surfaces the error here: on a rejected request it yields one
	 * stub page with no `items` field at all, so `[]` and "no permission" would otherwise look
	 * identical. The launcher template grants no chat-read scope, making that the normal case.
	 * Callers must not read an empty result as "the invite failed".
	 */
	async listChatMembers(chatId: string): Promise<readonly ChatMember[] | undefined> {
		const members: ChatMember[] = [];
		let sawContent = false;
		try {
			for await (const page of await this.client.im.chatMembers.getWithIterator({
				params: { member_id_type: "open_id", page_size: 100 },
				path: { chat_id: chatId },
			})) {
				// A successful page always carries an `items` array, even when it is empty.
				if (!Array.isArray(page?.items)) continue;
				sawContent = true;
				for (const item of page.items) {
					if (!item?.member_id) continue;
					const type = item.member_id_type;
					members.push({
						openId: item.member_id,
						memberType: type === "user" ? "user" : type === "app" ? "bot" : "unknown",
						name: item.name ?? "",
					});
				}
			}
		} catch {
			return undefined;
		}
		return sawContent ? members : undefined;
	}

	/** Send a plain text message. Mentions use the `<at user_id="ou_…"></at>` form inside `text`. */
	async sendText(chatId: string, text: string, replyTo?: string): Promise<string> {
		try {
			const content = JSON.stringify({ text });
			const response = replyTo
				? await this.client.im.message.reply({
						path: { message_id: replyTo },
						data: { content, msg_type: "text" },
					})
				: await this.client.im.message.create({
						params: { receive_id_type: "chat_id" },
						data: { receive_id: chatId, msg_type: "text", content },
					});
			const messageId = response.data?.message_id;
			if (!messageId) throw new Error("Invalid message response");
			return messageId;
		} catch {
			throw new Error("Lark message send failed");
		}
	}

	/**
	 * Read chat history newest-last, for filling a gap the event stream reported. Bot identity needs
	 * a group-read scope, so failure here is expected on partially provisioned applications.
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
		const limit = options.limit ?? 50;
		try {
			const messages: {
				id: string;
				createdAt: number;
				senderOpenId?: string;
				senderType?: string;
				messageType: string;
				text: string;
			}[] = [];
			// The SDK walks pages for us; collecting the first `limit` is all this boundary adds.
			for await (const page of await this.client.im.message.listWithIterator({
				params: {
					container_id_type: "chat",
					container_id: chatId,
					sort_type: "ByCreateTimeAsc",
					page_size: Math.min(limit, 50),
					...(options.sinceMs ? { start_time: String(Math.floor(options.sinceMs / 1000)) } : {}),
				},
			})) {
				for (const item of page?.items ?? []) {
					const id = item.message_id;
					const createdAt = Number(item.create_time);
					if (!id || !Number.isFinite(createdAt)) continue;
					messages.push({
						id,
						createdAt,
						...(item.sender?.id ? { senderOpenId: item.sender.id } : {}),
						...(item.sender?.sender_type ? { senderType: item.sender.sender_type } : {}),
						messageType: item.msg_type ?? "unknown",
						text: extractText(item.msg_type, item.body?.content),
					});
					if (messages.length >= limit) break;
				}
				if (messages.length >= limit) break;
			}
			return messages;
		} catch {
			throw new Error("Lark chat history request failed");
		}
	}

	async sendCard(chatId: string, card: Record<string, unknown>, replyTo?: string): Promise<string> {
		try {
			const content = JSON.stringify(card);
			const response = replyTo
				? await this.client.im.message.reply({
						path: { message_id: replyTo },
						data: { content, msg_type: "interactive" },
					})
				: await this.client.im.message.create({
						params: { receive_id_type: "chat_id" },
						data: { receive_id: chatId, msg_type: "interactive", content },
					});
			const messageId = response.data?.message_id;
			if (!messageId) throw new Error("Invalid card response");
			return messageId;
		} catch {
			throw new Error("Lark card send failed");
		}
	}

	async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
		try {
			const response = await this.client.im.message.patch({
				path: { message_id: messageId },
				data: { content: JSON.stringify(card) },
			});
			if (response.code !== undefined && response.code !== 0) throw new Error("Invalid card response");
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
			// The SDK exposes this typed call but not its stream mode, so the response is the raw stream.
			const response = await this.client.im.messageResource.get(
				{ path: { message_id: messageId, file_key: key }, params: { type } },
				{ ...{ signal, timeout: 15_000, responseType: "stream" } } as Parameters<
					Client["im"]["messageResource"]["get"]
				>[1],
			);
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
