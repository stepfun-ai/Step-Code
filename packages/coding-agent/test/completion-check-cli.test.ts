import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
// test.sh and CI build workspace entrypoints before running tests. Exercise that
// CLI without recompiling its complete TypeScript graph for every isolated fixture.
const cli = fileURLToPath(new URL("../../../apps/cli/dist/main.js", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/completion-check-provider.ts", import.meta.url));

function runCli(flags: string[], repository: boolean) {
	const root = mkdtempSync(join(tmpdir(), "completion-cli-"));
	roots.push(root);
	const cwd = join(root, "worktree");
	mkdirSync(cwd);
	if (repository) {
		const git = (...args: string[]) =>
			execFileSync(
				"git",
				[
					"-c",
					"user.name=Completion Test",
					"-c",
					"user.email=completion@example.invalid",
					"-c",
					"commit.gpgsign=false",
					...args,
				],
				{ cwd, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] },
			);
		git("init", "--quiet", "--template=");
		writeFileSync(join(cwd, "source.txt"), "base\n");
		git("add", "source.txt");
		git("commit", "--quiet", "-m", "base");
	}
	const callLog = join(root, "model-calls");
	// A fresh child environment prevents credentials, preloads, user config and
	// network provider settings from turning these tests into a paid model run.
	const env: NodeJS.ProcessEnv = {
		HOME: root,
		USERPROFILE: root,
		XDG_CONFIG_HOME: join(root, ".config"),
		XDG_CACHE_HOME: join(root, ".cache"),
		STEP_CODING_AGENT_DIR: join(root, "config", "agent"),
		STEPCODE_STORAGE_ROOT_DIR: join(root, "storage"),
		STEP_NO_LOCAL_LLM: "1",
		AWS_EC2_METADATA_DISABLED: "true",
		NODE_ENV: "test",
		FORCE_COLOR: "0",
		COMPLETION_CHECK_CALL_LOG: callLog,
		// Keep child runtime caches in the fixture as well as the outer test temp root.
		TMPDIR: root,
		// A temporary directory may be inside the enclosing source checkout.
		GIT_CEILING_DIRECTORIES: root,
	};
	for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	// --no-tools leaves MCP initialization enabled. Keep this provider fixture
	// offline by explicitly disabling the built-in server in its isolated config.
	mkdirSync(join(root, "config"), { recursive: true });
	writeFileSync(join(root, "config", "config.toml"), "[mcp_servers.steppage__steppage]\nenabled = false\n");
	const result = spawnSync(
		process.execPath,
		[
			cli,
			"--provider",
			"completion-offline",
			"--model",
			"faux-1",
			"--api-key",
			"offline-test-key",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-session",
			"--no-update-check",
			"-e",
			fixture,
			...flags,
			"task",
		],
		{ cwd, env, encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024 },
	);
	const calls = existsSync(callLog) ? readFileSync(callLog, "utf8").trim().split("\n").length : 0;
	return { ...result, calls };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("real CLI completion-check dispatch with an offline provider", () => {
	it("forwards both flags and retains valid failed-task exit 0 after the configured bound", () => {
		const result = runCli(["-p", "--completion-check", "git-committed", "--completion-check-attempts", "1"], true);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.calls).toBe(2);
		expect(result.stdout).toBe("CLI offline final\n");
		expect(result.stderr).toContain("Completion check incomplete after 1 follow-up(s).");
		expect(result.stderr).not.toContain("steppage");
	});

	it("records both tree and commit checks in JSON with the default two follow-ups", () => {
		const result = runCli(["--mode", "json", "--completion-check=git-committed"], true);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.calls).toBe(3);
		const checks = result.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((event) => event.type === "completion_check");
		expect(checks).toHaveLength(3);
		for (const check of checks) {
			expect(check).not.toHaveProperty("review");
			expect(check).not.toHaveProperty("followUpKind");
		}
		expect(checks.at(-1)).toMatchObject({
			hasNewCommit: false,
			hasCommittedChanges: false,
			status: "exhausted",
			willFollowUp: false,
		});
	});

	it("forwards review and combines it with repair within the existing two-prompt budget", () => {
		const result = runCli(["--mode", "json", "--completion-check=git-committed", "--completion-review"], true);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.calls).toBe(3);
		const events = result.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const checks = events.filter((event) => event.type === "completion_check");
		expect(checks.map((event) => [event.attempt, event.status, event.followUpKind, event.review])).toEqual([
			[0, "follow_up", "review", { requested: true, sent: false }],
			[0, "follow_up", "review", { requested: true, sent: true }],
			[1, "follow_up", "completion", { requested: true, sent: true }],
			[2, "exhausted", undefined, { requested: true, sent: true }],
		]);
		const users = events.filter((event) => event.type === "message_end" && event.message.role === "user");
		expect(users).toHaveLength(3);
		expect(JSON.stringify(users[1])).toContain("Final self-review:");
		expect(JSON.stringify(users[1])).toContain("no new commit since the starting HEAD");
		expect(JSON.stringify(users[2])).not.toContain("Final self-review:");
		expect(result.stderr).toContain("Completion check incomplete after 2 follow-up(s).");
	});

	it("rejects review without the checker before invoking the provider", () => {
		const result = runCli(["-p", "--completion-review"], false);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(1);
		expect(result.calls).toBe(0);
		expect(result.stderr).toContain("--completion-review requires --completion-check git-committed");
	});

	it("fails a non-repository before the provider is invoked", () => {
		const result = runCli(["-p", "--completion-check", "git-committed"], false);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(1);
		expect(result.calls).toBe(0);
		expect(result.stderr).toContain("existing HEAD commit");
		expect(result.stdout).toBe("");
	});

	it("keeps default-off CLI behavior independent of Git", () => {
		const result = runCli(["-p"], false);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.calls).toBe(1);
		expect(result.stdout).toBe("CLI offline final\n");
	});

	it.each([
		["--completion-check-attempts", "4"],
		["--mode", "rpc"],
		["--sdk-stdio"],
		["--completion-review", "--completion-check-attempts", "4"],
		["--completion-review", "--mode", "rpc"],
		["--completion-review", "--sdk-stdio"],
		["--completion-review=true"],
	])("rejects invalid CLI options before the provider is invoked: %j", (...invalid) => {
		const result = runCli(["--completion-check", "git-committed", ...invalid], false);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(1);
		expect(result.calls).toBe(0);
		expect(result.stderr).toContain("--completion-");
	});
});
