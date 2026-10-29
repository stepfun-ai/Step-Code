import { randomUUID } from "node:crypto";
import type { TagGroupCloseAttempt } from "@step-harness/web/desktop-bridge";

interface CloseTarget {
	close(): void;
}
interface Attempt {
	readonly target: CloseTarget;
	readonly document: number;
	readonly token: TagGroupCloseAttempt;
	readonly timer: ReturnType<typeof setTimeout>;
	readonly restart?: { url: string; navigate: () => Promise<void>; settle: (success: boolean) => void };
	completed: boolean;
}
/** One native group-close intention, bound to its window and committed document; never a force-close path. */
export class TagGroupCloseOwner {
	private readonly documents = new WeakMap<CloseTarget, number>();
	private attempt: Attempt | undefined;
	private readonly onCancel: () => void;
	constructor(onCancel: () => void) {
		this.onCancel = onCancel;
	}
	private create(target: CloseTarget, restart?: Attempt["restart"]): Attempt {
		const token = { attemptId: randomUUID(), expiresAt: Date.now() + 10000 };
		const attempt: Attempt = {
			target,
			document: this.documents.get(target) ?? 0,
			token,
			restart,
			completed: false,
			timer: setTimeout(() => {
				if (this.attempt === attempt) this.cancel();
			}, 10000),
		};
		this.attempt = attempt;
		return attempt;
	}
	nativeClose(target: CloseTarget): void {
		if (this.attempt?.target === target && !this.attempt.restart) return;
		this.cancel();
		this.create(target);
	}
	begin(target: CloseTarget): TagGroupCloseAttempt | null {
		const attempt = this.attempt;
		return attempt?.target === target && !attempt.completed && Date.now() < attempt.token.expiresAt
			? attempt.token
			: null;
	}
	complete(target: CloseTarget, id: string, outcome: "saved" | "failed"): boolean {
		const attempt = this.attempt;
		if (
			!attempt ||
			attempt.target !== target ||
			attempt.completed ||
			attempt.token.attemptId !== id ||
			attempt.document !== (this.documents.get(target) ?? 0) ||
			Date.now() >= attempt.token.expiresAt
		)
			return false;
		if (outcome === "failed") {
			this.cancel();
			return true;
		}
		attempt.completed = true;
		// Run after the invoke response, while retaining the document gate across the scheduling boundary.
		setTimeout(() => {
			if (this.attempt !== attempt || attempt.document !== (this.documents.get(target) ?? 0)) return;
			if (attempt.restart) {
				void attempt.restart.navigate().catch(() => {
					if (this.attempt === attempt) this.cancel();
				});
			} else target.close();
		}, 0);
		return true;
	}
	/** Initial native navigation invokes beforeunload; only a confirmed continuation repeats a vetoed navigation. */
	restart(target: CloseTarget, navigate: () => Promise<void>, url: string): Promise<boolean> {
		if (this.attempt) return Promise.resolve(false);
		return new Promise((settle) => {
			const attempt = this.create(target, { navigate, settle, url });
			void navigate().catch((error: unknown) => {
				// A renderer veto waits for its acknowledgement; actual navigation failure cancels immediately.
				if (this.attempt !== attempt) return;
				if (!(error instanceof Error && error.message.includes("ERR_ABORTED"))) {
					console.warn("stepcode desktop: group restart navigation failed", error);
					this.cancel();
				}
			});
		});
	}
	documentChanged(target: CloseTarget, url?: string): void {
		this.documents.set(target, (this.documents.get(target) ?? 0) + 1);
		if (this.attempt?.target !== target) return;
		if (this.attempt.restart && this.attempt.restart.url === url) {
			const attempt = this.attempt;
			this.attempt = undefined;
			clearTimeout(attempt.timer);
			attempt.restart?.settle(true);
		} else this.cancel();
	}
	closed(target: CloseTarget): void {
		if (this.attempt?.target !== target) return;
		const attempt = this.attempt;
		this.attempt = undefined;
		clearTimeout(attempt.timer);
		attempt.restart?.settle(false);
	}
	private cancel(): void {
		const attempt = this.attempt;
		if (!attempt) return;
		this.attempt = undefined;
		clearTimeout(attempt.timer);
		attempt.restart?.settle(false);
		this.onCancel();
	}
}
