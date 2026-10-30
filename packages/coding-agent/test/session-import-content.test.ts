import { describe, expect, it } from "vitest";
import { stripImportedUserControls } from "../src/core/session-import/content.ts";
import { parseForeignSession } from "../src/core/session-import/parsers.ts";
import { sessionEntryToContextMessages } from "../src/core/session-manager.ts";

const wrapped = "<user_query>你好</user_query>";
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");

describe("imported user-query content", () => {
	it("unwraps genuine content after source controls without discarding the request", () => {
		expect(stripImportedUserControls(wrapped)).toEqual({ text: "你好", removed: false });
		expect(stripImportedUserControls(`<system-reminder>control</system-reminder>${wrapped}`)).toEqual({
			text: "你好",
			removed: true,
		});
	});

	it("preserves user examples, nested literal markup, and incomplete wrappers", () => {
		for (const value of [
			"```xml\n<user_query>你好</user_query>\n```",
			"example: <user_query>你好</user_query>",
			"<user_query>unfinished",
		])
			expect(stripImportedUserControls(value).text).toBe(value);
		expect(stripImportedUserControls("<user_query>outer <user_query>inner</user_query></user_query>").text).toBe(
			"outer <user_query>inner</user_query>",
		);
	});

	it.each(["codex", "claude-code", "workbuddy", "qoder"] as const)(
		"cleans %s parsing and old imported continuation context",
		(source) => {
			const records =
				source === "codex"
					? [
							{ type: "session_meta", payload: { id: "s", cwd: "/project" } },
							{
								type: "response_item",
								payload: { type: "message", role: "user", content: [{ type: "input_text", text: wrapped }] },
							},
						]
					: source === "workbuddy"
						? [
								{ type: "session-meta", sessionId: "s" },
								{
									type: "message",
									id: "u",
									sessionId: "s",
									cwd: "/project",
									role: "user",
									content: [{ type: "input_text", text: wrapped }],
								},
							]
						: [
								{
									type: "user",
									uuid: "u",
									sessionId: "s",
									cwd: "/project",
									message: { role: "user", content: wrapped },
								},
							];
			const parsed = parseForeignSession(source, jsonl(records));
			expect(parsed.title).toBe("你好");
			const user = parsed.entries.find((entry) => entry.type === "message" && entry.message.role === "user");
			if (!user || user.type !== "message" || user.message.role !== "user") throw new Error("User entry missing");
			expect(user.message.content).toEqual([{ type: "text", text: "你好" }]);
			const legacy = { ...user, message: { ...user.message, content: wrapped } };
			const original = JSON.stringify(legacy);
			expect(sessionEntryToContextMessages(legacy)[0]).toMatchObject({ role: "user", content: "你好" });
			expect(JSON.stringify(legacy)).toBe(original);
		},
	);
});
