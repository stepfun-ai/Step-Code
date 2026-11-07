import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { forgetProcess, HOST_OWNER, listProcesses, releaseOwnerGracefully } from "../src/core/process-registry.ts";
import { createStepToolProfile } from "../src/step/tool-profile.ts";

const workspaces: string[] = [];
const owners: string[] = [];

function workspace(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "step-bg-command-"));
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

/** Minimal extension context: the tools only read cwd and the session id. */
function contextFor(sessionId: string, cwd: string): ExtensionContext {
	return { cwd, sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
}

function tool(tools: ReturnType<typeof createStepToolProfile>, name: string) {
	const found = tools.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`tool ${name} not registered`);
	return found;
}

async function startBackground(cwd: string, sessionId: string, command: string) {
	const tools = createStepToolProfile(cwd);
	const result = await tool(tools, "run_command").execute(
		"call-1",
		{ command, run_in_background: true },
		undefined,
		undefined,
		contextFor(sessionId, cwd),
	);
	const logPath = (result as { details?: { logPath?: string } }).details?.logPath;
	if (logPath) logs.add(logPath);
	return result as {
		content: Array<{ type: string; text?: string }>;
		details?: { background?: boolean; kind?: string; pid?: number | null; logPath?: string };
	};
}

/** Log files this suite created, removed with the workspaces so a run leaves no trace. */
const logs = new Set<string>();

afterEach(async () => {
	for (const owner of owners.splice(0)) await releaseOwnerGracefully(owner, 200).catch(() => undefined);
	for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
	// A log file is a deliberate product artifact (it is how a stopped dev server stays inspectable),
	// but this suite's own files are not the user's. Remove only the ones it created.
	for (const log of logs) rmSync(log, { force: true });
	logs.clear();
});

describe("run_in_background lifecycle", () => {
	test("registers the command as bash work owned by the calling session", async () => {
		const cwd = workspace();
		const sessionId = `session-${Math.random().toString(16).slice(2)}`;
		owners.push(sessionId);

		const result = await startBackground(cwd, sessionId, "sleep 300");
		const pid = result.details?.pid;
		expect(typeof pid).toBe("number");

		// The tool result names the kind, so a host can tell a dev server from a subagent without
		// re-deriving it from prose.
		expect(result.details?.kind).toBe("bash");
		expect(result.details?.background).toBe(true);
		expect(typeof result.details?.logPath).toBe("string");

		const registered = listProcesses(sessionId);
		expect(registered).toHaveLength(1);
		expect(registered[0]?.kind).toBe("bash");
		expect(registered[0]?.pid).toBe(pid);
		expect(registered[0]?.logPath).toBe(result.details?.logPath);
		// A background command is a side effect, not unfinished work.
		expect(registered[0]?.kind).not.toBe("subagent");
	}, 20_000);

	test("the command dies when its session is released, and another session's keeps running", async () => {
		const cwdA = workspace();
		const cwdB = workspace();
		const sessionA = `session-a-${Math.random().toString(16).slice(2)}`;
		const sessionB = `session-b-${Math.random().toString(16).slice(2)}`;
		owners.push(sessionA, sessionB);

		const a = await startBackground(cwdA, sessionA, "sleep 300");
		const b = await startBackground(cwdB, sessionB, "sleep 300");
		const pidA = a.details?.pid as number;
		const pidB = b.details?.pid as number;
		expect(alive(pidA)).toBe(true);
		expect(alive(pidB)).toBe(true);

		await releaseOwnerGracefully(sessionA, 500);

		expect(alive(pidA)).toBe(false);
		expect(alive(pidB)).toBe(true);
		expect(listProcesses(sessionA)).toEqual([]);
		expect(listProcesses(sessionB)).toHaveLength(1);
	}, 30_000);

	test("bash_list reports this session's commands only, and bash_kill stops one", async () => {
		const cwd = workspace();
		const session = `session-${Math.random().toString(16).slice(2)}`;
		const other = `session-${Math.random().toString(16).slice(2)}`;
		owners.push(session, other);

		const started = await startBackground(cwd, session, "sleep 300");
		const pid = started.details?.pid as number;
		const tools = createStepToolProfile(cwd);
		const ctx = contextFor(session, cwd);

		const listed = (await tool(tools, "bash_list").execute("call-2", {}, undefined, undefined, ctx)) as {
			content: Array<{ text?: string }>;
			details?: { commands?: Array<{ pid: number; status: string }> };
		};
		expect(listed.details?.commands?.map((entry) => entry.pid)).toEqual([pid]);
		expect(listed.content[0]?.text).toContain(String(pid));

		const killed = (await tool(tools, "bash_kill").execute("call-3", { pid }, undefined, undefined, ctx)) as {
			details?: { stopped?: number };
		};
		expect(killed.details?.stopped).toBe(1);
		expect(alive(pid)).toBe(false);
		expect(listProcesses(session)).toEqual([]);
	}, 30_000);

	test("bash_kill refuses a pid that belongs to another session", async () => {
		const cwdA = workspace();
		const cwdB = workspace();
		const sessionA = `session-a-${Math.random().toString(16).slice(2)}`;
		const sessionB = `session-b-${Math.random().toString(16).slice(2)}`;
		owners.push(sessionA, sessionB);

		const b = await startBackground(cwdB, sessionB, "sleep 300");
		const pidB = b.details?.pid as number;

		const tools = createStepToolProfile(cwdA);
		await expect(
			tool(tools, "bash_kill").execute("call-4", { pid: pidB }, undefined, undefined, contextFor(sessionA, cwdA)),
		).rejects.toThrow(/No background command/);

		// The other session's command is untouched.
		expect(alive(pidB)).toBe(true);
	}, 30_000);

	test("a host-owned command (no session) is still registered and reclaimable", async () => {
		const cwd = workspace();
		const result = await startBackground(cwd, HOST_OWNER, "sleep 300");
		const pid = result.details?.pid as number;
		expect(listProcesses(HOST_OWNER).some((entry) => entry.pid === pid)).toBe(true);
		await releaseOwnerGracefully(HOST_OWNER, 300);
		expect(alive(pid)).toBe(false);
		forgetProcess(pid);
	}, 20_000);

	test("the log file records the command's output", async () => {
		const cwd = workspace();
		const session = `session-${Math.random().toString(16).slice(2)}`;
		owners.push(session);

		const result = await startBackground(cwd, session, "echo step-background-probe");
		const logPath = result.details?.logPath as string;
		const pid = result.details?.pid as number;

		// Wait for the write to land; the command exits on its own.
		const deadline = Date.now() + 10_000;
		let text = "";
		while (Date.now() < deadline) {
			try {
				text = readFileSync(logPath, "utf8");
			} catch {
				text = "";
			}
			if (text.includes("step-background-probe")) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(text).toContain("step-background-probe");
		forgetProcess(pid);
	}, 20_000);
});
