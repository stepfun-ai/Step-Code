/**
 * Process ownership registry for detached child process trees.
 *
 * A coding session starts process trees it cannot wait on: subagent RPC children, background
 * `run_in_background` commands, and the shells that `run_command` creates. Each of them must be
 * reclaimed at a different moment, and the moment depends on *why* the process exists:
 *
 * - `subagent` and `workflow` are the session's own work. They count as unfinished work, and they
 *   die with the session that started them.
 * - `bash` is a side effect the user inspects (a dev server, a watcher). It must survive a session
 *   switch or a fork, so it is *not* unfinished work, but it still dies when its session is
 *   deleted or the host exits.
 *
 * Three reclamation layers exist, from narrowest to widest:
 *
 * 1. `releaseOwner(ownerId)` — one session's trees. Used when a session is torn down.
 * 2. `releaseAll()` — every tree this process owns. Registered on `process.exit`, so a host that
 *    never wrote its own shutdown path still reclaims children.
 * 3. The parent-death guard in `./parent-death-guard.ts` — an external supervisor for `SIGKILL`,
 *    which no in-process handler can survive.
 *
 * Watch out: `trackDetachedChildPid` used to be a bare `Set<number>` in `utils/shell.ts`. Anything
 * that still uses it keeps working through the compatibility wrappers exported there, but new code
 * must register here so ownership and kind are known.
 */

import { killProcessTree, PROCESS_TREE_TERM_GRACE_MS, terminateProcessTreeGracefully } from "../utils/process-tree.ts";

/** Why a process tree exists. Determines whether it counts as unfinished session work. */
export type ProcessKind = "bash" | "subagent" | "workflow";

/** One registered process tree. */
export interface ProcessRegistration {
	/** Process-group leader pid on POSIX; the wrapper's pid on Windows. */
	pid: number;
	kind: ProcessKind;
	/** Session that owns the tree; `HOST_OWNER` for trees outside any session. */
	ownerId: string;
	/** Human-readable label, bounded by the caller. */
	label: string;
	/** Working directory the command ran in, when known. */
	cwd?: string;
	/** Log file capturing output, for background commands. */
	logPath?: string;
	startedAt: number;
	/** True once a reclamation has been requested for this tree. */
	releasing?: boolean;
}

/** Owner id for trees a host starts outside a session. */
export const HOST_OWNER = "\0host";

/** Grace window between the tree's SIGTERM and its SIGKILL. */
export const PROCESS_TERM_GRACE_MS = PROCESS_TREE_TERM_GRACE_MS;

/** Kinds that count as unfinished session work. `bash` deliberately does not. */
const UNFINISHED_WORK_KINDS: ReadonlySet<ProcessKind> = new Set<ProcessKind>(["subagent", "workflow"]);

/** Whether a kind represents work the session is still performing. */
export function isUnfinishedWork(kind: ProcessKind): boolean {
	return UNFINISHED_WORK_KINDS.has(kind);
}

const registrations = new Map<number, ProcessRegistration>();
const listeners = new Set<(entries: readonly ProcessRegistration[]) => void>();

function notify(): void {
	if (listeners.size === 0) return;
	const snapshot = [...registrations.values()];
	for (const listener of listeners) {
		try {
			listener(snapshot);
		} catch {
			// An observer must never break process reclamation.
		}
	}
}

/** Subscribe to registry changes; returns the unsubscribe function. */
export function subscribeToProcessRegistry(listener: (entries: readonly ProcessRegistration[]) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Every registered tree, newest last. */
export function listProcesses(ownerId?: string): ProcessRegistration[] {
	const all = [...registrations.values()];
	return ownerId === undefined ? all : all.filter((entry) => entry.ownerId === ownerId);
}

/** Trees for one owner that count as unfinished work. */
export function listUnfinishedWork(ownerId: string): ProcessRegistration[] {
	return listProcesses(ownerId).filter((entry) => isUnfinishedWork(entry.kind) && !entry.releasing);
}

/** Register one process tree. Re-registering the same pid replaces the previous record. */
export function registerProcess(input: Omit<ProcessRegistration, "startedAt"> & { startedAt?: number }): void {
	if (!Number.isSafeInteger(input.pid) || input.pid <= 0) return;
	registrations.set(input.pid, { ...input, startedAt: input.startedAt ?? Date.now() });
	notify();
}

/** Drop one tree's record without signalling it (the caller already reaped it). */
export function forgetProcess(pid: number): void {
	if (registrations.delete(pid)) notify();
}

/**
 * Drop a tree's record without signalling it, but only when the record still describes what the
 * caller registered. A pid can be reused after exit, so a late `exit` event from an old child must
 * not remove a newer registration.
 */
export function forgetProcessIf(pid: number, matches: (entry: ProcessRegistration) => boolean): void {
	const entry = registrations.get(pid);
	if (entry && matches(entry) && registrations.delete(pid)) notify();
}

/**
 * Kill one owner's trees immediately and forget them.
 *
 * Synchronous and unbounded: it exists for `process.exit`, where there is no event loop turn left to
 * await an escalation. Callers that can wait must use {@link releaseOwnerGracefully} instead, so a
 * shell's `trap ... TERM` handler still runs.
 */
export function releaseOwnerProcessesSync(ownerId: string): number {
	let released = 0;
	for (const [pid, entry] of [...registrations]) {
		if (entry.ownerId !== ownerId) continue;
		killProcessTree(pid);
		registrations.delete(pid);
		released += 1;
	}
	if (released > 0) notify();
	return released;
}

/** Kill every registered tree immediately and forget them. For host exit. */
export function releaseAllProcessesSync(): number {
	let released = 0;
	for (const [pid] of [...registrations]) {
		killProcessTree(pid);
		registrations.delete(pid);
		released += 1;
	}
	if (released > 0) notify();
	return released;
}

/**
 * Terminate one owner's trees and wait for the grace window.
 *
 * **Kind is the caller's decision.** This function releases every registration the owner has,
 * whatever its kind, unless `only` narrows it. That is deliberate for session teardown, where all
 * of the session's work should stop. It is wrong for a narrower caller: `bash_kill` promises to
 * stop background commands, so it must pass the pids it means and leave the owner's subagent trees
 * alone. Any new caller that means "one kind" has to say so explicitly:
 *
 * ```ts
 * const pids = listProcesses(ownerId).filter((e) => e.kind === "bash").map((e) => e.pid);
 * await releaseOwnerGracefully(ownerId, undefined, new Set(pids));
 * ```
 *
 * `only` narrows pids, this function does not widen them back.
 *
 * Marks each tree released first, so a concurrent {@link releaseAllProcessesSync} on `process.exit`
 * does not signal the same group twice. Returns after the escalation is *sent*, not after every pid
 * is observed dead: a tree that ignores `SIGKILL` is not something this process can fix.
 */
export async function releaseOwnerGracefully(
	ownerId: string,
	graceMs: number = PROCESS_TERM_GRACE_MS,
	only?: ReadonlySet<number>,
): Promise<number> {
	const pending: Array<Promise<void>> = [];
	for (const entry of registrations.values()) {
		if (entry.ownerId !== ownerId || entry.releasing) continue;
		if (only !== undefined && !only.has(entry.pid)) continue;
		entry.releasing = true;
		// `keepAlive`: the caller awaits `settled`, so the grace timer must keep the loop alive long
		// enough to fire the escalation. An unref'd timer would let Node exit mid-wait.
		pending.push(terminateProcessTreeGracefully(entry.pid, graceMs, { keepAlive: true }).settled);
	}
	if (pending.length === 0) return 0;
	notify();
	await Promise.all(pending);
	for (const [pid, entry] of [...registrations]) {
		if (entry.ownerId !== ownerId || !entry.releasing) continue;
		if (only !== undefined && !only.has(pid)) continue;
		registrations.delete(pid);
	}
	notify();
	return pending.length;
}

// A host that never wrote its own shutdown path still reclaims its children. `prependListener`
// runs this before any other exit handler, including ones that throw.
process.prependListener("exit", () => {
	releaseAllProcessesSync();
});
