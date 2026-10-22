/**
 * Client for the room rendezvous service.
 *
 * The service holds one record for two minutes: "code 48291730 belongs to whoever started, and
 * here is who joined it". It is how the joining terminal's app id and open id reach the waiting
 * one; nothing else about the room passes through it.
 *
 * The secret is generated here and never leaves this process except to this endpoint. The service
 * uses it to scope reads, so knowing the code alone cannot reveal the other person's identity.
 */

import { randomBytes } from "node:crypto";

/** Trial deployment. Hard-coded on purpose while this is only verified locally. */
export const ROOM_RENDEZVOUS_BASE_URL = "https://stepcliobserserver-dashboard.stepfun-inc.com";

export interface RoomPeerIdentity {
	appId: string;
	openId: string;
	name?: string;
}

export interface RoomPeerRecord {
	code: string;
	claimed: boolean;
	peer?: RoomPeerIdentity;
	createdAt: string;
	expiresAt: string;
}

export type RendezvousFailure =
	| { kind: "unavailable"; status: number; message: string }
	| { kind: "not-found" }
	| { kind: "forbidden" }
	| { kind: "conflict" }
	| { kind: "throttled" }
	| { kind: "invalid" };

export type RendezvousResult<T> = { ok: true; value: T } | { ok: false; failure: RendezvousFailure };

/** A fresh 32-byte secret in hex. */
export function newRoomSecret(): string {
	return randomBytes(32).toString("hex");
}

function classify(status: number, message: string): RendezvousFailure {
	switch (status) {
		case 404:
			return { kind: "not-found" };
		case 403:
			return { kind: "forbidden" };
		case 409:
			return { kind: "conflict" };
		case 429:
			return { kind: "throttled" };
		case 400:
			return { kind: "invalid" };
		default:
			return { kind: "unavailable", status, message };
	}
}

export class RoomRendezvousClient {
	private readonly baseUrl: string;
	private readonly timeoutMs: number;

	constructor(options: { baseUrl?: string; timeoutMs?: number } = {}) {
		this.baseUrl = (options.baseUrl ?? ROOM_RENDEZVOUS_BASE_URL).replace(/\/+$/, "");
		this.timeoutMs = options.timeoutMs ?? 10_000;
	}

	private async request<T>(path: string, init: RequestInit): Promise<RendezvousResult<T>> {
		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}${path}`, {
				...init,
				headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (error) {
			// A network failure is reported as unavailable rather than thrown: every caller in the
			// room flow has a message to show the person and a way back.
			return { ok: false, failure: { kind: "unavailable", status: 0, message: describe(error) } };
		}
		if (!response.ok) {
			const message = await readError(response);
			return { ok: false, failure: classify(response.status, message) };
		}
		try {
			return { ok: true, value: (await response.json()) as T };
		} catch {
			return { ok: false, failure: { kind: "unavailable", status: response.status, message: "malformed response" } };
		}
	}

	async publish(code: string, secret: string): Promise<RendezvousResult<RoomPeerRecord>> {
		return this.request<RoomPeerRecord>("/api/v1/room/publish", {
			method: "POST",
			body: JSON.stringify({ code, secret }),
		});
	}

	async claim(code: string, identity: RoomPeerIdentity): Promise<RendezvousResult<RoomPeerRecord>> {
		return this.request<RoomPeerRecord>("/api/v1/room/claim", {
			method: "POST",
			body: JSON.stringify({
				code,
				identity: { app_id: identity.appId, open_id: identity.openId, name: identity.name },
			}),
		});
	}

	async status(code: string, secret: string): Promise<RendezvousResult<RoomPeerRecord>> {
		return this.request<RoomPeerRecord>(`/api/v1/room/status?code=${encodeURIComponent(code)}`, {
			method: "GET",
			headers: { "X-Room-Secret": secret },
		});
	}

	async retire(code: string, secret: string): Promise<RendezvousResult<{ retired: boolean }>> {
		return this.request<{ retired: boolean }>("/api/v1/room/retire", {
			method: "POST",
			body: JSON.stringify({ code, secret }),
		});
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function readError(response: Response): Promise<string> {
	try {
		const body: unknown = await response.json();
		if (body && typeof body === "object" && !Array.isArray(body)) {
			const error = (body as Record<string, unknown>).error;
			if (error && typeof error === "object" && !Array.isArray(error)) {
				const message = (error as Record<string, unknown>).message;
				if (typeof message === "string") return message;
			}
		}
	} catch {
		// Fall through to the status text; an unreadable body carries no more information.
	}
	return response.statusText;
}

/** Human-readable reason for a failed rendezvous call, used in terminal notices. */
export function describeFailure(failure: RendezvousFailure): string {
	switch (failure.kind) {
		case "not-found":
			return "房间码不存在或已过期";
		case "forbidden":
			return "房间密钥不匹配";
		case "conflict":
			return "这个房间码已经被别人先一步认领";
		case "throttled":
			return "尝试次数过多，房间码已作废";
		case "invalid":
			return "房间码格式不对";
		default:
			return `会合服务不可用（${failure.status || "网络错误"}）`;
	}
}
