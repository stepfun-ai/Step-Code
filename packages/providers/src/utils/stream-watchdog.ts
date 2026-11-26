import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";
import { type AssistantMessageEventStream, createAssistantMessageEventStream } from "./event-stream.ts";

/**
 * Default wait for the next provider event. It matches the Codex and DeepSeek harness
 * stream idle windows and sits above the slowest healthy first token observed on a
 * near-full 1M-token context (about 206s).
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

export interface StreamIdleWatchdogOptions {
	/** Longest wait for the next parsed provider event; 0 or less disables the watchdog. */
	idleTimeoutMs: number;
	/** Cancels the underlying request once the stream has been abandoned. */
	onTimeout: () => void;
	/** Response shell used when the provider has not produced a partial response yet. */
	fallback: () => AssistantMessage;
	/** Suspends the idle bound while the request waits outside the provider (see {@link StreamIdleHold}). */
	hold?: StreamIdleHold;
}

/**
 * Pauses a stream's idle bound while its request is deliberately held before
 * the provider answers, e.g. while the server has not admitted it yet. While any
 * acquisition is outstanding the watchdog does not fire; releasing the last one
 * starts a full idle window again.
 */
export class StreamIdleHold {
	private count = 0;
	private readonly listeners = new Set<() => void>();

	get held(): boolean {
		return this.count > 0;
	}

	/** Hold the bound; the returned function releases this acquisition (idempotent). */
	acquire(): () => void {
		this.count++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.count--;
			if (this.count === 0) for (const listener of this.listeners) listener();
		};
	}

	/** Called whenever the last acquisition is released. Returns the unsubscribe function. */
	onRelease(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

/**
 * Bound how long a provider stream may go without a parsed event.
 *
 * The HTTP idle timeout only sees bytes: a gateway that keeps sending SSE keep-alives
 * while the model makes no progress holds the request open indefinitely (one request
 * was observed producing 22 characters of thinking and then nothing for ~15 minutes).
 * Keep-alives never become events, so this timer measures progress instead of traffic.
 *
 * The timer runs only while the next event is awaited. On expiry the request is
 * cancelled and the consumer receives a transient error, so the existing retry policy
 * resends it instead of treating the stall as a user abort. The wait is abandoned
 * without waiting for the transport, because a read the abort interrupts can stay
 * pending forever.
 */
export function withStreamIdleWatchdog(
	source: AssistantMessageEventStream,
	options: StreamIdleWatchdogOptions,
): AssistantMessageEventStream {
	if (!(options.idleTimeoutMs > 0) || !Number.isFinite(options.idleTimeoutMs)) return source;
	const output = createAssistantMessageEventStream();
	void pump(source, output, options);
	return output;
}

async function pump(
	source: AssistantMessageEventStream,
	output: AssistantMessageEventStream,
	options: StreamIdleWatchdogOptions,
): Promise<void> {
	const iterator = source[Symbol.asyncIterator]();
	let partial: AssistantMessage | undefined;
	const fail = (errorMessage: string, transient: boolean): void => {
		output.push({
			type: "error",
			reason: "error",
			error: {
				...(partial ?? options.fallback()),
				stopReason: "error",
				errorMessage,
				...(transient ? { errorKind: "transient" as const } : {}),
			},
		});
	};
	for (;;) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopRearming: (() => void) | undefined;
		const expired = new Promise<"timeout">((resolve) => {
			const arm = () => {
				clearTimeout(timer);
				timer = setTimeout(() => {
					// A held request is not stalled; the release re-arms a full window.
					if (!options.hold?.held) resolve("timeout");
				}, options.idleTimeoutMs);
			};
			stopRearming = options.hold?.onRelease(arm);
			arm();
		});
		let next: IteratorResult<AssistantMessageEvent> | "timeout";
		try {
			next = await Promise.race([iterator.next(), expired]);
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error), false);
			return;
		} finally {
			clearTimeout(timer);
			stopRearming?.();
		}
		if (next === "timeout") {
			options.onTimeout();
			// Detached: the cancelled read may never settle.
			void iterator.return?.(undefined).catch(() => {});
			fail(
				`Provider stream stalled: no response data for ${Math.round(options.idleTimeoutMs / 1000)}s (stream idle timeout)`,
				true,
			);
			return;
		}
		if (next.done) {
			output.end();
			return;
		}
		const event = next.value;
		if ("partial" in event) partial = event.partial;
		output.push(event);
		if (event.type === "done" || event.type === "error") return;
	}
}
