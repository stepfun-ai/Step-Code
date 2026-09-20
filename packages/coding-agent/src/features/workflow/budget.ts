import os from "node:os";
import { emptyWorkflowUsage, mergeWorkflowUsage, type WorkflowUsage, workflowUsageTokens } from "./types.ts";

const DEFAULT_MAX_CONCURRENCY = 16;
const HARD_MAX_CONCURRENCY = 32;
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
	return Math.max(1, Math.min(HARD_MAX_CONCURRENCY, Math.floor(value)));
}

export function clampWorkflowAgentLimit(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_AGENTS;
	return Math.max(1, Math.min(DEFAULT_MAX_AGENTS, Math.floor(value)));
}

/** FIFO semaphore used by agent() so VM scripts cannot fan out unbounded work. */
export class WorkflowSemaphore {
	private readonly limit: number;
	private activeCount = 0;
	private peakCount = 0;
	private readonly waiters: Array<{
		resolve: (release: () => void) => void;
		reject: (error: Error) => void;
		signal?: AbortSignal;
		onAbort?: () => void;
	}> = [];

	constructor(limit: number) {
		this.limit = clampWorkflowConcurrency(limit, limit + 2);
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

	async acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) throw new Error("Workflow operation was aborted");
		if (this.activeCount < this.limit) {
			this.activeCount += 1;
			this.peakCount = Math.max(this.peakCount, this.activeCount);
			return this.makeRelease();
		}
		return new Promise<() => void>((resolve, reject) => {
			const waiter: (typeof this.waiters)[number] = { resolve, reject, signal };
			this.waiters.push(waiter);
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
