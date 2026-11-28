/**
 * Work a model request still owes after its caller stopped waiting for it: for
 * example telling a server to release a reservation the request held. A request
 * registers such work while it runs; whoever disposes the session awaits it,
 * with a bound, before the process can exit. Nothing is registered by default,
 * so a session without such work never waits.
 */

/** How long a disposing session waits for registered request teardowns. */
export const DEFAULT_REQUEST_TEARDOWN_LIMIT_MS = 2_000;

export class RequestTeardowns {
	private readonly pending = new Set<Promise<void>>();

	/** Track `task` until it settles; its outcome (or failure) is the registrant's concern. */
	register(task: Promise<unknown>): void {
		const settled = task.then(
			() => undefined,
			() => undefined,
		);
		this.pending.add(settled);
		void settled.then(() => this.pending.delete(settled));
	}

	/** Wait for the teardowns registered so far, at most `limitMs`; returns at once when there are none. */
	async settle(limitMs: number = DEFAULT_REQUEST_TEARDOWN_LIMIT_MS): Promise<void> {
		if (this.pending.size === 0) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const limit = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, limitMs);
		});
		try {
			await Promise.race([Promise.allSettled([...this.pending]), limit]);
		} finally {
			clearTimeout(timer);
		}
	}
}
