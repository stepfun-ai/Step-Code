import { describe, expect, it } from "vitest";
import { RoomCodeBook } from "../src/index.ts";

function book(options: { ttlMs?: number; now?: () => number; digits?: string } = {}) {
	let clock = 0;
	let call = 0;
	const digits = options.digits ?? "12345678";
	return {
		codes: new RoomCodeBook({
			ttlMs: options.ttlMs ?? 120_000,
			now: () => clock,
			randomDigits: (length) => {
				const offset = call++;
				return `${offset}${digits}`.slice(-length).padStart(length, "0");
			},
		}),
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

describe("room codes", () => {
	it("issues a code that can be claimed once", () => {
		const { codes } = book();
		const code = codes.issue("room-1");
		expect(code).toHaveLength(8);
		expect(codes.claim(code)).toEqual({ status: "accepted", roomId: "room-1" });
		expect(codes.claim(code)).toEqual({ status: "already-used" });
	});

	it("rejects a code after its lifetime", () => {
		const { codes, advance } = book({ ttlMs: 1_000 });
		const code = codes.issue("room-1");
		advance(1_001);
		expect(codes.claim(code)).toEqual({ status: "expired" });
	});

	it("keeps a code valid right up to its deadline", () => {
		const { codes, advance } = book({ ttlMs: 1_000 });
		const code = codes.issue("room-1");
		advance(1_000);
		expect(codes.claim(code)).toEqual({ status: "accepted", roomId: "room-1" });
	});

	it("burns the room's code after repeated wrong guesses", () => {
		const { codes } = book();
		const code = codes.issue("room-1");
		codes.recordFailure("room-1");
		expect(codes.isPending(code)).toBe(true);
		codes.recordFailure("room-1");
		codes.recordFailure("room-1");
		expect(codes.isPending(code)).toBe(false);
		expect(codes.claim(code)).toEqual({ status: "not-found" });
	});

	it("does not let guesses at one room burn another room", () => {
		let call = 0;
		const codes = new RoomCodeBook({
			now: () => 0,
			randomDigits: (length) => `${++call}`.padStart(length, "0"),
		});
		const roomA = codes.issue("room-a");
		const roomB = codes.issue("room-b");
		expect(roomA).not.toBe(roomB);
		for (let attempt = 0; attempt < 5; attempt++) codes.recordFailure("room-a");
		expect(codes.claim(roomB)).toEqual({ status: "accepted", roomId: "room-b" });
		expect(codes.isPending(roomA)).toBe(false);
	});

	it("reports unknown codes without revealing anything", () => {
		const { codes } = book();
		expect(codes.claim("00000000")).toEqual({ status: "not-found" });
	});

	it("refuses codes shorter than the floor", () => {
		const { codes } = book();
		expect(() => codes.issue("room-1", 5)).toThrow("at least 6 digits");
		expect(() => new RoomCodeBook({ minLength: 4 })).toThrow("at least six digits");
	});

	it("replaces an earlier code for the same room", () => {
		let call = 0;
		const codes = new RoomCodeBook({ randomDigits: (length) => `${++call}`.padStart(length, "0") });
		const first = codes.issue("room-1");
		const second = codes.issue("room-1");
		expect(second).not.toBe(first);
		expect(codes.claim(first)).toEqual({ status: "not-found" });
		expect(codes.claim(second)).toEqual({ status: "accepted", roomId: "room-1" });
	});

	it("revokes a room's code on leave", () => {
		const { codes } = book();
		const code = codes.issue("room-1");
		codes.revoke("room-1");
		expect(codes.claim(code)).toEqual({ status: "not-found" });
	});

	it("fails loudly instead of spinning on a constant random source", () => {
		const codes = new RoomCodeBook({ randomDigits: () => "11111111" });
		codes.issue("room-1");
		expect(() => codes.issue("room-2")).toThrow("could not allocate a unique room code");
	});
});
