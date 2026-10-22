import { beforeEach, describe, expect, it, vi } from "vitest";
import { LarkApi } from "../src/api.ts";

const sdk = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@larksuiteoapi/node-sdk", () => ({
	LoggerLevel: { error: 1 },
	Client: class {
		request = sdk.request;
	},
}));

function api() {
	return new LarkApi({ appId: "cli_0123456789abcdef", appSecret: "fixture", brand: "lark" });
}

describe("room transport calls", () => {
	beforeEach(() => vi.clearAllMocks());

	it("creates a private chat with members and bots in one call", async () => {
		const client = api();
		try {
			sdk.request.mockResolvedValueOnce({ code: 0, data: { chat_id: "oc_room" } });
			expect(
				await client.createChat({
					name: "room-1",
					userOpenIds: ["ou_a", "ou_b"],
					botIds: ["cli_peer"],
					ownerOpenId: "ou_a",
					dedupeKey: "room-1",
				}),
			).toBe("oc_room");
			expect(sdk.request).toHaveBeenCalledWith(
				expect.objectContaining({
					url: "/open-apis/im/v1/chats",
					method: "POST",
					params: { user_id_type: "open_id", uuid: "room-1" },
					data: expect.objectContaining({
						name: "room-1",
						chat_type: "private",
						restricted_mode_setting: { status: false },
						owner_id: "ou_a",
						user_id_list: ["ou_a", "ou_b"],
						bot_id_list: ["cli_peer"],
					}),
				}),
			);
		} finally {
			await client.close();
		}
	});

	it("reports chat creation failure without leaking the response", async () => {
		const client = api();
		try {
			sdk.request.mockResolvedValueOnce({ code: 230002, msg: "Bot/User can NOT be out of the chat." });
			await expect(client.createChat({ name: "room" })).rejects.toThrow("Lark chat creation failed");
			sdk.request.mockResolvedValueOnce({ code: 0, data: {} });
			await expect(client.createChat({ name: "room" })).rejects.toThrow("Lark chat creation failed");
		} finally {
			await client.close();
		}
	});

	it("adds people and bots with the matching member id type", async () => {
		const client = api();
		try {
			sdk.request.mockResolvedValue({ code: 0 });
			await client.addChatMembers("oc/1", { openIds: ["ou_a"], appIds: ["cli_peer"] });
			expect(sdk.request).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({
					url: "/open-apis/im/v1/chats/oc%2F1/members",
					params: { member_id_type: "open_id" },
					data: { id_list: ["ou_a"] },
				}),
			);
			expect(sdk.request).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({ params: { member_id_type: "app_id" }, data: { id_list: ["cli_peer"] } }),
			);
			await client.addChatMembers("oc_1", {});
			expect(sdk.request).toHaveBeenCalledTimes(2);
		} finally {
			await client.close();
		}
	});

	it("fails member addition when the platform refuses", async () => {
		const client = api();
		try {
			sdk.request.mockResolvedValueOnce({ code: 232019, msg: "concurrent" });
			await expect(client.addChatMembers("oc_1", { appIds: ["cli_peer"] })).rejects.toThrow(
				"Lark chat member addition failed",
			);
		} finally {
			await client.close();
		}
	});

	it("lists only bot members across pages", async () => {
		const client = api();
		try {
			sdk.request
				.mockResolvedValueOnce({
					code: 0,
					data: {
						has_more: true,
						page_token: "next",
						items: [
							{ member_id_type: "app", member_id: "ou_bot", app_id: "cli_a", name: "A bot" },
							{ member_id_type: "user", member_id: "ou_human" },
						],
					},
				})
				.mockResolvedValueOnce({
					code: 0,
					data: { has_more: false, items: [{ app_id: "cli_b", member_id: "ou_bot2", name: "B bot" }] },
				});
			expect(await client.listChatBots("oc_1")).toEqual([
				{ appId: "cli_a", openId: "ou_bot", name: "A bot" },
				{ appId: "cli_b", openId: "ou_bot2", name: "B bot" },
			]);
			expect(sdk.request).toHaveBeenNthCalledWith(
				2,
				expect.objectContaining({ params: expect.objectContaining({ page_token: "next" }) }),
			);
		} finally {
			await client.close();
		}
	});

	it("sends plain text to a chat or as a reply", async () => {
		const client = api();
		try {
			sdk.request.mockResolvedValue({ code: 0, data: { message_id: "om_1" } });
			expect(await client.sendText("oc_1", "hello")).toBe("om_1");
			expect(sdk.request).toHaveBeenLastCalledWith(
				expect.objectContaining({
					params: { receive_id_type: "chat_id" },
					data: { receive_id: "oc_1", msg_type: "text", content: JSON.stringify({ text: "hello" }) },
				}),
			);
			await client.sendText("oc_1", "@_user_1 hi", "om_parent");
			expect(sdk.request).toHaveBeenLastCalledWith(
				expect.objectContaining({
					url: "/open-apis/im/v1/messages/om_parent/reply",
					params: undefined,
				}),
			);
		} finally {
			await client.close();
		}
	});

	it("reads history in order and decodes only text bodies", async () => {
		const client = api();
		try {
			sdk.request.mockResolvedValueOnce({
				code: 0,
				data: {
					has_more: false,
					items: [
						{
							message_id: "om_1",
							create_time: "1700000000000",
							msg_type: "text",
							sender: { id: "ou_a", sender_type: "user" },
							body: { content: JSON.stringify({ text: "hi" }) },
						},
						{ message_id: "om_2", create_time: "1700000001000", msg_type: "image", body: { content: "{}" } },
						{ message_id: "", create_time: "1700000002000" },
					],
				},
			});
			expect(await client.listMessages("oc_1", { sinceMs: 1_699_999_000_000 })).toEqual([
				{
					id: "om_1",
					createdAt: 1_700_000_000_000,
					senderOpenId: "ou_a",
					senderType: "user",
					messageType: "text",
					text: "hi",
				},
				{ id: "om_2", createdAt: 1_700_000_001_000, messageType: "image", text: "" },
			]);
			expect(sdk.request).toHaveBeenCalledWith(
				expect.objectContaining({
					params: expect.objectContaining({
						container_id: "oc_1",
						sort_type: "ByCreateTimeAsc",
						start_time: "1699999000",
					}),
				}),
			);
		} finally {
			await client.close();
		}
	});

	it("reports history failure as a distinct error for gap recovery", async () => {
		const client = api();
		try {
			sdk.request.mockResolvedValueOnce({ code: 230027, msg: "access denied" });
			await expect(client.listMessages("oc_1")).rejects.toThrow("Lark chat history request failed");
		} finally {
			await client.close();
		}
	});
});
