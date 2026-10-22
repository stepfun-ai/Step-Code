/**
 * Room binding: which session owns which chat.
 *
 * One chat belongs to exactly one session. A session may later own several chats, so the table is
 * keyed by chat: the reverse index is a convenience, never the source of truth.
 *
 * Delivery is deliberately boring: an unbound chat is dropped silently and counted. It must never
 * start a session, call a model, or reply in the chat — a bot is reachable by anyone who can invite
 * it, so "nobody bound this chat" is the normal case, not an error.
 */

export interface RoomBinding {
	chatId: string;
	sessionId: string;
}

export interface RoomDelivery {
	chatId: string;
	sessionId: string;
}

export type RoomResolveResult = { action: "deliver"; delivery: RoomDelivery } | { action: "drop"; reason: "unbound" };

export interface RoomDropCount {
	chatId: string;
	count: number;
}

export interface RoomBindingStoreOptions {
	/** Bound chats, oldest first. Duplicate chat ids are rejected rather than silently rebound. */
	bindings?: readonly RoomBinding[];
	/** Maximum chats one session may own. Defaults to the phase-one limit of one. */
	maxChatsPerSession?: number;
}

/**
 * In-memory binding table. The host persists it; this type only enforces the invariants:
 * one chat → one session, and the per-session chat budget.
 */
export class RoomBindingStore {
	private readonly byChat = new Map<string, string>();
	private readonly bySession = new Map<string, Set<string>>();
	private readonly drops = new Map<string, number>();
	private readonly maxChatsPerSession: number;

	constructor(options: RoomBindingStoreOptions = {}) {
		this.maxChatsPerSession = options.maxChatsPerSession ?? 1;
		if (!Number.isInteger(this.maxChatsPerSession) || this.maxChatsPerSession < 1) {
			throw new Error("maxChatsPerSession must be a positive integer");
		}
		for (const binding of options.bindings ?? []) this.bind(binding.chatId, binding.sessionId);
	}

	/**
	 * Bind a chat to a session. Rebinding to the same session is idempotent; binding a chat that
	 * already belongs to another session throws instead of silently moving messages.
	 */
	bind(chatId: string, sessionId: string): void {
		if (!chatId || !sessionId) throw new Error("chatId and sessionId are required");
		const owner = this.byChat.get(chatId);
		if (owner !== undefined && owner !== sessionId) {
			throw new Error("chat already bound to another session");
		}
		if (owner === sessionId) return;
		const chats = this.bySession.get(sessionId) ?? new Set<string>();
		if (chats.size >= this.maxChatsPerSession) throw new Error("session chat limit reached");
		chats.add(chatId);
		this.bySession.set(sessionId, chats);
		this.byChat.set(chatId, sessionId);
	}

	unbind(chatId: string): boolean {
		const sessionId = this.byChat.get(chatId);
		if (sessionId === undefined) return false;
		this.byChat.delete(chatId);
		const chats = this.bySession.get(sessionId);
		chats?.delete(chatId);
		if (chats?.size === 0) this.bySession.delete(sessionId);
		return true;
	}

	sessionFor(chatId: string): string | undefined {
		return this.byChat.get(chatId);
	}

	chatsFor(sessionId: string): readonly string[] {
		return [...(this.bySession.get(sessionId) ?? [])];
	}

	/**
	 * Route one inbound chat to its session, or drop it. Drops are counted per chat so the owner can
	 * see "your bot was mentioned in 3 chats it does not serve" in the terminal without the bot
	 * posting anything into those chats.
	 */
	resolve(chatId: string): RoomResolveResult {
		const sessionId = this.byChat.get(chatId);
		if (sessionId === undefined) {
			this.drops.set(chatId, (this.drops.get(chatId) ?? 0) + 1);
			return { action: "drop", reason: "unbound" };
		}
		return { action: "deliver", delivery: { chatId, sessionId } };
	}

	dropCounts(): readonly RoomDropCount[] {
		return [...this.drops].map(([chatId, count]) => ({ chatId, count }));
	}

	clearDropCounts(): void {
		this.drops.clear();
	}
}
