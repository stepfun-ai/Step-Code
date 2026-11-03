import { describe, expect, it } from "vitest";
import { LarkInboundGate } from "../src/inbound.ts";

const now = 1_800_000_000_000;
function message(id = "m1", chat = "c1", text = "hello") {
	return {
		sender: { sender_id: { open_id: "user" } },
		message: {
			message_id: id,
			chat_id: chat,
			chat_type: "p2p",
			message_type: "text",
			create_time: String(now),
			content: JSON.stringify({ text }),
		},
	};
}

describe("single-session Lark input", () => {
	it("binds the first valid chat and rejects attempts to take it over", () => {
		const gate = new LarkInboundGate("bot");
		expect(gate.accept(message(), now)).toMatchObject({ action: "accept", message: { text: "hello" } });
		expect(gate.accept(message("m2", "c2"), now)).toEqual({ action: "ignore", reason: "other-chat" });
		expect(gate.chatId).toBe("c1");
	});

	it("does not bind on malformed, empty, stale, bot or unmentioned group messages", () => {
		for (const event of [
			null,
			[],
			{},
			message("empty", "c2", ""),
			{ ...message(), sender: { sender_id: { open_id: "bot" } } },
			{ message: { ...message().message, create_time: String(now - 600_001) } },
			{ message: { ...message().message, chat_type: "group" } },
			{ message: { ...message().message, content: "null" } },
			{ message: { ...message().message, chat_id: "" } },
		]) {
			const gate = new LarkInboundGate("bot");
			expect(gate.accept(event, now).action).toBe("ignore");
			expect(gate.chatId).toBeUndefined();
		}
	});

	it("requires the bot mention and removes only matching mention markers", () => {
		const gate = new LarkInboundGate("bot");
		const event = {
			message: {
				...message().message,
				chat_type: "group",
				content: JSON.stringify({ text: "@_user_1 ask @_user_2" }),
				mentions: [{ key: "@_user_1", id: { open_id: "bot" } }],
			},
		};
		expect(gate.accept(event, now)).toMatchObject({ action: "accept", message: { text: "ask @_user_2" } });
	});

	it("deduplicates throughout the freshness window and can release all state", () => {
		const gate = new LarkInboundGate("bot");
		gate.accept(message(), now);
		for (const elapsed of [100, 61_000, 599_999, 600_000]) {
			expect(gate.accept(message(), now + elapsed)).toEqual({ action: "ignore", reason: "duplicate" });
		}
		expect(gate.accept(message(), now + 600_001)).toEqual({ action: "ignore", reason: "stale" });
		gate.close();
		expect(gate.accept(message("new", "c2"), now).action).toBe("ignore");
		expect(gate.chatId).toBeUndefined();
	});

	it("fails closed at capacity without evicting live IDs, and releases expired entries", () => {
		const gate = new LarkInboundGate("bot");
		for (let index = 0; index < 4096; index++) {
			expect(gate.accept(message(`m${index}`), now).action).toBe("accept");
		}
		expect(gate.accept(message("overflow"), now)).toEqual({ action: "ignore", reason: "rate-limit" });
		expect(gate.accept(message("m0"), now + 61_000)).toEqual({ action: "ignore", reason: "duplicate" });
		const fresh = { message: { ...message("fresh").message, create_time: String(now + 600_001) } };
		expect(gate.accept(fresh, now + 600_001).action).toBe("accept");
	});

	it("bounds future clock skew and retains IDs until their timestamp expires", () => {
		const future = { message: { ...message().message, create_time: String(now + 30_000) } };
		const gate = new LarkInboundGate("bot");
		expect(gate.accept(future, now).action).toBe("accept");
		expect(gate.accept(future, now + 630_000)).toEqual({ action: "ignore", reason: "duplicate" });
		expect(gate.accept(future, now + 630_001)).toEqual({ action: "ignore", reason: "stale" });
		const invalid = new LarkInboundGate("bot");
		expect(invalid.accept({ message: { ...future.message, create_time: String(now + 30_001) } }, now)).toEqual({
			action: "ignore",
			reason: "stale",
		});
		expect(invalid.chatId).toBeUndefined();
	});

	it("applies the same freshness and deduplication rules to second timestamps", () => {
		const gate = new LarkInboundGate("bot");
		const event = { message: { ...message().message, create_time: String(now / 1000) } };
		expect(gate.accept(event, now).action).toBe("accept");
		expect(gate.accept(event, now + 600_000)).toEqual({ action: "ignore", reason: "duplicate" });
	});

	it("parses image, file and rich text references without downloading", () => {
		for (const [type, content, expected] of [
			["image", { image_key: "image" }, { imageKeys: ["image"] }],
			["file", { file_key: "file", file_name: "report.txt" }, { files: [{ key: "file", name: "report.txt" }] }],
			[
				"post",
				{
					zh_cn: {
						title: "Title",
						content: [
							[
								{ tag: "text", text: "Body" },
								{ tag: "img", image_key: "image" },
							],
						],
					},
				},
				{ text: "Title\nBody", imageKeys: ["image"] },
			],
		] as const) {
			const gate = new LarkInboundGate("bot");
			expect(
				gate.accept(
					{ message: { ...message().message, message_type: type, content: JSON.stringify(content) } },
					now,
				),
			).toMatchObject({ action: "accept", message: expected });
		}
	});
});
