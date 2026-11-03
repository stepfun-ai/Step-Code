import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../../../apps/cli/src/main.ts");

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-stdout-clean-"));
	tempDirs.push(dir);
	return dir;
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const tempRoot = createTempDir();
	const agentDir = join(tempRoot, "agent");
	const projectDir = join(tempRoot, "project");
	const projectConfigDir = join(projectDir, ".stepcode");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectConfigDir, { recursive: true });

	const fakeNpmPath = join(tempRoot, "fake-npm.mjs");
	writeFileSync(
		fakeNpmPath,
		[
			'console.log("changed 1 package in 471ms");',
			'console.log("found 0 vulnerabilities");',
			"process.exit(0);",
		].join("\n"),
		"utf-8",
	);

	// Step reads its settings from config.toml, not settings.json: the CLI builds
	// pi's SettingsManager on StepTomlSettingsStorage. Declaring the package in
	// settings.json here would leave the startup silent and make the assertions
	// below pass for the wrong reason.
	writeFileSync(
		join(projectConfigDir, "config.toml"),
		[
			`packages = [${JSON.stringify("npm:fake-package")}]`,
			`npmCommand = [${JSON.stringify(process.execPath)}, ${JSON.stringify(fakeNpmPath)}]`,
			"",
		].join("\n"),
		"utf-8",
	);

	return await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), cliPath, ...args], {
			cwd: projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({ stdout, stderr, code });
		});
	});
}

describe("stdout cleanliness in non-interactive modes", () => {
	it("prints plain --help to stdout when stdout is redirected", async () => {
		const result = await runCli(["--help"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Usage:");
		expect(result.stderr).not.toContain("Usage:");
		expect(result.stderr).not.toContain("changed 1 package in 471ms");
		expect(result.stderr).not.toContain("found 0 vulnerabilities");
	});

	it("keeps stdout empty for --mode json --help while routing trusted startup chatter to stderr", async () => {
		const result = await runCli(["--mode", "json", "--help", "--approve"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("changed 1 package in 471ms");
		expect(result.stderr).toContain("found 0 vulnerabilities");
		expect(result.stderr).toContain("Usage:");
	});
});
