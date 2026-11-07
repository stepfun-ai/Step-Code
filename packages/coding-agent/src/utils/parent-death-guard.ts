/**
 * Parent-death guard for detached process trees.
 *
 * `SIGKILL` cannot be caught, so no in-process handler can reclaim a shell that outlived its host.
 * An external supervisor can: this module spawns one detached Node process per host, and that
 * supervisor's IPC channel doubles as a liveness lease.
 *
 * The mechanism relies on one Node guarantee: an IPC channel's `disconnect` event fires when the
 * other end disappears for *any* reason, including `SIGKILL` of the parent. The supervisor arms a
 * lease per process group; when the channel closes it signals every armed group, and disarms when
 * the owner reports a normal exit.
 *
 * One supervisor serves the whole host: leases are keyed by a random id, so a stale `disarm` from a
 * previous generation cannot cancel a live lease, and a pid that was recycled after its owner
 * exited is never signalled.
 *
 * Why the supervisor exists at all, rather than just `process.on("exit")`: `exit` handlers do not
 * run on `SIGKILL`, and a crashed Electron main process is exactly the case that left a dev server
 * running for days.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/** A live lease. `disarm` must be called once the guarded tree exited on its own. */
export interface ParentDeathGuard {
	/** Resolves when the supervisor has armed the lease and is watching. */
	ready: Promise<void>;
	/** Release the lease so a normal exit is not reported as a parent death. */
	disarm: () => Promise<void>;
}

/**
 * Source of the detached supervisor. Kept as a string because it must run in a separate Node
 * process with no module resolution: it is passed to `--eval`.
 */
const SUPERVISOR_SOURCE = `
import { spawn } from "node:child_process";

const targets = new Map();
let armed = true;
// Keeps the supervisor alive while it holds leases. Cleared before every exit.
const keepAlive = setInterval(() => {}, 1 << 30);

const signalGroup = (targetPid, signal) => {
  try { process.kill(-targetPid, signal); }
  catch {
    try { process.kill(targetPid, signal); } catch {}
  }
};

const taskkill = (targetPid, force) => {
  const root = process.env.SystemRoot || process.env.windir;
  const executable = root ? win32.join(root, "System32", "taskkill.exe") : "taskkill.exe";
  try {
    const child = spawn(executable, [...(force ? ["/F"] : []), "/T", "/PID", String(targetPid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    const fallbackKill = () => {
      try { process.kill(targetPid, "SIGKILL"); } catch {}
    };
    child.once("error", fallbackKill);
    child.unref();
  } catch {
    try { process.kill(targetPid, "SIGKILL"); } catch {}
  }
};

const terminate = () => {
  if (!armed) return;
  armed = false;
  if (targets.size === 0) {
    clearInterval(keepAlive);
    process.exit(0);
  }
  let maxGraceMs = 0;
  for (const { pid: targetPid, graceMs } of targets.values()) {
    maxGraceMs = Math.max(maxGraceMs, graceMs);
    if (process.platform === "win32") taskkill(targetPid, false);
    else signalGroup(targetPid, "SIGTERM");
  }
  setTimeout(() => {
    for (const { pid: targetPid } of targets.values()) {
      if (process.platform === "win32") taskkill(targetPid, true);
      else signalGroup(targetPid, "SIGKILL");
    }
    clearInterval(keepAlive);
    process.exit(0);
  }, maxGraceMs);
};

// The channel closing means the host is gone, however it died. This is the whole point.
process.once("disconnect", terminate);
process.once("SIGTERM", terminate);
process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  const pid = Number(message.pid);
  const leaseId = typeof message.leaseId === "string" ? message.leaseId : "";
  if (!leaseId || !Number.isFinite(pid) || pid <= 0) return;
  if (message.type === "arm") {
    targets.set(leaseId, { pid, graceMs: Math.max(0, Number(message.graceMs) || 0) });
    process.send?.({ type: "armed", leaseId, pid });
    return;
  }
  if (message.type !== "disarm") return;
  targets.delete(leaseId);
  process.send?.({ type: "disarmed", leaseId, pid });
});
`;

let supervisor: ChildProcess | undefined;

function isUsable(candidate: ChildProcess | undefined): candidate is ChildProcess {
	return candidate !== undefined && candidate.connected === true;
}

function spawnSupervisor(): ChildProcess | undefined {
	let child: ChildProcess;
	try {
		child = spawn(process.execPath, ["--input-type=module", "--eval", SUPERVISOR_SOURCE], {
			detached: true,
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			windowsHide: true,
			env: {
				// The supervisor only needs enough environment to find `taskkill` on Windows and to
				// run Node as Node when this host is Electron. Do not inherit credentials.
				...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
				...(process.env.windir ? { windir: process.env.windir } : {}),
				...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
			},
		});
	} catch {
		return undefined;
	}
	const forget = () => {
		if (supervisor === child) supervisor = undefined;
	};
	child.once("error", forget);
	child.once("exit", forget);
	child.unref();
	child.channel?.unref?.();
	supervisor = child;
	return child;
}

function waitForMessage(
	child: ChildProcess,
	type: "armed" | "disarmed",
	pid: number,
	leaseId: string,
	send: { type: "arm"; graceMs: number } | { type: "disarm" },
): Promise<void> {
	return new Promise((resolve, reject) => {
		let timer: NodeJS.Timeout;
		const finish = (error?: Error) => {
			clearTimeout(timer);
			child.off("message", onMessage);
			child.off("exit", onExit);
			if (error) reject(error);
			else resolve();
		};
		const onMessage = (received: unknown) => {
			if (!received || typeof received !== "object") return;
			const message = received as { type?: unknown; leaseId?: unknown; pid?: unknown };
			if (message.type !== type || message.leaseId !== leaseId || message.pid !== pid) return;
			finish();
		};
		const onExit = () => finish(new Error("The parent-death supervisor exited before acknowledging"));
		// A supervisor that never answers must not block command output: the command already runs
		// unguarded in that case, which is the same state as before this module existed. The timer
		// deliberately is *not* unref'd: a caller awaiting `ready` has nothing else pending, so an
		// unref'd timer would let Node exit mid-wait and the promise would never settle.
		timer = setTimeout(() => {
			finish(new Error("The parent-death supervisor did not acknowledge in time"));
		}, 2_000);
		child.on("message", onMessage);
		child.once("exit", onExit);
		child.send(
			{ type: send.type, leaseId, pid, ...(send.type === "arm" ? { graceMs: send.graceMs } : {}) },
			(error) => {
				if (error) finish(error);
			},
		);
	});
}

/**
 * Arm the parent-death guard for one process group.
 *
 * Returns `undefined` when the supervisor cannot be started or the pid is unusable; callers then
 * fall back to whatever reclamation they already had. This never throws: a guard failing must not
 * fail the command the user asked for.
 */
export function armParentDeathGuard(pid: number, graceMs = 3_000): ParentDeathGuard | undefined {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	const leaseId = randomUUID();
	const guardian = isUsable(supervisor) ? supervisor : spawnSupervisor();
	if (!guardian) return undefined;
	const ready = waitForMessage(guardian, "armed", pid, leaseId, { type: "arm", graceMs });
	let disarmed = false;
	return {
		ready,
		disarm: async () => {
			if (disarmed) return;
			disarmed = true;
			// A lease that never armed has nothing to release; do not surface that as an error.
			const armed = await ready.then(
				() => true,
				() => false,
			);
			if (!armed || !guardian.connected) return;
			await waitForMessage(guardian, "disarmed", pid, leaseId, { type: "disarm" }).catch(() => undefined);
		},
	};
}
