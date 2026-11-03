import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFindToolDefinition } from "../../../src/core/tools/find.ts";
import { getToolPath } from "../../../src/utils/tools-manager.ts";

/**
 * The fd backend inherited the host process cwd. fd resolves its own cwd for
 * --full-path, which is enabled for any pattern containing `/`, so a host whose
 * cwd had been removed failed every path glob with "Could not determine current
 * directory" even though the search path itself was absolute and valid.
 */
describe("find with a removed host cwd", () => {
	const originalCwd = process.cwd();
	let tempRoot: string;
	let searchRoot: string;
	let agentDir: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "step-find-dead-cwd-"));
		searchRoot = join(tempRoot, "search");
		agentDir = join(tempRoot, "agent");
		mkdirSync(join(searchRoot, "src", "nested"), { recursive: true });
		mkdirSync(agentDir);
		writeFileSync(join(searchRoot, "src", "nested", "example.spec.ts"), "");
		writeFileSync(join(searchRoot, "AGENTS.md"), "");
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(tempRoot, { recursive: true, force: true });
	});

	// Skip rather than let ensureTool download fd during a unit test.
	it.skipIf(getToolPath("fd") === null)("matches path globs through fd", async () => {
		const removedCwd = join(tempRoot, "removed-host-cwd");
		mkdirSync(removedCwd);
		process.chdir(removedCwd);
		rmSync(removedCwd, { recursive: true });

		const def = createFindToolDefinition(searchRoot, { agentDir });
		const ctx = {} as Parameters<typeof def.execute>[4];
		const run = async (pattern: string) =>
			(await def.execute("call-1", { pattern }, undefined, undefined, ctx)) as {
				content: Array<{ type: string; text?: string }>;
				details?: { backend?: string; files?: string[] };
			};

		const pathGlob = await run("src/**/*.spec.ts");
		expect(pathGlob.details?.backend).toBe("fd");
		expect(pathGlob.details?.files).toEqual(["src/nested/example.spec.ts"]);

		const leadingGlob = await run("**/AGENTS.md");
		expect(leadingGlob.details?.files).toEqual(["AGENTS.md"]);
	});
});
