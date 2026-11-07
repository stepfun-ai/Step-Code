import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	forgetProcess,
	HOST_OWNER,
	isUnfinishedWork,
	listProcesses,
	listUnfinishedWork,
	registerProcess,
	releaseAllProcessesSync,
	releaseOwnerGracefully,
	releaseOwnerProcessesSync,
} from "../src/core/process-registry.ts";

const workspaces: string[] = [];
const spawned: number[] = [];

function workspace(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "step-process-registry-"));
	workspaces.push(dir);
	return dir;
}

/** Wait until a file exists, so a signal is never sent before the child installed its handler. */
async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(file)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${file}`);
}

/** A process that records SIGTERM and ignores it, so only the SIGKILL escalation can stop it. */
async function stubborn(): Promise<{ pid: number; marker: string }> {
	const dir = workspace();
	const marker = path.join(dir, "termed");
	const ready = path.join(dir, "ready");
	const script = [
		'const fs = require("node:fs");',
		`process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(marker)}, "term"));`,
		`fs.writeFileSync(${JSON.stringify(ready)}, "ready");`,
		"setInterval(() => {}, 1 << 30);",
	].join("");
	const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", detached: true });
	child.unref();
	if (child.pid === undefined) throw new Error("child did not start");
	spawned.push(child.pid);
	await waitForFile(ready);
	return { pid: child.pid, marker };
}

/** A plain long-lived process, ready to be signalled. */
async function ordinary(): Promise<number> {
	const dir = workspace();
	const ready = path.join(dir, "ready");
	const script = [
		'const fs = require("node:fs");',
		`fs.writeFileSync(${JSON.stringify(ready)}, "ready");`,
		"setInterval(() => {}, 1 << 30);",
	].join("");
	const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", detached: true });
	child.unref();
	if (child.pid === undefined) throw new Error("child did not start");
	spawned.push(child.pid);
	await waitForFile(ready);
	return child.pid;
}

/**
 * Whether a pid is a running process.
 *
 * `kill(pid, 0)` alone is not enough: a child that this process has not reaped yet is a zombie,
 * which still accepts signals. A zombie is dead for the purpose of these tests.
 */
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

afterEach(() => {
	releaseAllProcessesSync();
	for (const pid of spawned.splice(0)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
	// Anything a test forgot to stop is not the next test's problem.
	for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("process registry", () => {
	test("bash does not count as unfinished work, subagent and workflow do", () => {
		expect(isUnfinishedWork("bash")).toBe(false);
		expect(isUnfinishedWork("subagent")).toBe(true);
		expect(isUnfinishedWork("workflow")).toBe(true);
	});

	test("lists trees per owner and separates unfinished work from side effects", async () => {
		const bashPid = await ordinary();
		const agentPid = await ordinary();
		registerProcess({ pid: bashPid, kind: "bash", ownerId: "session-a", label: "npm run dev" });
		registerProcess({ pid: agentPid, kind: "subagent", ownerId: "session-a", label: "subagent x" });
		registerProcess({ pid: await ordinary(), kind: "bash", ownerId: "session-b", label: "other session" });

		expect(
			listProcesses("session-a")
				.map((entry) => entry.kind)
				.sort(),
		).toEqual(["bash", "subagent"]);
		expect(listUnfinishedWork("session-a").map((entry) => entry.kind)).toEqual(["subagent"]);
	});

	test("releases one owner's trees without touching another session's", async () => {
		const mine = await ordinary();
		const theirs = await ordinary();
		registerProcess({ pid: mine, kind: "bash", ownerId: "session-a", label: "dev server" });
		registerProcess({ pid: theirs, kind: "bash", ownerId: "session-b", label: "other dev server" });

		await releaseOwnerGracefully("session-a", 200);

		expect(listProcesses("session-a")).toEqual([]);
		expect(listProcesses("session-b")).toHaveLength(1);
		expect(alive(theirs)).toBe(true);
	});

	test("graceful release lets a SIGTERM handler run before the escalation", async () => {
		const { pid, marker } = await stubborn();
		registerProcess({ pid, kind: "bash", ownerId: "session-a", label: "trap test" });

		await releaseOwnerGracefully("session-a", 1_500);

		// The child wrote its marker on SIGTERM, then the escalation stopped it.
		expect(existsSync(marker)).toBe(true);
		expect(readFileSync(marker, "utf8")).toBe("term");
		expect(alive(pid)).toBe(false);
	}, 20_000);

	test("sync release stops trees immediately and forgets them", async () => {
		const pid = await ordinary();
		registerProcess({ pid, kind: "bash", ownerId: HOST_OWNER, label: "host child" });

		const released = releaseOwnerProcessesSync(HOST_OWNER);

		expect(released).toBe(1);
		expect(listProcesses(HOST_OWNER)).toEqual([]);
	});

	test("a re-registered pid replaces the previous record", async () => {
		const pid = await ordinary();
		registerProcess({ pid, kind: "bash", ownerId: "session-a", label: "first" });
		registerProcess({ pid, kind: "subagent", ownerId: "session-b", label: "second" });

		expect(listProcesses()).toHaveLength(1);
		expect(listProcesses("session-b")[0]?.kind).toBe("subagent");
	});

	test("forgetting an unknown pid is a no-op", () => {
		expect(() => forgetProcess(999_999_999)).not.toThrow();
	});
});
