import { describe, expect, it } from "vitest";
import { parseRoomCommand } from "../src/index.ts";

describe("parseRoomCommand", () => {
	it("starts a room when the tail is empty", () => {
		expect(parseRoomCommand("")).toEqual({ kind: "start" });
		expect(parseRoomCommand("   ")).toEqual({ kind: "start" });
	});

	it("reads the code after the join subcommand", () => {
		expect(parseRoomCommand("join 48291730")).toEqual({ kind: "join", code: "48291730" });
		expect(parseRoomCommand("  join   48291730  ")).toEqual({ kind: "join", code: "48291730" });
	});

	it("accepts a bare code so a pasted number still joins", () => {
		expect(parseRoomCommand("48291730")).toEqual({ kind: "join", code: "48291730" });
	});

	it("treats leave and off as leaving", () => {
		expect(parseRoomCommand("leave")).toEqual({ kind: "leave" });
		expect(parseRoomCommand("off")).toEqual({ kind: "leave" });
	});

	it("rejects codes outside the six-to-twelve digit range", () => {
		expect(parseRoomCommand("join 12345")).toEqual({ kind: "invalid", input: "join 12345" });
		expect(parseRoomCommand("join 1234567890123")).toEqual({ kind: "invalid", input: "join 1234567890123" });
		expect(parseRoomCommand("join")).toEqual({ kind: "invalid", input: "join" });
		expect(parseRoomCommand("join abc123")).toEqual({ kind: "invalid", input: "join abc123" });
	});

	it("does not treat an unknown word as a code", () => {
		expect(parseRoomCommand("status")).toEqual({ kind: "invalid", input: "status" });
	});
});
