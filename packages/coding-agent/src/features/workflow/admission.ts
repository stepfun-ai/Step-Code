import { WorkflowSemaphore } from "./budget.ts";

/** A process-wide node window, shared by concurrent workflow tools/sessions.
 * Conservatively includes all models: model overrides cannot escape the host
 * ceiling. Each run also retains its own lower maxConcurrency window.
 */
let pool: { semaphore: WorkflowSemaphore; members: Set<{ ceiling: number }>; idleSince?: number } | undefined;

/**
 * How long a congested window is remembered after its last workflow finishes. A
 * session often runs workflows back to back (one per phase); starting each at the
 * full ceiling straight after a 429 would re-trigger the congestion just seen. An
 * idle window that never throttled is discarded immediately.
 */
const THROTTLED_POOL_RETENTION_MS = 60_000;

export interface WorkflowAdmissionLease {
	semaphore: WorkflowSemaphore;
	release(): void;
}

export function acquireWorkflowAdmission(ceiling: number): WorkflowAdmissionLease {
	if (pool && pool.members.size === 0 && Date.now() - (pool.idleSince ?? 0) >= THROTTLED_POOL_RETENTION_MS) {
		pool.semaphore.dispose();
		pool = undefined;
	}
	pool ??= { semaphore: new WorkflowSemaphore(ceiling), members: new Set() };
	const current = pool;
	current.idleSince = undefined;
	const member = { ceiling };
	current.members.add(member);
	current.semaphore.setCeiling(Math.min(...Array.from(current.members, (item) => item.ceiling)));
	return {
		semaphore: current.semaphore,
		release() {
			if (!current.members.delete(member)) return;
			if (current.members.size > 0) {
				current.semaphore.setCeiling(Math.min(...Array.from(current.members, (item) => item.ceiling)));
			} else if (current.semaphore.throttled) {
				current.semaphore.park();
				current.idleSince = Date.now();
			} else {
				current.semaphore.dispose();
				if (pool === current) pool = undefined;
			}
		},
	};
}

/** Forget retained congestion state. Intended for tests and host shutdown. */
export function resetWorkflowAdmission(): void {
	if (pool && pool.members.size === 0) {
		pool.semaphore.dispose();
		pool = undefined;
	}
}
