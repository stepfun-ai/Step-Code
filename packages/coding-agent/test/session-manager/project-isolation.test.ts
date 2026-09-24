import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { StepSessionManager } from "../../src/step/session.ts";

describe("colliding default session directories", () => {
	let root: string;
	let projectA: string;
	let projectB: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "session-project-isolation-"));
		projectA = join(root, "project-a");
		projectB = join(root, "project", "a");
		vi.stubEnv("STEP_CODING_AGENT_DIR", join(root, "agent"));
		vi.stubEnv("STEP_CODING_AGENT_SESSION_DIR", undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	function persistHeader(manager: SessionManager, modified: number): string {
		const file = manager.getSessionFile()!;
		writeFileSync(file, `${JSON.stringify(manager.getHeader())}\n`);
		utimesSync(file, modified, modified);
		return file;
	}

	for (const [name, manager] of [
		["native", SessionManager],
		["Step", StepSessionManager],
	] as const) {
		it.each([false, true])(`${name}: scopes list and continue with explicit directory=%s`, async (explicit) => {
			const a = manager.create(projectA);
			const b = manager.create(projectB);
			expect(a.getSessionDir()).toBe(b.getSessionDir());
			const fileA = persistHeader(a, 1);
			const fileB = persistHeader(b, 2);
			const beforeB = readFileSync(fileB, "utf8");
			const dir = explicit ? a.getSessionDir() : undefined;

			expect.soft((await manager.list(projectA, dir)).map((session) => session.path)).toEqual([fileA]);
			const continued = manager.continueRecent(projectA, dir);
			expect.soft(continued.getSessionFile()).toBe(fileA);
			continued.appendMessage({ role: "user", content: "project A only", timestamp: 1 });
			expect.soft(readFileSync(fileB, "utf8")).toBe(beforeB);
			expect((await manager.listAll(a.getSessionDir())).map((session) => session.path).sort()).toEqual(
				[fileA, fileB].sort(),
			);
		});

		it(`${name}: starts fresh when only the other project has a session`, async () => {
			const b = manager.create(projectB);
			const fileB = persistHeader(b, 1);
			expect.soft(await manager.list(projectA)).toEqual([]);
			const continued = manager.continueRecent(projectA);
			expect.soft(continued.getSessionFile()).not.toBe(fileB);
			expect(continued.getSessionId()).not.toBe(b.getSessionId());
		});
	}
});
