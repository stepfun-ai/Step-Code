import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const workspaces: string[] = [];
const spawned: number[] = [];

function workspace(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "step-parent-guard-"));
	workspaces.push(dir);
	return dir;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		const state = execFileSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" }).trim();
		return !state.startsWith("Z");
	} catch {
		return false;
	}
}

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("condition not met before the deadline");
}

afterEach(() => {
	// Kill the pid itself as well as its group: the host is spawned without `detached`, so its pid
	// is not a process-group id and `kill(-pid)` would miss it — leaving a host running for as long
	// as the test run, which is exactly the leak this suite exists to prevent.
	for (const pid of spawned.splice(0)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Not a group leader, or already gone.
		}
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A host script that arms the guard for a long-lived child and then reports the child's pid.
 *
 * The child ignores `SIGTERM`, so a passing test can only be the supervisor's `SIGKILL`
 * escalation: a `SIGTERM`-only cleanup would leave it alive and fail the assertion.
 *
 * The host deliberately never disarms and never shuts down: the test kills it with SIGKILL, which is
 * the case no in-process handler can cover.
 */
function guardedHostScript(guardModulePath: string, readyPath: string): string {
	return [
		'import { spawn } from "node:child_process";',
		'import { writeFileSync } from "node:fs";',
		`import { armParentDeathGuard } from ${JSON.stringify(guardModulePath)};`,
		'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1 << 30)"], { stdio: "ignore", detached: true });',
		"child.unref();",
		"const guard = armParentDeathGuard(child.pid, 300);",
		"if (!guard) throw new Error('guard unavailable');",
		"await guard.ready;",
		`writeFileSync(${JSON.stringify(readyPath)}, String(child.pid));`,
		"setInterval(() => {}, 1 << 30);",
	].join("\n");
}

describe("parent-death guard", () => {
	test("reclaims an armed child when the host is SIGKILLed", async () => {
		const dir = workspace();
		const ready = path.join(dir, "ready");
		const hostScript = guardedHostScript(path.resolve(__dirname, "../src/utils/parent-death-guard.ts"), ready);
		const hostFile = path.join(dir, "host.mts");
		writeFileSync(hostFile, hostScript, "utf8");

		// Run the host with `node` directly, not through `tsx`: a tsx wrapper would be the process to
		// kill, and the guard's lease belongs to the process that awaits `ready` in the script.
		const host = spawn(process.execPath, ["--import", "tsx", hostFile], {
			stdio: "ignore",
			env: process.env,
		});
		if (host.pid === undefined) throw new Error("host did not start");
		spawned.push(host.pid);

		await waitFor(() => existsSync(ready), 30_000);
		const childPid = Number.parseInt(readFileSync(ready, "utf8").trim(), 10);
		spawned.push(childPid);
		// The guard must be armed for a live process: otherwise this test would pass by the child
		// simply failing to start, and prove nothing about reclamation.
		expect(alive(childPid)).toBe(true);

		// The whole point: no shutdown handler runs on SIGKILL.
		process.kill(host.pid, "SIGKILL");

		await waitFor(() => !alive(childPid), 20_000);
		expect(alive(childPid)).toBe(false);
	}, 60_000);

	test("a disarm keeps a normally exited child from being reported", async () => {
		const dir = workspace();
		const childScript = path.join(dir, "child.mjs");
		const childReady = path.join(dir, "child-ready");
		const armed = path.join(dir, "armed");
		writeFileSync(
			childScript,
			[
				'import { writeFileSync } from "node:fs";',
				`import { armParentDeathGuard } from ${JSON.stringify(
					path.resolve(__dirname, "../src/utils/parent-death-guard.ts"),
				)};`,
				"const guard = armParentDeathGuard(process.pid, 300);",
				"if (!guard) throw new Error('guard unavailable');",
				"await guard.ready;",
				`writeFileSync(${JSON.stringify(childReady)}, "ready");`,
				`writeFileSync(${JSON.stringify(armed)}, "armed");`,
				// Disarm, then exit normally: the supervisor must not signal this pid.
				"await guard.disarm();",
				"process.exit(0);",
			].join("\n"),
			"utf8",
		);
		const run = spawn(process.execPath, ["--import", "tsx", childScript], {
			stdio: "ignore",
			env: process.env,
		});
		const code = await new Promise<number | null>((resolve) => run.once("exit", resolve));
		expect(code).toBe(0);
		expect(alive(run.pid as number)).toBe(false);
	}, 30_000);
});
