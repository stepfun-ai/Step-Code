/**
 * Refresh scheduling for reads that only need to be current, not repeated.
 *
 * A tool-heavy turn asks for the session snapshot and the session list several
 * times per tool. Each ask used to be a request of its own, and every response
 * was parsed and rendered even when the next one was already on its way.
 */

/**
 * `load` run at most once at a time. A call made while one runs gets a single
 * trailing run, shared with every other call made meanwhile, and resolves when
 * that run has: the caller still sees state at least as new as its call.
 */
export function coalesced(load: () => Promise<void>): () => Promise<void> {
	let active: Promise<void> | null = null;
	let trailing: Promise<void> | null = null;
	const start = (): Promise<void> => {
		const run = load().finally(() => {
			if (active === run) active = null;
		});
		active = run;
		return run;
	};
	return () => {
		if (!active) return start();
		trailing ??= active
			// The running read's failure belongs to its own caller; the trailing read reports its own.
			.catch(() => {})
			.then(() => {
				trailing = null;
				return start();
			});
		return trailing;
	};
}

/** A throttled run: `request` asks for one, `cancel` drops a run that is waiting for its window. */
export interface Throttle {
	request(): void;
	cancel(): void;
}

/**
 * `run` at most once per `intervalMs` and never while a previous run is still
 * in flight. A request after a quiet interval runs at once, so an isolated
 * event (a turn settling) is answered without delay; requests made during a
 * run or within `intervalMs` of its start fold into one more run after that
 * window. A steady stream of requests therefore runs every `intervalMs`, and
 * cannot postpone the next run the way a debounce would.
 */
export function throttled(run: () => Promise<void>, intervalMs: number): Throttle {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight = false;
	let dirty = false;
	let cancelled = false;
	let lastStart = Number.NEGATIVE_INFINITY;
	const fire = (): void => {
		timer = undefined;
		dirty = false;
		inFlight = true;
		lastStart = Date.now();
		run()
			// Each run reports its own failure; the schedule only keeps going.
			.catch(() => {})
			.finally(() => {
				inFlight = false;
				if (dirty && !cancelled) schedule();
			});
	};
	const schedule = (): void => {
		if (timer !== undefined || inFlight) return;
		const wait = lastStart + intervalMs - Date.now();
		if (wait <= 0) fire();
		else timer = setTimeout(fire, wait);
	};
	return {
		request() {
			if (cancelled) return;
			dirty = true;
			schedule();
		},
		cancel() {
			cancelled = true;
			dirty = false;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
		},
	};
}
