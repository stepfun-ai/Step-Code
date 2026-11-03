import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { processFileArguments } from "../src/cli/file-processor.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	vi.restoreAllMocks();
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "step-atfile-"));
	tempDirs.push(dir);
	return dir;
}

describe("processFileArguments baseDir", () => {
	test("relative @file paths resolve against baseDir, not the launcher cwd", async () => {
		const target = makeTempDir();
		writeFileSync(join(target, "note.md"), "hello from target", "utf-8");

		const result = await processFileArguments(["note.md"], { baseDir: target, autoResizeImages: false });

		expect(result.text).toContain("hello from target");
	});

	test("absolute @file paths ignore baseDir", async () => {
		const target = makeTempDir();
		const absolute = join(target, "abs.md");
		writeFileSync(absolute, "absolute content", "utf-8");

		const result = await processFileArguments([absolute], { baseDir: makeTempDir(), autoResizeImages: false });

		expect(result.text).toContain("absolute content");
	});

	test("a missing relative file reports the baseDir-resolved path and exits", async () => {
		const base = makeTempDir();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		// Throwing mirrors the real control flow: the mocked exit never returns.
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as never);

		await expect(processFileArguments(["missing.md"], { baseDir: base, autoResizeImages: false })).rejects.toThrow(
			"process.exit",
		);

		expect(exitSpy).toHaveBeenCalledWith(1);
		const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(stderr).toContain(resolve(base, "missing.md"));
	});
});
