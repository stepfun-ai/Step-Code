import { execFileSync, spawn } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import {
	forgetProcess,
	listProcesses,
	registerProcess,
	releaseAllProcessesSync,
} from "../src/core/process-registry.ts";
import { createStepExtension } from "../src/features/step.ts";

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

/** Register the extension and return a dispatcher for one of its event handlers. */
function stepHandlers(sessionId: string) {
	const on = vi.fn();
	createStepExtension({ permission: { env: {}, initialPreset: "approve-for-me" } })({
		on,
		registerProvider: vi.fn(),
		registerCommand: vi.fn(),
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI);
	const handler = (name: string) =>
		on.mock.calls.filter(([event]) => event === name).at(-1)?.[1] as
			| ((event: unknown, ctx: unknown) => void)
			| undefined;
	const ctx = {
		hasUI: false,
		ui: { notify: vi.fn(), setStatus: vi.fn() },
		isIdle: () => true,
		hasPendingMessages: () => false,
		autoRetryEnabled: false,
		setAutoRetryEnabled: vi.fn(),
		sessionManager: { getSessionId: () => sessionId },
	};
	return { handler, ctx };
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

describe("session-scoped process release", () => {
	test("session_shutdown releases this session's trees only", async () => {
		const session = `session-${Math.random().toString(16).slice(2)}`;
		const other = `session-${Math.random().toString(16).slice(2)}`;
		const mine = spawnLongLived();
		const theirs = spawnLongLived();
		registerProcess({ pid: mine, kind: "bash", ownerId: session, label: "npm run dev" });
		registerProcess({ pid: theirs, kind: "bash", ownerId: other, label: "other dev server" });

		const { handler, ctx } = stepHandlers(session);
		handler("session_shutdown")?.({ reason: "quit" }, ctx);

		// The release is fire-and-forget: the tree dies first, then its record is dropped once the
		// grace window settles. Wait for the record, not just the signal.
		const deadline = Date.now() + 15_000;
		while (listProcesses(session).length > 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 50));
		}

		expect(alive(mine)).toBe(false);
		expect(alive(theirs)).toBe(true);
		expect(listProcesses(session)).toEqual([]);
		expect(listProcesses(other)).toHaveLength(1);
	}, 20_000);

	test("session_shutdown only releases on quit: new, resume, fork and reload keep the dev server", async () => {
		// The regression this locks: `session_shutdown` fires for five reasons and only `quit` ends the
		// session. `new`/`resume`/`fork` replace the runtime while the old conversation stays on disk,
		// and `reload` keeps the same session object — killing on those stops a dev server the user is
		// still watching. Types, so a new reason cannot be added without revisiting this list.
		for (const reason of ["new", "resume", "fork", "reload"] as const) {
			const session = `session-${Math.random().toString(16).slice(2)}`;
			const pid = spawnLongLived();
			registerProcess({ pid, kind: "bash", ownerId: session, label: "npm run dev" });

			const { handler, ctx } = stepHandlers(session);
			handler("session_shutdown")?.({ reason }, ctx);

			// Give a mistaken release time to land before asserting it did not happen.
			await new Promise((r) => setTimeout(r, 300));
			expect(alive(pid), `reason=${reason} must not release`).toBe(true);
			expect(listProcesses(session)).toHaveLength(1);
			forgetProcess(pid);
		}
	}, 20_000);

	test("session_start does not release anything: starting a conversation must not kill its own dev server", async () => {
		// The regression this locks: the release call was once wired into `session_start`, so opening
		// a session killed the background commands that session owned.
		const session = `session-${Math.random().toString(16).slice(2)}`;
		const mine = spawnLongLived();
		registerProcess({ pid: mine, kind: "bash", ownerId: session, label: "npm run dev" });

		const { handler, ctx } = stepHandlers(session);
		handler("session_start")?.({}, ctx);

		// Give a mistaken release time to land before asserting it did not happen.
		await new Promise((r) => setTimeout(r, 1_000));

		expect(alive(mine)).toBe(true);
		expect(listProcesses(session)).toHaveLength(1);
	}, 20_000);
});

describe("background command status line", () => {
	test("reports this session's commands, and clears when they are gone", async () => {
		const session = `session-${Math.random().toString(16).slice(2)}`;
		const other = `session-${Math.random().toString(16).slice(2)}`;
		const { handler, ctx } = stepHandlers(session);
		const setStatus = ctx.ui.setStatus as ReturnType<typeof vi.fn>;

		handler("session_start")?.({}, ctx);
		// Nothing to show yet. `setStatus` is shared with other Step status lines, so read only this
		// key rather than the last call overall.
		const lastText = () =>
			setStatus.mock.calls.filter(([key]) => key === "background-commands").at(-1)?.[1] as string | undefined;
		expect(lastText()).toBeUndefined();

		const mine = spawnLongLived();
		const theirs = spawnLongLived();
		registerProcess({ pid: mine, kind: "bash", ownerId: session, label: "npm run dev" });
		registerProcess({ pid: theirs, kind: "bash", ownerId: other, label: "other" });
		// The registry notifies subscribers on change; the status line counts only this session's.
		expect(lastText()).toBe("1 background command");

		// A subagent is not a background command and must not inflate the count.
		registerProcess({ pid: spawnLongLived(), kind: "subagent", ownerId: session, label: "agent" });
		expect(lastText()).toBe("1 background command");

		handler("session_shutdown")?.({ reason: "quit" }, ctx);
		expect(lastText()).toBeUndefined();
	}, 20_000);
});
