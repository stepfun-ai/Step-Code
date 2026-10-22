/**
 * Room turn arbitration: decides whether this agent should speak in a room message.
 *
 * Pure logic over the shape a Feishu `im.message.receive_v1` event carries. It owns no
 * session, transport or permission decision; callers validate the event and route it.
 */

export interface RoomMention {
	/** `user` or `bot`; unknown values are treated as not a bot mention. */
	mentionedType?: string;
	openId?: string;
}

export interface RoomMessage {
	id: string;
	chatId: string;
	/** `user` or `bot`, from `sender.sender_type`. */
	senderType?: string;
	senderOpenId?: string;
	/** `create_time` in milliseconds. */
	createdAt: number;
	mentions: readonly RoomMention[];
}

export type RoomTurnDecision =
	| { speak: true; addressedBy: "user" | "bot" | "self" }
	| { speak: false; reason: RoomIgnoreReason };

export type RoomIgnoreReason =
	| "self-message"
	| "not-addressed"
	| "peer-turn-cap"
	| "empty-mentions"
	| "invalid-timestamp"
	| "duplicate";

export interface RoomTurnOptions {
	/** The bot's own open_id. */
	selfOpenId: string;
	/**
	 * Maximum consecutive peer (bot→bot) turns this agent will answer before requiring a human.
	 * A single spoken message is one turn; the first response after a human message is not counted.
	 */
	maxPeerTurns: number;
	/** Consecutive peer turns already spoken before this message. */
	peerTurns: number;
}

function botMentions(message: RoomMessage, selfOpenId: string): boolean {
	return message.mentions.some((mention) => mention.mentionedType === "bot" && mention.openId === selfOpenId);
}

/** Feishu renders @-all as an open_id of `all`. */
export function addressedByAll(message: RoomMessage): boolean {
	return message.mentions.some((mention) => mention.openId === "all");
}

/**
 * Mentions of the room's peer bots (any bot that is not this agent). Used to tell a hand-off
 * from a plain statement: only a message that addresses another bot continues the conversation.
 */
export function mentionsPeerBot(message: RoomMessage, selfOpenId: string): boolean {
	return message.mentions.some(
		(mention) => mention.mentionedType === "bot" && mention.openId !== undefined && mention.openId !== selfOpenId,
	);
}

/**
 * Decide whether to speak. Order matters: cheap rejections first, the peer-turn budget last so it
 * only ever stops a run that would otherwise continue.
 */
export function decideRoomTurn(message: RoomMessage, options: RoomTurnOptions): RoomTurnDecision {
	if (!Number.isFinite(message.createdAt) || message.createdAt <= 0) {
		return { speak: false, reason: "invalid-timestamp" };
	}
	if (message.senderType === "bot" && message.senderOpenId === options.selfOpenId) {
		return { speak: false, reason: "self-message" };
	}
	// An omission of `mentioned_type` counts as a human mention so a missing label still reaches this
	// agent; only an explicit `bot` label marks a peer hand-off. A message that @-all is heard by
	// everyone but addresses nobody, so it must not start a turn.
	if (addressedByAll(message)) return { speak: false, reason: "not-addressed" };
	const addressedByHuman = message.mentions.some(
		(mention) => mention.openId === options.selfOpenId && mention.mentionedType !== "bot",
	);
	if (addressedByHuman) return { speak: true, addressedBy: "user" };
	if (!botMentions(message, options.selfOpenId)) {
		return { speak: false, reason: message.mentions.length === 0 ? "empty-mentions" : "not-addressed" };
	}
	// A bot addressed this agent: it is a hand-off, but it must respect the peer-turn budget so two
	// agents cannot ping-pong without a human.
	if (options.peerTurns >= options.maxPeerTurns) return { speak: false, reason: "peer-turn-cap" };
	return { speak: true, addressedBy: message.senderType === "bot" ? "bot" : "self" };
}

/**
 * Whether the reply this agent is about to write should hand the turn back to a peer bot.
 * Rules: answer a human without continuing the chain; answer a peer only when explicitly
 * addressed — otherwise the conversation ends, which is the default termination condition.
 */
export function shouldHandOff(addressedBy: "user" | "bot" | "self"): boolean {
	return addressedBy === "bot";
}
