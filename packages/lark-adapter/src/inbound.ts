export interface LarkMessage {
	id: string;
	chatId: string;
	text: string;
	imageKeys: string[];
	files: { key: string; name: string }[];
}

export type LarkInboundResult = { action: "accept"; message: LarkMessage } | { action: "ignore"; reason: string };

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const MESSAGE_MAX_AGE_MS = 600_000;
const MAX_CLOCK_SKEW_MS = 30_000;
const MAX_SEEN_MESSAGES = 4096;

/** Input-only state, not a session or transcript. Invalid events cannot claim the chat binding. */
export class LarkInboundGate {
	private readonly botId: string;
	private readonly seen = new Map<string, number>();
	private boundChat: string | undefined;
	private closed = false;

	constructor(botId: string) {
		this.botId = botId;
	}
	get chatId(): string | undefined {
		return this.boundChat;
	}

	accept(event: unknown, now = Date.now()): LarkInboundResult {
		const message = record(record(event).message);
		const sender = record(record(record(event).sender).sender_id);
		const { message_id: id, chat_id: chatId, message_type: type } = message;
		if (
			this.closed ||
			typeof id !== "string" ||
			!id ||
			typeof chatId !== "string" ||
			!chatId ||
			sender.open_id === this.botId
		) {
			return { action: "ignore", reason: "malformed" };
		}
		const timestamp = Number(message.create_time);
		const createdAt = timestamp < 1e12 ? timestamp * 1000 : timestamp;
		if (
			!Number.isFinite(createdAt) ||
			createdAt <= 0 ||
			now - createdAt > MESSAGE_MAX_AGE_MS ||
			createdAt - now > MAX_CLOCK_SKEW_MS
		) {
			return { action: "ignore", reason: "stale" };
		}
		const mentions = Array.isArray(message.mentions) ? message.mentions.map(record) : [];
		if (message.chat_type !== "p2p" && !mentions.some((mention) => record(mention.id).open_id === this.botId)) {
			return { action: "ignore", reason: "not-mentioned" };
		}
		let content: Record<string, unknown>;
		try {
			content = record(JSON.parse(typeof message.content === "string" ? message.content : ""));
		} catch {
			return { action: "ignore", reason: "malformed" };
		}
		let text = "";
		const imageKeys: string[] = [];
		const files: LarkMessage["files"] = [];
		if (type === "text") text = typeof content.text === "string" ? content.text : "";
		else if (type === "image" && typeof content.image_key === "string" && content.image_key)
			imageKeys.push(content.image_key);
		else if (type === "file" && typeof content.file_key === "string" && content.file_key) {
			files.push({
				key: content.file_key,
				name: typeof content.file_name === "string" ? content.file_name : "file",
			});
		} else if (type === "post") {
			const body = record(content.zh_cn ?? content.en_us ?? content);
			const lines: string[] = typeof body.title === "string" ? [body.title] : [];
			for (const row of Array.isArray(body.content) ? body.content : []) {
				let line = "";
				for (const raw of Array.isArray(row) ? row : []) {
					const node = record(raw);
					if (node.tag === "text" && typeof node.text === "string") line += node.text;
					if (node.tag === "a" && typeof node.href === "string") line += node.href;
					if (node.tag === "img" && typeof node.image_key === "string" && node.image_key)
						imageKeys.push(node.image_key);
				}
				lines.push(line);
			}
			text = lines.join("\n");
		} else return { action: "ignore", reason: "unsupported-type" };
		for (const mention of mentions) {
			if (record(mention.id).open_id === this.botId && typeof mention.key === "string" && mention.key) {
				text = text.replaceAll(mention.key, "");
			}
		}
		text = text.trim();
		if (!text && !imageKeys.length && !files.length) return { action: "ignore", reason: "empty" };
		if (this.boundChat && this.boundChat !== chatId) return { action: "ignore", reason: "other-chat" };
		// Retain IDs for their entire eligibility window; never evict a live ID to admit new work.
		for (const [key, expiresAt] of this.seen) if (now > expiresAt) this.seen.delete(key);
		if (this.seen.has(id)) return { action: "ignore", reason: "duplicate" };
		if (this.seen.size >= MAX_SEEN_MESSAGES) return { action: "ignore", reason: "rate-limit" };
		this.seen.set(id, createdAt + MESSAGE_MAX_AGE_MS);
		this.boundChat = chatId;
		return { action: "accept", message: { id, chatId, text, imageKeys, files } };
	}

	close(): void {
		this.closed = true;
		this.boundChat = undefined;
		this.seen.clear();
	}
}
