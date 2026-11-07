/**
 * Cross-platform process-tree signalling.
 *
 * Split out of `utils/shell.ts` so the process registry can use it without importing the shell
 * configuration layer, which would create a cycle (`shell` → `registry` → `shell`).
 *
 * Two termination strengths exist and callers must pick deliberately:
 *
 * - {@link terminateProcessTreeGracefully} sends `SIGTERM` to the group, waits, then escalates to
 *   `SIGKILL`. Use it for user-initiated stop and timeout, where a shell's `trap ... TERM` cleanup
 *   is part of the command's contract.
 * - {@link killProcessTree} sends `SIGKILL` immediately. Use it only when waiting is not an option:
 *   the host is exiting, or a stream already broke.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Long enough for a shell `trap ... TERM` handler to run its own cleanup.
 *
 * Used where waiting is acceptable: releasing a session's trees during teardown, where nothing
 * interactive is blocked on it.
 */
export const PROCESS_TREE_TERM_GRACE_MS = 3_000;

/**
 * Grace for a command the user just interrupted or that hit its deadline.
 *
 * Shorter than {@link PROCESS_TREE_TERM_GRACE_MS} because a foreground command must look stopped
 * immediately: the user pressed Escape, or the deadline already elapsed. A long window here reads as
 * a hang, and the call is still held open until the tree actually exits.
 */
export const INTERRUPTED_COMMAND_GRACE_MS = 500;

type LinuxProcessIdentity = { pid: number; ppid: number; startTime: string };

function readLinuxProcessIdentity(pid: number): LinuxProcessIdentity | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const startTime = fields[19];
		return startTime ? { pid, ppid: Number(fields[1]), startTime } : undefined;
	} catch {
		return undefined;
	}
}

/** Snapshot descendants before killing their parent makes them untraceable. */
function getLinuxDescendants(pid: number): LinuxProcessIdentity[] {
	const children = new Map<number, LinuxProcessIdentity[]>();
	try {
		// /proc/<pid>/task/<tid>/children is absent on some Linux kernels.
		// The stat parent field is available without that optional interface.
		for (const entry of readdirSync("/proc")) {
			const childPid = Number(entry);
			if (!Number.isSafeInteger(childPid) || childPid <= 0) continue;
			const child = readLinuxProcessIdentity(childPid);
			if (!child) continue;
			const siblings = children.get(child.ppid) ?? [];
			siblings.push(child);
			children.set(child.ppid, siblings);
		}
	} catch {
		return [];
	}
	const descendants: LinuxProcessIdentity[] = [];
	const pending = [pid];
	const visited = new Set(pending);
	for (let index = 0; index < pending.length; index++) {
		for (const child of children.get(pending[index]) ?? []) {
			if (visited.has(child.pid)) continue;
			visited.add(child.pid);
			descendants.push(child);
			pending.push(child.pid);
		}
	}
	return descendants;
}

/**
 * Snapshot of the Linux descendants observed for one tree, taken before the first signal.
 *
 * Re-reading `/proc` at escalation time would find nothing: by then the parent is dead and its
 * children have been reparented, so their `ppid` no longer points at the tree. The identity
 * snapshot is what makes the second signal able to reach a descendant that ignored the first.
 */
type TreeSnapshot = LinuxProcessIdentity[];

function snapshotTree(pid: number): TreeSnapshot {
	return process.platform === "linux" ? getLinuxDescendants(pid) : [];
}

/**
 * Signal one process group plus the descendants observed in `snapshot`.
 *
 * A command can put a child in its own session or process group (`setsid`, `nohup ... &`), which
 * `kill(-pid)` does not reach — those are what the snapshot covers. The identity check keeps a
 * recycled pid from being signalled.
 *
 * Never throws: a process that exited between the snapshot and the signal is not a failure.
 */
function signalTree(pid: number, signal: NodeJS.Signals, snapshot?: TreeSnapshot): void {
	const descendants = snapshot ?? snapshotTree(pid);
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// The process already exited.
		}
	}
	for (const descendant of [...descendants].reverse()) {
		if (readLinuxProcessIdentity(descendant.pid)?.startTime !== descendant.startTime) continue;
		try {
			process.kill(descendant.pid, signal);
		} catch {
			// The descendant already exited or was killed with the parent group.
		}
	}
}

function spawnWindowsTaskkill(pid: number, force: boolean): void {
	try {
		const child: ChildProcess = spawn(
			join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
			[...(force ? ["/F"] : []), "/T", "/PID", String(pid)],
			{ stdio: "ignore", detached: true, windowsHide: true },
		);
		// A failed spawn emits "error" asynchronously; consume it to avoid crashing Node.
		child.once("error", () => {});
	} catch {
		// Ignore errors if taskkill fails.
	}
}

/**
 * Terminate a process tree, giving it a chance to clean up.
 *
 * `keepAlive` controls whether the grace timer keeps the process alive:
 *
 * - `false` (default) is for fire-and-forget stops. The timer is unref'd so a 3-second grace window
 *   cannot hold a quitting host open.
 * - `true` is for callers that `await` {@link ProcessTreeTermination.settled}. An unref'd timer
 *   resolves nothing: with the await as the only pending work, Node drains the loop and exits
 *   instead of firing it. Such a caller must opt in.
 *
 * Returns a canceller that disarms the pending escalation. Call it once the process actually exited:
 * a late `SIGKILL` must never land on a reused pid or process group.
 */
export function terminateProcessTreeGracefully(
	pid: number,
	graceMs: number = PROCESS_TREE_TERM_GRACE_MS,
	options: { keepAlive?: boolean } = {},
): (() => void) & { settled: Promise<void> } {
	let finish = (): void => {};
	const settled = new Promise<void>((resolve) => {
		let done = false;
		let timer: NodeJS.Timeout | undefined;
		finish = () => {
			if (done) return;
			done = true;
			if (timer) clearTimeout(timer);
			resolve();
		};
		if (process.platform === "win32") {
			spawnWindowsTaskkill(pid, false);
			timer = setTimeout(() => {
				spawnWindowsTaskkill(pid, true);
				finish();
			}, graceMs);
		} else {
			// One snapshot, used by both signals: after the SIGTERM the parent is usually gone, and a
			// descendant that ignored it has already been reparented out of the tree.
			const snapshot = snapshotTree(pid);
			signalTree(pid, "SIGTERM", snapshot);
			timer = setTimeout(() => {
				signalTree(pid, "SIGKILL", snapshot);
				finish();
			}, graceMs);
		}
		// `unref` only where nobody awaits: see the doc comment.
		if (options.keepAlive !== true) timer.unref?.();
	});
	return Object.assign(() => finish(), { settled });
}

/**
 * Kill a process tree immediately, without a grace window.
 *
 * Use only where waiting is impossible: host exit, or a stream that already failed. A shell
 * `trap ... TERM` never runs on this path.
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use the trusted System32 executable so cleanup does not depend on PATH.
		spawnWindowsTaskkill(pid, true);
		return;
	}
	// `signalTree` already covers descendants that moved to their own group or session.
	signalTree(pid, "SIGKILL");
}
