import { describe, expect, it } from "vitest";
import type { RoomMessage } from "../src/features/step-room/index.ts";
import { decideRoomTurn, mentionsPeerBot, shouldHandOff } from "../src/features/step-room/index.ts";

const SELF = "ou_self";

function message(overrides: Partial<RoomMessage> = {}): RoomMessage {
	return {
		id: "om_1",
		chatId: "oc_1",
		senderType: "user",
		senderOpenId: "ou_human",
		createdAt: 1_700_000_000_000,
		mentions: [],
		...overrides,
	};
}

const options = { selfOpenId: SELF, maxPeerTurns: 3, peerTurns: 0 };

describe("room turn arbitration", () => {
	it("speaks when a human mentions this agent", () => {
		const decision = decideRoomTurn(message({ mentions: [{ mentionedType: "user", openId: SELF }] }), options);
		expect(decision).toEqual({ speak: true, addressedBy: "user" });
	});

	it("speaks when a peer bot mentions this agent", () => {
		const decision = decideRoomTurn(
			message({
				senderType: "bot",
				senderOpenId: "ou_peer",
				mentions: [{ mentionedType: "bot", openId: SELF }],
			}),
			options,
		);
		expect(decision).toEqual({ speak: true, addressedBy: "bot" });
	});

	it("stays silent on an unaddressed statement so the chain terminates", () => {
		expect(decideRoomTurn(message({ senderType: "bot", senderOpenId: "ou_peer" }), options)).toEqual({
			speak: false,
			reason: "empty-mentions",
		});
	});

	it("stays silent when the mention is someone else", () => {
		const decision = decideRoomTurn(message({ mentions: [{ mentionedType: "user", openId: "ou_other" }] }), options);
		expect(decision).toEqual({ speak: false, reason: "not-addressed" });
	});

	it("never answers its own message", () => {
		const decision = decideRoomTurn(message({ senderType: "bot", senderOpenId: SELF }), options);
		expect(decision).toEqual({ speak: false, reason: "self-message" });
	});

	it("caps peer turns even when addressed by a peer", () => {
		const decision = decideRoomTurn(
			message({
				senderType: "bot",
				senderOpenId: "ou_peer",
				mentions: [{ mentionedType: "bot", openId: SELF }],
			}),
			{ ...options, peerTurns: 3 },
		);
		expect(decision).toEqual({ speak: false, reason: "peer-turn-cap" });
	});

	it("lets a human reset the peer-turn budget", () => {
		const decision = decideRoomTurn(message({ mentions: [{ mentionedType: "user", openId: SELF }] }), {
			...options,
			peerTurns: 99,
		});
		expect(decision).toEqual({ speak: true, addressedBy: "user" });
	});

	it("rejects an unusable timestamp", () => {
		expect(decideRoomTurn(message({ createdAt: Number.NaN }), options)).toEqual({
			speak: false,
			reason: "invalid-timestamp",
		});
	});

	it("does not start a turn on an @-all broadcast", () => {
		const decision = decideRoomTurn(
			message({
				mentions: [
					{ mentionedType: "user", openId: "all" },
					{ mentionedType: "bot", openId: SELF },
				],
			}),
			options,
		);
		expect(decision).toEqual({ speak: false, reason: "not-addressed" });
	});

	it("treats a mention without a type as a human mention", () => {
		expect(decideRoomTurn(message({ mentions: [{ openId: SELF }] }), options)).toEqual({
			speak: true,
			addressedBy: "user",
		});
	});
});

describe("room hand-off", () => {
	it("continues only when answering a peer bot", () => {
		expect(shouldHandOff("bot")).toBe(true);
		expect(shouldHandOff("user")).toBe(false);
	});

	it("detects a mention of a peer bot distinct from this agent", () => {
		const addressed = message({ mentions: [{ mentionedType: "bot", openId: "ou_peer" }] });
		expect(mentionsPeerBot(addressed, SELF)).toBe(true);
		expect(mentionsPeerBot(message({ mentions: [{ mentionedType: "bot", openId: SELF }] }), SELF)).toBe(false);
	});

	it("does not treat a human mention as a peer hand-off", () => {
		expect(mentionsPeerBot(message({ mentions: [{ mentionedType: "user", openId: "ou_a" }] }), SELF)).toBe(false);
	});
});
