import { execFileSync, spawn } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { forgetProcess, registerProcess, releaseAllProcessesSync } from "../src/core/process-registry.ts";
import { createStepPsExtension } from "../src/features/step-ps.ts";

const spawned: number[] = [];

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

function spawnLongLived(): number {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
		stdio: "ignore",
		detached: true,
	});
	child.unref();
	if (child.pid === undefined) throw new Error("child did not start");
	spawned.push(child.pid);
	return child.pid;
}

/** Run one `/ps` invocation and return what it told the user. */
async function runPs(sessionId: string, args: string, mode = "tui"): Promise<string> {
	const on = vi.fn();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	createStepPsExtension()({
		on,
		registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, definition);
		},
	} as unknown as ExtensionAPI);
	const command = commands.get("ps");
	if (!command) throw new Error("/ps was not registered");
	const notify = vi.fn();
	await command.handler(args, {
		mode,
		sessionManager: { getSessionId: () => sessionId },
		ui: { notify },
	});
	return notify.mock.calls.map(([message]) => message as string).join("\n");
}

afterEach(() => {
	releaseAllProcessesSync();
	for (const pid of spawned.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
});

describe("/ps", () => {
	test("lists this session's background commands only", async () => {
		const session = `session-${Math.random().toString(16).slice(2)}`;
		const other = `session-${Math.random().toString(16).slice(2)}`;
		const mine = spawnLongLived();
		registerProcess({ pid: mine, kind: "bash", ownerId: session, label: "npm run dev", logPath: "/tmp/dev.log" });
		registerProcess({ pid: spawnLongLived(), kind: "bash", ownerId: other, label: "someone else's server" });
		// A subagent is not a process in the `ps` sense, and is reported by the lane widget.
		registerProcess({ pid: spawnLongLived(), kind: "subagent", ownerId: session, label: "agent x" });

		const text = await runPs(session, "");

		expect(text).toContain("Background commands");
		expect(text).toContain("npm run dev");
		expect(text).toContain(`pid ${mine}`);
		expect(text).toContain("/tmp/dev.log");
		expect(text).not.toContain("someone else's server");
		expect(text).not.toContain("agent x");
	});

	test("reports an empty list without pretending something failed", async () => {
		const text = await runPs(`session-${Math.random().toString(16).slice(2)}`, "list");
		expect(text).toContain("No background commands running.");
	});

	test("folds a long list instead of printing every row", async () => {
		const session = `session-${Math.random().toString(16).slice(2)}`;
		for (let index = 0; index < 20; index += 1) {
			registerProcess({ pid: spawnLongLived(), kind: "bash", ownerId: session, label: `command ${index}` });
		}
		const text = await runPs(session, "list");
		expect(text).toContain("command 15");
		expect(text).not.toContain("command 16");
		expect(text).toContain("... and 4 more running");
	});

	test("kill <pid> stops that command and leaves the session's others running", async () => {
		const session = `session-${Math.random().toString(16).slice(2)}`;
		const target = spawnLongLived();
		const bystander = spawnLongLived();
		registerProcess({ pid: target, kind: "bash", ownerId: session, label: "to stop" });
		registerProcess({ pid: bystander, kind: "bash", ownerId: session, label: "keep" });

		const text = await runPs(session, `kill ${target}`);

		expect(text).toContain(`Stopped background command ${target}`);
		expect(alive(target)).toBe(false);
		expect(alive(bystander)).toBe(true);
	}, 20_000);

	test("kill refuses a pid owned by another session", async () => {
		const session = `session-${Math.random().toString(16).slice(2)}`;
		const other = `session-${Math.random().toString(16).slice(2)}`;
		const foreign = spawnLongLived();
		const mine = spawnLongLived();
		registerProcess({ pid: foreign, kind: "bash", ownerId: other, label: "not yours" });
		// The session must own something, or the empty-list branch answers first and this test would
		// pass even if cross-session refusal were broken.
		registerProcess({ pid: mine, kind: "bash", ownerId: session, label: "mine" });

		const text = await runPs(session, `kill ${foreign}`);

		expect(text).toContain(`No background command with pid ${foreign} in this session.`);
		expect(alive(foreign)).toBe(true);
		expect(alive(mine)).toBe(true);
		forgetProcess(mine);
	});

	test("kill all stops only this session's background commands, never a subagent", async () => {
		const session = `session-${Math.random().toString(16).slice(2)}`;
		const bash = spawnLongLived();
		const agent = spawnLongLived();
		registerProcess({ pid: bash, kind: "bash", ownerId: session, label: "dev server" });
		registerProcess({ pid: agent, kind: "subagent", ownerId: session, label: "agent x" });

		const text = await runPs(session, "kill all");

		expect(text).toContain("Stopped 1 background command");
		expect(alive(bash)).toBe(false);
		expect(alive(agent)).toBe(true);
	}, 20_000);

	test("refuses to run outside the terminal", async () => {
		// Web and Desktop show background commands in the composer strip; a transcript command there
		// would duplicate it, and `notify` is a no-op in those hosts.
		for (const mode of ["rpc", "json", "print"] as const) {
			const text = await runPs(`session-${Math.random().toString(16).slice(2)}`, "", mode);
			expect(text).toContain("terminal command");
		}
	});

	test("a malformed invocation explains the usage instead of guessing", async () => {
		const session = `session-${Math.random().toString(16).slice(2)}`;
		registerProcess({ pid: spawnLongLived(), kind: "bash", ownerId: session, label: "dev server" });
		for (const args of ["kill", "kill not-a-pid", "bogus"]) {
			const text = await runPs(session, args);
			expect(text).toContain("Usage: /ps");
		}
	});
});
