import { describe, expect, test } from "vitest";
import { convertMcpCallResult } from "../src/step/mcp.ts";

describe("convertMcpCallResult", () => {
	test("passes image blocks through alongside text", () => {
		const result = convertMcpCallResult("playwright", "browser_take_screenshot", {
			content: [
				{ type: "text", text: "Took a screenshot" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
		});
		expect(result.content).toEqual([
			{ type: "text", text: "Took a screenshot" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		]);
	});

	test("an image-only result gets a short note instead of a base64 JSON dump", () => {
		const result = convertMcpCallResult("playwright", "browser_take_screenshot", {
			content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
		});
		expect(result.content[0]).toEqual({ type: "text", text: "(see attached image)" });
		expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
	});

	test("keeps the JSON fallback for image-free structured results", () => {
		const result = convertMcpCallResult("server", "tool", { structuredContent: { ok: true } });
		expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ ok: true }) }]);
	});

	test("ignores malformed image blocks without data or mimeType", () => {
		const result = convertMcpCallResult("server", "tool", {
			content: [
				{ type: "text", text: "hello" },
				{ type: "image", data: "" },
				{ type: "image", mimeType: "image/png" },
			],
		});
		expect(result.content).toEqual([{ type: "text", text: "hello" }]);
	});

	test("throws the joined text of isError results", () => {
		expect(() =>
			convertMcpCallResult("server", "tool", { isError: true, content: [{ type: "text", text: "nope" }] }),
		).toThrow("nope");
		expect(() => convertMcpCallResult("server", "broken", { isError: true })).toThrow("MCP tool 'broken' failed.");
	});
});
