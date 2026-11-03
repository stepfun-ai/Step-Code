import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { assistantMsg } from "./utilities.ts";

describe("export input==output guard", () => {
	const tempDirs: string[] = [];
	const cwd = process.cwd();

	afterEach(() => {
		process.chdir(cwd);
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeSession(): { sessionFile: string; original: string } {
		const tempDir = mkdtempSync(join(tmpdir(), "export-guard-"));
		tempDirs.push(tempDir);
		const session = SessionManager.create(tempDir, tempDir, { id: "export-guard" });
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(assistantMsg("world"));
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		return { sessionFile, original: readFileSync(sessionFile, "utf8") };
	}

	// Exact repro of `step --export session.jsonl session.jsonl`: both tokens are the same
	// relative path, so the input resolves absolute while the output stays relative — a naive
	// string compare would miss the collision, but canonicalizing both catches it.
	test("refuses to overwrite the source session and preserves it", async () => {
		const { sessionFile, original } = makeSession();
		process.chdir(dirname(sessionFile));
		const relative = basename(sessionFile);

		await expect(exportFromFile(relative, { outputPath: relative })).rejects.toThrow(
			/Refusing to overwrite the input session file/,
		);
		expect(readFileSync(sessionFile, "utf8")).toBe(original);
	});

	test("still exports to a distinct output path and leaves the source intact", async () => {
		const { sessionFile, original } = makeSession();
		const outputPath = join(dirname(sessionFile), "out.html");

		await exportFromFile(sessionFile, { outputPath });

		expect(existsSync(outputPath)).toBe(true);
		expect(readFileSync(outputPath, "utf8")).toContain("<!DOCTYPE html>");
		expect(readFileSync(sessionFile, "utf8")).toBe(original);
	});

	// Regression: a hardlink to the session file has a distinct pathname (so realpath does
	// not collapse it, and the canonical-path compare passes) but shares the session's inode.
	// The export write (O_TRUNC) would truncate that shared inode and destroy the session, so
	// the device+inode check must reject it.
	test("refuses to overwrite a hardlink that shares the session file's inode", async () => {
		const { sessionFile, original } = makeSession();
		const hardlink = join(dirname(sessionFile), "out.html");
		linkSync(sessionFile, hardlink);

		await expect(exportFromFile(sessionFile, { outputPath: hardlink })).rejects.toThrow(
			/Refusing to overwrite the input session file/,
		);
		expect(readFileSync(sessionFile, "utf8")).toBe(original);
		expect(readFileSync(hardlink, "utf8")).toBe(original);
	});
});
