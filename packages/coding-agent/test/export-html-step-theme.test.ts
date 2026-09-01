import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { exportSessionToHtml } from "../src/core/export-html/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { assistantMsg } from "./utilities.ts";

describe("Step HTML export theme", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		initTheme("dark");
	});

	test("uses the light Step palette for Markdown inside the light user message bar", async () => {
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

		await exportSessionToHtml(session, undefined, { outputPath, themeName: "step" });

		const html = readFileSync(outputPath, "utf8");
		expect(html).toContain("--userMdHeading: #5b21b6;");
		expect(html).toContain("--userSyntaxKeyword: #a21caf;");
		expect(html).toMatch(/\.user-message\s*\{[^}]*--mdHeading:\s*var\(--userMdHeading\);/s);
		expect(html).toMatch(/\.user-message\s*\{[^}]*--syntaxKeyword:\s*var\(--userSyntaxKeyword\);/s);
	});

	test("uses the paired user palette when exporting the active Step theme", async () => {
		initTheme("step");
		const tempDir = mkdtempSync(join(tmpdir(), "step-theme-export-"));
		tempDirs.push(tempDir);
		const session = SessionManager.create(tempDir, tempDir, { id: "active-step-theme" });
		session.appendMessage({ role: "user", content: "# Heading", timestamp: 1 });
		session.appendMessage(assistantMsg("ok"));
		const outputPath = join(tempDir, "session.html");

		await exportSessionToHtml(session, undefined, { outputPath });

		const html = readFileSync(outputPath, "utf8");
		expect(html).toContain("--mdHeading: #ab9eff;");
		expect(html).toContain("--userMdHeading: #5b21b6;");
	});
});
