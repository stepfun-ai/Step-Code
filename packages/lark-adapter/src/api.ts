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
