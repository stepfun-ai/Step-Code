import { access, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BotIdentityError, LarkApi } from "../src/api.ts";

const sdk = vi.hoisted(() => ({
	request: vi.fn(),
	options: {} as Record<string, unknown>,
	messageCreate: vi.fn(),
	messageReply: vi.fn(),
	messagePatch: vi.fn(),
	resourceGet: vi.fn(),
}));
vi.mock("@larksuiteoapi/node-sdk", () => ({
	LoggerLevel: { error: 1 },
	Client: class {
		constructor(options: Record<string, unknown>) {
			sdk.options = options;
		}
		request = sdk.request;
		im = {
			message: {
				create: sdk.messageCreate,
				reply: sdk.messageReply,
				patch: sdk.messagePatch,
			},
			messageResource: { get: sdk.resourceGet },
		};
	},
}));

function api() {
	return new LarkApi({ appId: "cli_0123456789abcdef", appSecret: "fixture", brand: "lark" });
}

describe("Lark REST boundary", () => {
	beforeEach(() => vi.clearAllMocks());
	it("queries and validates bot identity without exposing raw API errors", async () => {
		const client = api();
		try {
			sdk.request.mockResolvedValueOnce({ code: 0, bot: { open_id: "bot", app_name: "Step" } });
			expect(await client.getBotIdentity()).toEqual({ openId: "bot", name: "Step" });
			expect(sdk.request).toHaveBeenCalledWith(
				expect.objectContaining({ url: "/open-apis/bot/v3/info", method: "GET" }),
			);
			sdk.request.mockResolvedValueOnce({ code: 999, msg: "secret", bot: { open_id: "bot" } });
			await expect(client.getBotIdentity()).rejects.toThrow("Lark bot identity request failed");
		} finally {
			await client.close();
		}
	});
	it("separates dead credentials from an unreachable platform", async () => {
		// The distinction decides whether a saved room bot is replaced, so it must not be inferred
		// from the message. A refusal is an HTTP response; an unreachable host never produces one.
		const client = api();
		try {
			sdk.request.mockRejectedValueOnce(Object.assign(new Error("Unauthorized"), { response: { status: 401 } }));
			await expect(client.getBotIdentity()).rejects.toMatchObject({ code: "credentials" });

			sdk.request.mockRejectedValueOnce(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
			await expect(client.getBotIdentity()).rejects.toMatchObject({ code: "unreachable" });

			sdk.request.mockResolvedValueOnce({ code: 999, bot: { open_id: "bot" } });
			const failure = await client.getBotIdentity().catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(BotIdentityError);
			expect((failure as BotIdentityError).code).toBe("unusable");
		} finally {
			await client.close();
		}
	});

	it("sends, replies and updates cards while rejecting API failures", async () => {
		const client = api();
		const card = { elements: [{ tag: "markdown", content: "hello" }] };
		try {
			sdk.messageCreate.mockResolvedValue({ code: 0, data: { message_id: "card" } });
			sdk.messageReply.mockResolvedValue({ code: 0, data: { message_id: "card" } });
			expect(await client.sendCard("chat", card)).toBe("card");
			expect(sdk.messageCreate).toHaveBeenLastCalledWith({
				params: { receive_id_type: "chat_id" },
				data: { receive_id: "chat", msg_type: "interactive", content: JSON.stringify(card) },
			});
			expect(await client.sendCard("chat", card, "request/1")).toBe("card");
			expect(sdk.messageReply).toHaveBeenLastCalledWith({
				path: { message_id: "request/1" },
				data: { content: JSON.stringify(card), msg_type: "interactive" },
			});
			sdk.messagePatch.mockResolvedValue({ code: 0 });
			await client.updateCard("card", card);
			expect(sdk.messagePatch).toHaveBeenLastCalledWith({
				path: { message_id: "card" },
				data: { content: JSON.stringify(card) },
			});
			sdk.messagePatch.mockRejectedValueOnce(new Error("private payload"));
			await expect(client.updateCard("card", card)).rejects.toThrow("Lark card update failed");
			sdk.messageCreate.mockRejectedValueOnce(new Error("denied"));
			await expect(client.sendCard("chat", card)).rejects.toThrow("Lark card send failed");
		} finally {
			await client.close();
		}
	});
	it("downloads bounded streams to unique safe paths and removes them on close", async () => {
		const client = api();
		sdk.resourceGet.mockImplementation(async () => Readable.from([Buffer.from("hello")]));
		const first = await client.download("message", "file", "../../report.txt", "file");
		const second = await client.download("message", "file", "../../report.txt", "file");
		expect(first.path).not.toBe(second.path);
		expect(basename(first.path)).toBe("report.txt");
		expect(await readFile(first.path, "utf8")).toBe("hello");
		expect(first.size).toBe(5);
		await client.close();
		await expect(access(first.path)).rejects.toThrow();
		await expect(client.download("message", "file", "report.txt", "file")).rejects.toThrow();
	});
	it("stops oversized downloads while streaming rather than buffering the whole resource", async () => {
		const client = api();
		const stream = Readable.from([Buffer.alloc(11 * 1024 * 1024), Buffer.alloc(11 * 1024 * 1024)]);
		sdk.resourceGet.mockResolvedValueOnce(stream);
		try {
			await expect(client.download("message", "file", "large.txt", "file")).rejects.toThrow(
				"Lark attachment exceeds 20 MiB",
			);
			expect(stream.destroyed).toBe(true);
		} finally {
			await client.close();
		}
	});
	it("cancels an active resource stream and discards late bot identity responses", async () => {
		const client = api();
		const stream = new Readable({ read() {} });
		let resolveStream: (value: unknown) => void = () => {};
		sdk.resourceGet.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolveStream = done;
				}),
		);
		const download = client.download("message", "key", "file", "file");
		const rejected = expect(download).rejects.toThrow("Lark attachment download failed");
		// close() aborts and settles owned work; the in-flight SDK call then resolves into a closed client.
		const closed = client.close();
		resolveStream(stream);
		await rejected;
		await closed;
		stream.destroy();
		const second = api();
		let resolve: (value: unknown) => void = () => {};
		sdk.request.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const identity = second.getBotIdentity();
		const stale = expect(identity).rejects.toThrow("Lark bot identity request failed");
		await second.close();
		resolve({ code: 0, bot: { open_id: "late" } });
		await stale;
	});
});
