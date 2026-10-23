import { access, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LarkApi } from "../src/api.ts";

const sdk = vi.hoisted(() => ({ request: vi.fn(), options: {} as Record<string, unknown> }));
vi.mock("@larksuiteoapi/node-sdk", () => ({
	LoggerLevel: { error: 1 },
	Client: class {
		constructor(options: Record<string, unknown>) {
			sdk.options = options;
		}
		request = sdk.request;
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
	it("sends, replies and updates cards while rejecting API failures", async () => {
		const client = api();
		const card = { elements: [{ tag: "markdown", content: "hello" }] };
		try {
			sdk.request.mockResolvedValue({ code: 0, data: { message_id: "card" } });
			expect(await client.sendCard("chat", card)).toBe("card");
			expect(sdk.request).toHaveBeenLastCalledWith(
				expect.objectContaining({
					url: "/open-apis/im/v1/messages",
					method: "POST",
					params: { receive_id_type: "chat_id" },
					data: { receive_id: "chat", msg_type: "interactive", content: JSON.stringify(card) },
				}),
			);
			expect(await client.sendCard("chat", card, "request/1")).toBe("card");
			expect(sdk.request).toHaveBeenLastCalledWith(
				expect.objectContaining({ url: "/open-apis/im/v1/messages/request%2F1/reply" }),
			);
			await client.updateCard("card", card);
			expect(sdk.request).toHaveBeenLastCalledWith(
				expect.objectContaining({ method: "PATCH", url: "/open-apis/im/v1/messages/card" }),
			);
			sdk.request.mockResolvedValueOnce({ code: 999, msg: "private payload" });
			await expect(client.updateCard("card", card)).rejects.toThrow("Lark card update failed");
		} finally {
			await client.close();
		}
	});
	it("downloads bounded streams to unique safe paths and removes them on close", async () => {
		const client = api();
		sdk.request.mockImplementation(async () => Readable.from([Buffer.from("hello")]));
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
		sdk.request.mockResolvedValueOnce(stream);
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
		sdk.request.mockResolvedValueOnce(stream);
		const download = client.download("message", "key", "file", "file");
		const rejected = expect(download).rejects.toThrow("Lark attachment download failed");
		await client.close();
		await rejected;
		expect(stream.destroyed).toBe(true);
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
