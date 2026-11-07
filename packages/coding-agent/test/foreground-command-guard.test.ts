import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const workspaces: string[] = [];

function workspace(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "step-foreground-guard-"));
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

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("condition not met before the deadline");
}

afterEach(() => {
	for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A host script that runs one foreground command through the real shell operations, reports the
 * command's child pid, then idles until it is killed.
 *
 * The point is what happens *after* the host dies: a foreground command is spawned detached, so
 * nothing in-process can reclaim it once the host is gone.
 */
function foregroundHostScript(bashModulePath: string, readyPath: string): string {
	// The command writes its own pid, then idles. It runs in the shell's own process group, so
	// nothing in-process can reclaim it once the host is gone.
	const childScript = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(readyPath)},String(process.pid));setInterval(()=>{},1<<30)`;
	return [
		'import { writeFileSync } from "node:fs";',
		`import { createLocalBashOperations } from ${JSON.stringify(bashModulePath)};`,
		"const operations = createLocalBashOperations();",
		`const command = ${JSON.stringify(`${process.execPath} -e ${JSON.stringify(childScript)}`)};`,
		"const running = operations.exec(command, process.cwd(), { onData: () => {} });",
		"void running;",
		"setInterval(() => {}, 1 << 30);",
		"void writeFileSync;",
	].join("\n");
}

describe("foreground command parent-death guard", () => {
	test("a foreground command dies when the host is SIGKILLed", async () => {
		const dir = workspace();
		const ready = path.join(dir, "ready");
		const hostFile = path.join(dir, "host.mts");
		writeFileSync(
			hostFile,
			foregroundHostScript(path.resolve(__dirname, "../src/core/tools/bash.ts"), ready),
			"utf8",
		);

		const host = spawn(process.execPath, ["--import", "tsx", hostFile], {
			stdio: "ignore",
			env: process.env,
		});
		if (host.pid === undefined) throw new Error("host did not start");

		try {
			await waitFor(() => existsSync(ready), 30_000);
			const commandPid = Number.parseInt(readFileSync(ready, "utf8").trim(), 10);
			expect(alive(commandPid)).toBe(true);

			// No shutdown handler runs on SIGKILL: the guard is the only thing that can reclaim it.
			process.kill(host.pid, "SIGKILL");

			await waitFor(() => !alive(commandPid), 20_000);
			expect(alive(commandPid)).toBe(false);
		} finally {
			try {
				process.kill(host.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}, 60_000);
});
