import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * A transcript has to exist as soon as it holds something a reader would miss.
 * It used to start with the first assistant reply, so a host that stopped while
 * the first turn streamed lost the prompt with the never-written file.
 */
describe("SessionManager first-prompt persistence", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-first-prompt-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function records(path: string): Array<{ type?: string; message?: { role?: string; content?: unknown } }> {
		return readFileSync(path, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	}

	it("writes the header and the prompt before any assistant reply", () => {
		const session = SessionManager.create(tempDir, tempDir);
		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(false);

		session.appendModelChange("anthropic", "claude-test");
		session.appendMessage({ role: "user", content: "first question", timestamp: Date.now() });

		expect(existsSync(sessionFile!)).toBe(true);
		const written = records(sessionFile!);
		expect(written.filter((entry) => entry.type === "session")).toHaveLength(1);
		expect(written.some((entry) => entry.type === "message" && entry.message?.role === "user")).toBe(true);
	});

	it("still writes nothing for a session that only recorded settings", () => {
		const session = SessionManager.create(tempDir, tempDir);
		const sessionFile = session.getSessionFile();
		session.appendModelChange("anthropic", "claude-test");
		session.appendThinkingLevelChange("high");
		expect(existsSync(sessionFile!)).toBe(false);
	});

	it("appends the reply to the file the prompt created, without a second header", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage({ role: "user", content: "first question", timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const written = records(session.getSessionFile()!);
		expect(written.filter((entry) => entry.type === "session")).toHaveLength(1);
		expect(written.filter((entry) => entry.type === "message")).toHaveLength(2);
	});

	it("reloads a prompt-only transcript as a resumable session", () => {
		const created = SessionManager.create(tempDir, tempDir);
		const sessionFile = created.getSessionFile()!;
		created.appendMessage({ role: "user", content: "unanswered question", timestamp: Date.now() });

		const reopened = SessionManager.open(sessionFile, tempDir, tempDir);
		const branch = reopened.getBranch();
		expect(branch).toHaveLength(1);
		expect(branch[0]?.type === "message" && branch[0].message.role).toBe("user");
	});
});
