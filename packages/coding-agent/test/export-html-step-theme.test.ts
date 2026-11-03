import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { exportSessionToHtml } from "../src/core/export-html/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { main } from "../src/main.ts";
import { initTheme } from "../src/theme/theme.ts";
import { assistantMsg } from "./utilities.ts";

describe("Step HTML export theme", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const tempDir of tempDirs.splice(0)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		initTheme("dark");
	});

	test("uses the active Step palette for Markdown inside the themed user message bar", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "step-theme-export-"));
		tempDirs.push(tempDir);
		const session = SessionManager.create(tempDir, tempDir, { id: "step-theme" });
		session.appendMessage({
			role: "user",
			content: "# Heading\n\n`inline`\n\n```ts\nexport function greet() {}\n```",
			timestamp: 1,
		});
		session.appendMessage(assistantMsg("ok"));
		const outputPath = join(tempDir, "session.html");

		await exportSessionToHtml(session, undefined, { outputPath, themeName: "step-blue" });

		const html = readFileSync(outputPath, "utf8");
		expect(html).toContain("--userMdHeading: #e8e8ea;");
		expect(html).toContain("--userSyntaxKeyword: #e08fdf;");
		expect(html).toContain("--mdCode: #68c0ff;");
		expect(html).toContain("--codeInlineBg: transparent;");
		expect(html).toContain("--customMessageBg: transparent;");
		expect(html).toContain("--toolSuccessBg: transparent;");
		expect(html).toContain("--userMessageBg: #3d3b39;");
		expect(html).toMatch(/\.markdown-content code\s*\{[^}]*background:\s*var\(--codeInlineBg, transparent\);/s);
		expect(html).toMatch(/\.user-message\s*\{[^}]*--mdHeading:\s*var\(--userMdHeading\);/s);
		expect(html).toMatch(/\.user-message\s*\{[^}]*--syntaxKeyword:\s*var\(--userSyntaxKeyword\);/s);
	});

	test("uses the active user palette when exporting the active Step theme", async () => {
		initTheme("step-blue");
		const tempDir = mkdtempSync(join(tmpdir(), "step-theme-export-"));
		tempDirs.push(tempDir);
		const session = SessionManager.create(tempDir, tempDir, { id: "active-step-theme" });
		session.appendMessage({ role: "user", content: "# Heading", timestamp: 1 });
		session.appendMessage(assistantMsg("ok"));
		const outputPath = join(tempDir, "session.html");

		await exportSessionToHtml(session, undefined, { outputPath });

		const html = readFileSync(outputPath, "utf8");
		expect(html).toContain("--mdHeading: #e8e8ea;");
		expect(html).toContain("--userMdHeading: #e8e8ea;");
	});

	test("resolves the Step product default theme for non-interactive CLI export", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "step-theme-export-"));
		tempDirs.push(tempDir);
		const session = SessionManager.create(tempDir, tempDir, { id: "stepcode-export-theme" });
		session.appendMessage({ role: "user", content: "# Heading", timestamp: 1 });
		session.appendMessage(assistantMsg("ok"));
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const outputPath = join(tempDir, "session.html");
		const exit = vi.spyOn(process, "exit").mockImplementation((code): never => {
			throw new Error(`process.exit:${code}`);
		});
		vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(
			main(["--export", sessionFile, outputPath], {
				agentDir: join(tempDir, "agent"),
				defaultTheme: "step-blue",
			}),
		).rejects.toThrow("process.exit:0");

		expect(exit).toHaveBeenCalledWith(0);
		const html = readFileSync(outputPath, "utf8");
		expect(html).toContain("--userMdHeading: #e8e8ea;");
	});
});
