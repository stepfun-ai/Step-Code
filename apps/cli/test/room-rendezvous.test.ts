import { describe, expect, it, vi } from "vitest";
import {
	decodeRoomPeerRecord,
	describeFailure,
	newRoomSecret,
	RoomRendezvousClient,
} from "../src/ui/runtime/room-rendezvous.ts";

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json", ...headers },
		});
	});
	return { fn: fn as unknown as typeof fetch, calls };
}

const BASE = "https://example.test";

describe("room rendezvous client", () => {
	it("publishes a code with its secret", async () => {
		const { fn, calls } = stubFetch(200, {
			code: "48291730",
			claimed: false,
			created_at: "2026-10-22T00:00:00Z",
			expires_at: "2026-10-22T00:02:00Z",
		});
		vi.stubGlobal("fetch", fn);
		const ok = await new RoomRendezvousClient({ baseUrl: BASE }).publish("48291730", "s".repeat(32));
		expect(ok.ok).toBe(true);
		expect(calls[0].url).toBe(`${BASE}/api/v1/room/publish`);
		expect(JSON.parse(String(calls[0].init.body))).toEqual({ code: "48291730", secret: "s".repeat(32) });
		vi.unstubAllGlobals();
	});

	it("sends the claim identity in the service's snake_case shape", async () => {
		const { fn, calls } = stubFetch(200, {
			code: "48291730",
			claimed: true,
			peer: { app_id: "cli_b", open_id: "ou_b", user_open_id: "ou_b_human" },
		});
		vi.stubGlobal("fetch", fn);
		const result = await new RoomRendezvousClient({ baseUrl: BASE }).claim("48291730", {
			appId: "cli_b",
			openId: "ou_b",
			userOpenId: "ou_b_human",
			name: "B",
		});
		// The service answers in snake_case; the client must hand back camelCase fields it can use.
		expect(result).toEqual({
			ok: true,
			value: {
				code: "48291730",
				claimed: true,
				peer: { appId: "cli_b", openId: "ou_b", userOpenId: "ou_b_human" },
				createdAt: "",
				expiresAt: "",
			},
		});
		expect(JSON.parse(String(calls[0].init.body))).toEqual({
			code: "48291730",
			identity: { app_id: "cli_b", open_id: "ou_b", user_open_id: "ou_b_human", name: "B" },
		});
		vi.unstubAllGlobals();
	});

	it("reads status with the secret in a header, never in the URL", async () => {
		const { fn, calls } = stubFetch(200, { code: "48291730", claimed: false });
		vi.stubGlobal("fetch", fn);
		await new RoomRendezvousClient({ baseUrl: BASE }).status("48291730", "top-secret-value");
		expect(calls[0].url).toBe(`${BASE}/api/v1/room/status?code=48291730`);
		expect(calls[0].url).not.toContain("top-secret-value");
		expect((calls[0].init.headers as Record<string, string>)["X-Room-Secret"]).toBe("top-secret-value");
		vi.unstubAllGlobals();
	});

	it("maps service failures to actions the command can explain", async () => {
		for (const [status, kind] of [
			[404, "not-found"],
			[403, "forbidden"],
			[409, "conflict"],
			[429, "throttled"],
			[400, "invalid"],
			[500, "unavailable"],
		] as const) {
			const { fn } = stubFetch(status, { error: { message: "nope" } });
			vi.stubGlobal("fetch", fn);
			const result = await new RoomRendezvousClient({ baseUrl: BASE }).status("48291730", "s".repeat(32));
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.failure.kind).toBe(kind);
			vi.unstubAllGlobals();
		}
	});

	it("reports a network failure instead of throwing", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("connect ECONNREFUSED");
			}),
		);
		const result = await new RoomRendezvousClient({ baseUrl: BASE }).publish("48291730", "s".repeat(32));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure.kind).toBe("unavailable");
		vi.unstubAllGlobals();
	});

	it("maps every snake_case peer field the group invite depends on", () => {
		// Regression: reading `app_id` as `appId` left peer.appId undefined, and the group creation then
		// sent a null bot id and failed with 232043 unavailable ids.
		const record = decodeRoomPeerRecord({
			code: "48291730",
			claimed: true,
			peer: { app_id: "cli_b", open_id: "ou_b", user_open_id: "ou_b_human", name: "B" },
			owner_open_id: "ou_a_human",
			created_at: "2026-10-22T00:00:00Z",
			expires_at: "2026-10-22T00:02:00Z",
		});
		expect(record.peer).toEqual({ appId: "cli_b", openId: "ou_b", userOpenId: "ou_b_human", name: "B" });
		expect(record.ownerOpenId).toBe("ou_a_human");
		expect(record.expiresAt).toBe("2026-10-22T00:02:00Z");
	});

	it("drops a peer that is missing the ids an invite needs", () => {
		const record = decodeRoomPeerRecord({ code: "48291730", claimed: true, peer: { app_id: "cli_b", open_id: "ou_b" } });
		expect(record.claimed).toBe(true);
		expect(record.peer).toBeUndefined();
	});

	it("rejects a record without a code instead of returning a half-filled one", () => {
		expect(() => decodeRoomPeerRecord({ claimed: true })).toThrow();
		expect(() => decodeRoomPeerRecord(null)).toThrow();
	});

	it("generates a secret long enough for the service to accept", () => {
		const secret = newRoomSecret();
		expect(secret).toMatch(/^[0-9a-f]{64}$/);
		expect(newRoomSecret()).not.toBe(secret);
	});

	it("gives every failure a message a person can act on", () => {
		for (const failure of [
			{ kind: "not-found" },
			{ kind: "forbidden" },
			{ kind: "conflict" },
			{ kind: "throttled" },
			{ kind: "invalid" },
			{ kind: "unavailable", status: 502, message: "bad gateway" },
		] as const) {
			expect(describeFailure(failure).length).toBeGreaterThan(0);
		}
	});
});
