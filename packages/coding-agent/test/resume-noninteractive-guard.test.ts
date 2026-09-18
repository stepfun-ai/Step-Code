import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { main } from "../src/main.ts";

// Regression: `step --resume </dev/null` (or with -p / piped stdout) used to open the
// interactive session selector in a non-interactive run, which can never receive a
// selection and hung until killed. It must now reject with a non-zero exit instead.
describe("non-interactive --resume guard", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects a bare --resume when there is no terminal", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "resume-guard-"));
		tempDirs.push(tempDir);
		const exit = vi.spyOn(process, "exit").mockImplementation((code): never => {
			throw new Error(`process.exit:${code}`);
		});
		const errors: string[] = [];
		vi.spyOn(console, "error").mockImplementation((chunk: unknown) => {
			errors.push(String(chunk));
		});

		// Vitest runs with stdin/stdout detached, so resolveAppMode yields "print".
		await expect(main(["--resume"], { agentDir: join(tempDir, "agent") })).rejects.toThrow("process.exit:1");
		expect(exit).toHaveBeenCalledWith(1);
		expect(errors.join("\n")).toContain("--resume opens an interactive session selector");
	});
});
