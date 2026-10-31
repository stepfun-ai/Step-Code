import { describe, expect, test } from "vitest";
import { modeReadsPipedStdin, readPipedStdin } from "../src/main.ts";

describe("modeReadsPipedStdin", () => {
	test("RPC and ACP never drain stdin, because stdin is their transport", () => {
		// ACP speaks newline-delimited JSON-RPC on stdin. If startup treated that
		// pipe as a piped prompt it would swallow the protocol stream, and since
		// an ACP client keeps the pipe open for the whole session the read would
		// hang on `end` and the mode would never start.
		expect(modeReadsPipedStdin("acp")).toBe(false);
		expect(modeReadsPipedStdin("rpc")).toBe(false);
	});

	test("every prompt-carrying mode still reads piped stdin", () => {
		expect(modeReadsPipedStdin("print")).toBe(true);
		expect(modeReadsPipedStdin("json")).toBe(true);
		expect(modeReadsPipedStdin("interactive")).toBe(true);
	});
});

describe("readPipedStdin", () => {
	test("a TTY is never read, so an interactive session does not consume the terminal", async () => {
		const original = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		try {
			await expect(readPipedStdin()).resolves.toBeUndefined();
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: original, configurable: true });
		}
	});
});
