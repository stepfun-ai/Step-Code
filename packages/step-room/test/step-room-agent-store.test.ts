import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRoomAgentRecord, RoomAgentStore } from "../src/index.ts";

const RECORD = {
	appId: "cli_0123456789abcdef",
	appSecret: "fixture-secret",
	botOpenId: "ou_bot",
	botName: "StepCode 会议室",
	brand: "feishu" as const,
	createdAt: "2026-10-22T00:00:00.000Z",
};

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "step-room-agent-"));
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("room agent record", () => {
	it("reports a missing record as the normal first run", async () => {
		const store = new RoomAgentStore({ directory });
		expect(await store.read()).toEqual({ status: "missing" });
	});

	it("round-trips a record and writes it owner-only", async () => {
		const store = new RoomAgentStore({ directory });
		await store.write(RECORD);
		expect(await store.read()).toEqual({ status: "found", record: RECORD });
		if (process.platform !== "win32") {
			const mode = (await stat(store.path)).mode & 0o777;
			expect(mode).toBe(0o600);
		}
	});

	it("keeps only the known fields", async () => {
		const store = new RoomAgentStore({ directory });
		await store.write({ ...RECORD, extra: "dropped" } as typeof RECORD);
		const parsed = JSON.parse(await readFile(store.path, "utf8"));
		expect(parsed.extra).toBeUndefined();
	});

	it("distinguishes malformed and incomplete records from a missing one", async () => {
		const store = new RoomAgentStore({ directory });
		await writeFile(store.path, "{not json", "utf8");
		expect(await store.read()).toEqual({ status: "invalid", reason: "malformed" });
		await writeFile(store.path, JSON.stringify({ appId: "cli_x" }), "utf8");
		expect(await store.read()).toEqual({ status: "invalid", reason: "incomplete" });
	});

	it("refuses to write an incomplete record instead of persisting a half identity", async () => {
		const store = new RoomAgentStore({ directory });
		await expect(store.write({ ...RECORD, botOpenId: "" })).rejects.toThrow("invalid room agent record");
		expect(await store.read()).toEqual({ status: "missing" });
	});

	it("leaves no temporary file behind when writing", async () => {
		const store = new RoomAgentStore({ directory });
		await store.write(RECORD);
		const { readdir } = await import("node:fs/promises");
		expect((await readdir(directory)).sort()).toEqual(["room-agent.json"]);
	});

	it("clears the record on request", async () => {
		const store = new RoomAgentStore({ directory });
		await store.write(RECORD);
		await store.clear();
		expect(await store.read()).toEqual({ status: "missing" });
	});

	it("treats an unknown brand as invalid rather than guessing", () => {
		expect(parseRoomAgentRecord({ ...RECORD, brand: "slack" })).toBeUndefined();
		expect(parseRoomAgentRecord({ ...RECORD, createdAt: "not-a-date" })).toBeUndefined();
	});
});
