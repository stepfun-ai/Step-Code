import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { currentStepInvocation } from "../src/features/subagent/helpers.ts";

const originalArgv = process.argv;
const originalExecArgv = process.execArgv;
const fixture = fileURLToPath(new URL("./fixtures/subagent-source-invocation.ts", import.meta.url));
const cliPath = fileURLToPath(new URL("../../../apps/cli/src/main.ts", import.meta.url));
const tsconfig = fileURLToPath(new URL("../../../tsconfig.json", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
	process.argv = originalArgv;
	process.execArgv = originalExecArgv;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a source-launched subagent starts the real CLI from a different working directory", () => {
	const cwd = mkdtempSync(join(tmpdir(), "step-source-child-"));
	tempDirs.push(cwd);
	// Even --help initializes auth and model discovery. Keep direct test runs
	// independent of the developer's credentials, config, and Node preloads.
	const env: NodeJS.ProcessEnv = {
		HOME: cwd,
		USERPROFILE: cwd,
		XDG_CONFIG_HOME: join(cwd, ".config"),
		XDG_CACHE_HOME: join(cwd, ".cache"),
		TMPDIR: cwd,
		TMP: cwd,
		TEMP: cwd,
		STEP_CODING_AGENT_DIR: join(cwd, "agent"),
		STEP_NO_LOCAL_LLM: "1",
		AWS_EC2_METADATA_DISABLED: "true",
		NODE_OPTIONS: "--no-node-snapshot",
	};
	for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	const options = { cwd, env, encoding: "utf8" as const, timeout: 25_000 };
	const launcher = [fileURLToPath(import.meta.resolve("tsx/cli")), "--tsconfig", tsconfig];
	// Positive control: the source CLI itself works without built workspace packages.
	const parent = spawnSync(process.execPath, [...launcher, cliPath, "--help"], options);
	expect(parent.error).toBeUndefined();
	expect(parent.status, parent.stderr).toBe(0);
	expect(parent.stdout).toContain("Usage:");

	// This used to lose tsx's --require/--import hooks and fail with
	// ERR_MODULE_NOT_FOUND for @step-harness/config/dist/index.js.
	const child = spawnSync(process.execPath, [...launcher, fixture, "--help"], options);
	expect(child.error).toBeUndefined();
	expect(child.status, child.stderr).toBe(0);
	expect(child.stdout).toContain("Usage:");
}, 60_000);

test("preserves ordered preload hooks without forwarding debugger or parent execution modes", () => {
	process.argv = [process.execPath, fixture];
	process.execArgv = [
		"--inspect=127.0.0.1:9229",
		"--require",
		"/source with spaces/preflight.cjs",
		"--import",
		"file:///source%20with%20spaces/loader.mjs",
		"--loader",
		"/source/custom-loader.mjs",
		"--experimental-loader",
		"/source/legacy-loader.mjs",
		"-r",
		"/source/register.cjs",
		"--eval",
		"parentOnly()",
		"--test",
	];
	const args = ["--mode", "rpc", "--session-id", "workflow-child"];
	expect(currentStepInvocation(args)).toEqual({
		command: process.execPath,
		args: [
			"--require",
			"/source with spaces/preflight.cjs",
			"--import",
			"file:///source%20with%20spaces/loader.mjs",
			"--loader",
			"/source/custom-loader.mjs",
			"--experimental-loader",
			"/source/legacy-loader.mjs",
			"-r",
			"/source/register.cjs",
			fixture,
			...args,
		],
	});
	expect(args).toEqual(["--mode", "rpc", "--session-id", "workflow-child"]);
});

test("preserves equals and compact preload options as individual arguments", () => {
	process.argv = [process.execPath, fixture];
	process.execArgv = [
		"--require=/source/preflight.cjs",
		"--import=file:///source/loader.mjs",
		"--loader=/source/custom-loader.mjs",
		"--experimental-loader=/source/legacy-loader.mjs",
		"-r/source/register.cjs",
		"--inspect-brk",
	];
	expect(currentStepInvocation(["--help"]).args).toEqual([
		"--require=/source/preflight.cjs",
		"--import=file:///source/loader.mjs",
		"--loader=/source/custom-loader.mjs",
		"--experimental-loader=/source/legacy-loader.mjs",
		"-r/source/register.cjs",
		fixture,
		"--help",
	]);
});

test("keeps plain Node and virtual Bun entry selection independent of loader flags", () => {
	process.argv = [process.execPath, fixture];
	process.execArgv = ["--inspect", "--expose-gc"];
	expect(currentStepInvocation(["--help"])).toEqual({ command: process.execPath, args: [fixture, "--help"] });

	process.argv = [process.execPath, "/$bunfs/root/step.js"];
	process.execArgv = ["--import", "/source/loader.mjs"];
	expect(currentStepInvocation(["--help"])).toEqual({ command: "step", args: ["--help"] });
});
