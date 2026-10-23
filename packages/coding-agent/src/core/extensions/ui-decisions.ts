export interface UIDecisionRequest {
	readonly kind: "select" | "confirm";
	readonly title: string;
	readonly message?: string;
	readonly options: readonly string[];
	/** Aborted after local/remote completion, timeout, cancellation or runtime teardown. */
	readonly signal: AbortSignal;
	/** Returns false for an invalid, expired or already resolved choice. */
	choose(value: string): boolean;
}

/** In-process UI arbitration only; permission policy remains with the caller. */
export class UIDecisions {
	private readonly listeners = new Set<(request: UIDecisionRequest) => void>();
	private readonly pending = new Set<() => void>();
	private closed = false;

	subscribe(listener: (request: UIDecisionRequest) => void): () => void {
		if (this.closed) return () => {};
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	run(
		request: Pick<UIDecisionRequest, "kind" | "title" | "message" | "options">,
		local: (signal: AbortSignal) => Promise<string | undefined>,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		if (this.closed || signal?.aborted) return Promise.resolve(undefined);
		const controller = new AbortController();
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (value: string | undefined, error?: unknown) => {
				if (settled) return;
				settled = true;
				this.pending.delete(cancel);
				signal?.removeEventListener("abort", cancel);
				controller.abort();
				if (error !== undefined) reject(error);
				else resolve(value);
			};
			const cancel = () => finish(undefined);
			this.pending.add(cancel);
			signal?.addEventListener("abort", cancel, { once: true });
			const options = Object.freeze([...request.options]);
			const choice = Object.freeze<UIDecisionRequest>({
				...request,
				options,
				signal: controller.signal,
				choose: (value) => {
					if (settled || !options.includes(value)) return false;
					finish(value);
					return true;
				},
			});
			try {
				// Mount the real local dialog before exposing the remote resolver.
				void local(controller.signal).then(
					(value) => finish(value !== undefined && options.includes(value) ? value : undefined),
					(error: unknown) => finish(undefined, error),
				);
				for (const listener of this.listeners) {
					if (settled) break;
					try {
						listener(choice);
					} catch {
						/* A mirror failure must leave local approval available. */
					}
				}
			} catch (error: unknown) {
				finish(undefined, error);
			}
		});
	}

	close(): void {
		this.closed = true;
		for (const cancel of this.pending) cancel();
		this.listeners.clear();
	}
}
