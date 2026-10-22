import { beforeEach, describe, expect, it, vi } from "vitest";
import { LarkApi } from "../src/api.ts";

const sdk = vi.hoisted(() => ({
	request: vi.fn(),
	chatCreate: vi.fn(),
	chatMembersGet: vi.fn(),
	messageCreate: vi.fn(),
	messageReply: vi.fn(),
	messageList: vi.fn(),
}));
vi.mock("@larksuiteoapi/node-sdk", () => ({
	LoggerLevel: { error: 1 },
	Client: class {
		request = sdk.request;
		im = {
			chat: { create: sdk.chatCreate },
			chatMembers: {
				create: vi.fn(),
				get: sdk.chatMembersGet,
				getWithIterator: async (...args: unknown[]) => {
					const first = await (sdk.chatMembersGet as (...a: unknown[]) => Promise<unknown>)(...args);
					return (async function* () {
						yield first;
						for (const more of ((first as { __more?: unknown[] })?.__more ?? []) as unknown[]) yield more;
					})();
				},
			},
			message: { create: sdk.messageCreate, reply: sdk.messageReply, list: sdk.messageList },
		};
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
			sdk.chatCreate.mockResolvedValueOnce({ code: 0, data: { chat_id: "oc_room" } });
			expect(
				await client.createChat({
					name: "room-1",
					userOpenIds: ["ou_a", "ou_b"],
					botIds: ["cli_peer"],
					ownerOpenId: "ou_a",
					dedupeKey: "room-1",
				}),
			).toBe("oc_room");
			const [request] = sdk.chatCreate.mock.calls[0];
			expect(request.params).toEqual({ user_id_type: "open_id", uuid: "room-1" });
			expect(request.data).toMatchObject({
				name: "room-1",
				chat_type: "private",
				owner_id: "ou_a",
				user_id_list: ["ou_a", "ou_b"],
				bot_id_list: ["cli_peer"],
			});
			expect(request.data.restricted_mode_setting.status).toBe(false);
		} finally {
			await client.close();
		}
	});

	it("reports chat creation failure without leaking the response", async () => {
		const client = api();
		try {
			sdk.chatCreate.mockRejectedValueOnce(new Error("Bot/User can NOT be out of the chat."));
			await expect(client.createChat({ name: "room" })).rejects.toThrow("Lark chat creation failed");
			sdk.chatCreate.mockResolvedValueOnce({ code: 0, data: {} });
			await expect(client.createChat({ name: "room" })).rejects.toThrow("Lark chat creation failed");
		} finally {
			await client.close();
		}
	});

	it("lists members with their kind across pages", async () => {
		const client = api();
		try {
			const first = {
				items: [
					{ member_id_type: "app", member_id: "ou_bot", name: "A bot" },
					{ member_id_type: "user", member_id: "ou_human" },
				],
			};
			const second = { items: [{ member_id_type: "app", member_id: "ou_bot2", name: "B bot" }] };
			sdk.chatMembersGet.mockResolvedValueOnce({ ...first, __more: [second] });
			expect(await client.listChatMembers("oc_1")).toEqual([
				{ openId: "ou_bot", memberType: "bot", name: "A bot" },
				{ openId: "ou_human", memberType: "user", name: "" },
				{ openId: "ou_bot2", memberType: "bot", name: "B bot" },
			]);
			expect(sdk.chatMembersGet).toHaveBeenCalledWith(
				expect.objectContaining({
					path: { chat_id: "oc_1" },
					params: expect.objectContaining({ member_id_type: "open_id" }),
				}),
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
