import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { openStepSession } from "../src/step/session.ts";
import { getShellEnv } from "../src/utils/shell.ts";
import { getToolPath } from "../src/utils/tools-manager.ts";

const roots: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Step Pi storage wrapper", () => {
	test("relocates an explicitly opened legacy Pi session before Pi can rewrite it", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-pi-open-wrapper-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const agentDir = join(root, ".stepcode", "agent");
		const sourceDir = join(root, ".pi", "agent", "sessions", "legacy");
		const sourcePath = join(sourceDir, "legacy.jsonl");
		await mkdir(cwd, { recursive: true });
		await mkdir(sourceDir, { recursive: true });
		const sourceContent = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "legacy-session",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
		})}\n`;
		await writeFile(sourcePath, sourceContent);

		const manager = openStepSession(sourcePath, { agentDir });

		expect(manager.getSessionFile()).not.toBe(sourcePath);
		expect(manager.getSessionFile()).toContain(join(agentDir, "sessions"));
		expect(await readFile(sourcePath, "utf8")).toBe(sourceContent);

		manager.appendSessionInfo("legacy copy");
		const copiedPath = manager.getSessionFile();
		if (!copiedPath) throw new Error("expected copied session path");
		expect(await readFile(sourcePath, "utf8")).toBe(sourceContent);
		expect(await readFile(copiedPath, "utf8")).toContain('"name":"legacy copy"');
	});

	test("uses the Step agent root for embedded tool lookups without an explicit argument", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-pi-tool-wrapper-"));
		roots.push(root);
		const agentDir = join(root, ".stepcode", "agent");
		const binaryPath = join(agentDir, "bin", process.platform === "win32" ? "rg.exe" : "rg");
		await mkdir(join(agentDir, "bin"), { recursive: true });
		await writeFile(binaryPath, "placeholder");
		vi.stubEnv("STEP_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("AI_AGENT", "step");

		expect(getToolPath("rg")).toBe(binaryPath);
		const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
		const shellPath = getShellEnv()[pathKey] ?? "";
		expect(shellPath.split(process.platform === "win32" ? ";" : ":")[0]).toBe(join(agentDir, "bin"));
		expect(existsSync(join(root, ".pi"))).toBe(false);
	});
});
