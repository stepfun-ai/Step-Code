/**
 * One person, one room bot.
 *
 * `/room` must reach for the same application on every run. These tests pin the three outcomes of
 * that lookup: a working saved bot is reused without asking anyone, dead credentials are replaced,
 * and a platform that cannot be reached replaces nothing.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotIdentityError } from "@step-harness/lark-adapter";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@step-harness/coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	getBotIdentity: vi.fn(),
	close: vi.fn(async () => undefined),
}));

vi.mock("@step-harness/lark-adapter", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@step-harness/lark-adapter")>();
	return {
		...actual,
		LarkApi: class {
			getBotIdentity = api.getBotIdentity;
			close = api.close;
		},
	};
});

const { createRoomExtension } = await import("../src/ui/runtime/room-connection.ts");

const SAVED = {
	appId: "cli_saved",
	appSecret: "saved-secret",
	botOpenId: "ou_saved_bot",
	botName: "Saved bot",
	ownerOpenId: "ou_owner",
	brand: "feishu" as const,
	createdAt: new Date("2026-10-22T00:00:00Z").toISOString(),
};

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "step-room-identity-"));
	api.getBotIdentity.mockReset();
	api.close.mockClear();
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

function harness(options: Parameters<typeof createRoomExtension>[0]) {
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const notifications: { message: string; level?: string }[] = [];
	const context = {
		mode: "tui",
		ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ExtensionCommandContext;
	const extensionApi = {
		registerCommand: (name: string, registration: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
			commands.set(name, registration.handler);
		},
		registerTool: () => {},
		on: () => {},
	} as unknown as ExtensionAPI;
	createRoomExtension(options)(extensionApi);
	return { commands, notifications, context };
}

async function seed(record: Record<string, unknown> = SAVED) {
	await writeFile(join(directory, "room-agent.json"), JSON.stringify(record), { mode: 0o600 });
}

async function savedRecord() {
	return JSON.parse(await readFile(join(directory, "room-agent.json"), "utf8"));
}

describe("the saved room bot", () => {
	it("is reused without asking anyone to authorize again", async () => {
		await seed();
		api.getBotIdentity.mockResolvedValue({ openId: "ou_saved_bot", name: "Saved bot" });
		const authorize = vi.fn(async () => undefined);
		const h = harness({ recordDirectory: directory, authorize, rendezvous: stubRendezvous() });

		await h.commands.get("room")?.("", h.context);

		expect(authorize).not.toHaveBeenCalled();
		expect(api.getBotIdentity).toHaveBeenCalledTimes(1);
		expect(await savedRecord()).toMatchObject({ appId: "cli_saved" });
	});

	it("is replaced only when the platform refuses its credentials", async () => {
		await seed();
		api.getBotIdentity.mockRejectedValue(new BotIdentityError("credentials", "refused"));
		const authorize = vi.fn(async (_context: ExtensionContext) => ({
			credentials: { appId: "cli_fresh", appSecret: "fresh-secret", brand: "feishu" as const },
			ownerOpenId: "ou_owner",
		}));
		const h = harness({ recordDirectory: directory, authorize, rendezvous: stubRendezvous() });
		api.getBotIdentity
			.mockRejectedValueOnce(new BotIdentityError("credentials", "refused"))
			.mockResolvedValueOnce({ openId: "ou_fresh_bot", name: "Fresh bot" });

		await h.commands.get("room")?.("", h.context);

		expect(authorize).toHaveBeenCalledTimes(1);
		expect(await savedRecord()).toMatchObject({ appId: "cli_fresh", botOpenId: "ou_fresh_bot" });
	});

	it("survives an unreachable platform without touching the saved credentials", async () => {
		await seed();
		const before = await savedRecord();
		api.getBotIdentity.mockRejectedValue(new BotIdentityError("unreachable", "ENOTFOUND"));
		const authorize = vi.fn(async () => undefined);
		const h = harness({ recordDirectory: directory, authorize, rendezvous: stubRendezvous() });

		await h.commands.get("room")?.("", h.context);

		expect(authorize).not.toHaveBeenCalled();
		expect(await savedRecord()).toEqual(before);
		expect(h.notifications.some((n) => n.message.includes("连不上飞书"))).toBe(true);
		// The message must say the credentials were left alone; otherwise it reads like a failure to fix.
		expect(h.notifications.some((n) => n.message.includes("未改动"))).toBe(true);
	});
});

/** The room command publishes a code before it ever needs the network service; keep it offline. */
function stubRendezvous() {
	return {
		publish: async () => ({ ok: false as const, failure: { kind: "unavailable" as const, status: 0, message: "test" } }),
		status: async () => ({ ok: false as const, failure: { kind: "unavailable" as const, status: 0, message: "test" } }),
		claim: async () => ({ ok: false as const, failure: { kind: "unavailable" as const, status: 0, message: "test" } }),
		retire: async () => ({ ok: false as const, failure: { kind: "unavailable" as const, status: 0, message: "test" } }),
	} as never;
}
