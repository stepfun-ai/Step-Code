import os from "node:os";
import { emptyWorkflowUsage, mergeWorkflowUsage, type WorkflowUsage, workflowUsageTokens } from "./types.ts";

const DEFAULT_MAX_CONCURRENCY = 16;
const DEFAULT_MAX_AGENTS = 1000;

/** Raised when a workflow cannot afford another completed agent call. */
export class WorkflowBudgetExceeded extends Error {
	readonly total: number;
	readonly spentTokens: number;
	readonly requestedTokens: number;

	constructor(total: number, spentTokens: number, requestedTokens: number) {
		super(
			requestedTokens === 0 && spentTokens === total
				? `Workflow token budget exhausted (${spentTokens}/${total}); no budget remains for another agent call`
				: `Workflow token budget exceeded (${spentTokens + requestedTokens} > ${total})`,
		);
		this.name = "WorkflowBudgetExceeded";
		this.total = total;
		this.spentTokens = spentTokens;
		this.requestedTokens = requestedTokens;
	}
}

/** A token budget measured in provider input + output tokens. */
export class WorkflowBudget {
	private readonly limit: number | null;
	private usage: WorkflowUsage = emptyWorkflowUsage();

	constructor(total: number | null | undefined) {
		if (total === null || total === undefined) {
			this.limit = null;
		} else if (Number.isFinite(total) && total >= 0) {
			this.limit = Math.floor(total);
		} else {
			throw new Error("Workflow budget must be null or a non-negative finite number");
		}
	}

	total(): number | null {
		return this.limit;
	}

	spent(): number {
		return workflowUsageTokens(this.usage);
	}

	remaining(): number {
		return this.limit === null ? Number.POSITIVE_INFINITY : Math.max(0, this.limit - this.spent());
	}

	usageSnapshot(): WorkflowUsage {
		return { ...this.usage };
	}

	/** Account usage and fail closed when the call crossed the configured limit. */
	consume(addition: Partial<WorkflowUsage> | undefined): void {
		const requested = workflowUsageTokens(addition);
		const spentBefore = this.spent();
		this.usage = mergeWorkflowUsage(this.usage, addition);
		if (this.limit !== null && spentBefore + requested > this.limit) {
			throw new WorkflowBudgetExceeded(this.limit, spentBefore, requested);
		}
	}
}

/** Resolve the bounded default used by parallel workflow calls. */
export function defaultWorkflowConcurrency(cpuCount = os.cpus().length): number {
	const safeCpuCount = Number.isFinite(cpuCount) && cpuCount > 0 ? Math.floor(cpuCount) : 1;
	return Math.max(1, Math.min(DEFAULT_MAX_CONCURRENCY, safeCpuCount - 2));
}

export function clampWorkflowConcurrency(value: number | undefined, cpuCount = os.cpus().length): number {
	const fallback = defaultWorkflowConcurrency(cpuCount);
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(1, Math.min(fallback, Math.floor(value)));
}

/** Empty optional environment values mean no configured provider override. */
export function configuredWorkflowConcurrencyLimit(
	raw = process.env.STEP_WORKFLOW_CONCURRENCY_LIMIT,
): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function clampWorkflowAgentLimit(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_AGENTS;
	return Math.max(1, Math.min(DEFAULT_MAX_AGENTS, Math.floor(value)));
}

/**
 * Upper bound for an admission cooldown caused by a 429.
 *
 * A server's `Retry-After` can be hours, or a far-future HTTP date, and the node's
 * own retry deliberately honors it verbatim. The admission window is shared by every
 * workflow in the process and its queue time is excluded from node timeouts, so an
 * unbounded cooldown would stall unrelated workflows indefinitely with no error and
 * no timeout. The adaptive cap reduction below is what actually protects the provider;
 * this bound only decides how long the window pauses before probing again.
 */
const MAX_THROTTLE_COOLDOWN_MS = 30_000;

/** FIFO semaphore used by agent() so VM scripts cannot fan out unbounded work. */
export class WorkflowSemaphore {
	private limit: number;
	private ceiling: number;
	private disposed = false;
	private generation = 0;
	private successes = 0;
	private cooldownUntil = 0;
	private wakeup?: ReturnType<typeof setTimeout>;
	private activeCount = 0;
	private peakCount = 0;
	private readonly waiters: Array<{
		resolve: (release: () => void) => void;
		reject: (error: Error) => void;
		signal?: AbortSignal;
		onAbort?: () => void;
	}> = [];

	constructor(limit: number) {
		this.limit = Math.max(1, Math.floor(limit));
		this.ceiling = this.limit;
	}

	get epoch(): number {
		return this.generation;
	}

	setCeiling(ceiling: number): void {
		if (ceiling === this.ceiling) return;
		const wasAtCeiling = this.limit === this.ceiling;
		this.ceiling = ceiling;
		this.limit = wasAtCeiling ? ceiling : Math.min(this.limit, ceiling);
		this.generation++;
		this.successes = 0;
		this.drain();
	}

	throttle(epoch: number, delayMs: number): void {
		if (this.disposed) return;
		this.successes = 0;
		if (epoch === this.generation) {
			this.limit = Math.max(1, Math.floor(this.limit * 0.75));
			this.generation++;
		}
		const cooldownMs = Number.isFinite(delayMs) ? Math.max(0, Math.min(MAX_THROTTLE_COOLDOWN_MS, delayMs)) : 0;
		this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + cooldownMs);
		this.scheduleDrain();
	}

	succeeded(epoch: number): void {
		if (this.disposed) return;
		if (epoch !== this.generation) return;
		if (++this.successes >= 4 && this.waiters.length > 0 && this.limit < this.ceiling) {
			this.limit++;
			this.successes = 0;
			this.drain();
		}
	}

	private scheduleDrain(): void {
		if (this.wakeup) clearTimeout(this.wakeup);
		this.wakeup = setTimeout(
			() => {
				this.wakeup = undefined;
				this.drain();
			},
			Math.min(2_147_483_647, Math.max(0, this.cooldownUntil - Date.now())),
		);
	}

	dispose(): void {
		this.disposed = true;
		if (this.wakeup) clearTimeout(this.wakeup);
		for (const waiter of this.waiters.splice(0)) {
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(new Error("Workflow admission is closed"));
		}
	}

	get active(): number {
		return this.activeCount;
	}

	get peak(): number {
		return this.peakCount;
	}

	get max(): number {
		return this.limit;
	}

	/** True while congestion has lowered the cap or a cooldown is still pending. */
	get throttled(): boolean {
		return this.limit < this.ceiling || Date.now() < this.cooldownUntil;
	}

	/** Stop the cooldown timer while no run is attached; cap and cooldown are kept. */
	park(): void {
		if (this.wakeup) clearTimeout(this.wakeup);
		this.wakeup = undefined;
	}

	async acquire(signal?: AbortSignal): Promise<() => void> {
		if (this.disposed) throw new Error("Workflow admission is closed");
		if (signal?.aborted) throw new Error("Workflow operation was aborted");
		if (this.activeCount < this.limit && Date.now() >= this.cooldownUntil && this.waiters.length === 0) {
			this.activeCount += 1;
			this.peakCount = Math.max(this.peakCount, this.activeCount);
			return this.makeRelease();
		}
		return new Promise<() => void>((resolve, reject) => {
			const waiter: (typeof this.waiters)[number] = { resolve, reject, signal };
			this.waiters.push(waiter);
			if (!this.wakeup && Date.now() < this.cooldownUntil) this.scheduleDrain();
			if (signal) {
				const onAbort = (): void => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					signal.removeEventListener("abort", onAbort);
					reject(new Error("Workflow operation was aborted"));
				};
				waiter.onAbort = onAbort;
				signal.addEventListener("abort", onAbort, { once: true });
			}
		});
	}

	private makeRelease(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.activeCount = Math.max(0, this.activeCount - 1);
			this.drain();
		};
	}

	private drain(): void {
		if (this.disposed) return;
		if (Date.now() < this.cooldownUntil) {
			this.scheduleDrain();
			return;
		}
		while (this.activeCount < this.limit && this.waiters.length > 0) {
			const waiter = this.waiters.shift();
			if (!waiter) return;
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal?.aborted) {
				waiter.reject(new Error("Workflow operation was aborted"));
				continue;
			}
			this.activeCount += 1;
			this.peakCount = Math.max(this.peakCount, this.activeCount);
			waiter.resolve(this.makeRelease());
		}
	}
}
