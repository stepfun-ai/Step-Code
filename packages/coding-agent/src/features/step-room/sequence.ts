/**
 * Room event ordering: turns the push stream into a de-duplicated, ordered, gap-detecting sequence.
 *
 * Feishu may redeliver events, and a reconnecting long connection can skip some. Neither is
 * recoverable at the transport level, so the ordering gate owns three guarantees:
 *
 * - an event id is emitted at most once (`message_id`, not `event_id`);
 * - emissions follow `create_time`, with a bounded wait for stragglers;
 * - a hole is surfaced as an explicit gap so the host can backfill, never silently reordered.
 */

export interface RoomEvent {
	/** `message_id`; the dedupe key. */
	id: string;
	/** `create_time` in milliseconds. */
	createdAt: number;
}

export interface RoomSequencerOptions {
	/** How long an event may wait for an older straggler before it is emitted anyway. */
	holdMs?: number;
	/** Emit a gap when consecutive `create_time` values differ by more than this. */
	gapMs?: number;
	/** Retained ids; older entries are dropped so a long session cannot grow without bound. */
	maxSeen?: number;
}

export type RoomSequencerStep =
	| { action: "emit"; event: RoomEvent; gaps: readonly { after: number; before: number }[] }
	| { action: "hold"; id: string }
	| { action: "duplicate"; id: string };

interface Pending {
	event: RoomEvent;
	receivedAt: number;
}

const DEFAULT_HOLD_MS = 500;
const DEFAULT_GAP_MS = 2_000;
const DEFAULT_MAX_SEEN = 4_096;

export class RoomSequencer {
	private readonly holdMs: number;
	private readonly gapMs: number;
	private readonly maxSeen: number;
	private readonly pending: Pending[] = [];
	private readonly seen = new Set<string>();
	private readonly seenOrder: string[] = [];
	private lastEmittedAt: number | undefined;

	constructor(options: RoomSequencerOptions = {}) {
		this.holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
		this.gapMs = options.gapMs ?? DEFAULT_GAP_MS;
		this.maxSeen = options.maxSeen ?? DEFAULT_MAX_SEEN;
	}

	/** Accept one inbound event. `now` is the local receive time, used only for the hold window. */
	accept(event: RoomEvent, now = Date.now()): RoomSequencerStep {
		if (!event.id || !Number.isFinite(event.createdAt)) throw new Error("event needs an id and create time");
		if (this.seen.has(event.id)) return { action: "duplicate", id: event.id };
		if (this.pending.some((item) => item.event.id === event.id)) return { action: "hold", id: event.id };
		if (this.lastEmittedAt !== undefined && event.createdAt < this.lastEmittedAt) {
			// Older than what we already emitted: a late arrival that cannot be reordered.
			this.markSeen(event.id);
			return { action: "emit", event, gaps: [] };
		}
		this.pending.push({ event, receivedAt: now });
		this.pending.sort((a, b) => a.event.createdAt - b.event.createdAt);
		return { action: "hold", id: event.id };
	}

	/**
	 * Drain events that are safe to emit. The oldest pending event is released once it waited
	 * `holdMs`, or immediately when a newer event is already queued — both mean no earlier straggler
	 * can still arrive ahead of it. The newest event keeps waiting, so `flush` stays meaningful.
	 */
	drain(now = Date.now()): readonly RoomSequencerStep[] {
		const steps: RoomSequencerStep[] = [];
		while (this.pending.length > 1) {
			const oldest = this.pending.shift();
			if (oldest) steps.push(this.emit(oldest.event));
		}
		const last = this.pending[0];
		if (last && now - last.receivedAt >= this.holdMs) {
			this.pending.length = 0;
			steps.push(this.emit(last.event));
		}
		return steps;
	}

	/** Release everything immediately, e.g. on shutdown, accepting that stragglers may be reordered. */
	flush(): readonly RoomSequencerStep[] {
		const steps = this.pending.map((item) => this.emit(item.event));
		this.pending.length = 0;
		return steps;
	}

	pendingCount(): number {
		return this.pending.length;
	}

	private emit(event: RoomEvent): RoomSequencerStep {
		const gaps: { after: number; before: number }[] = [];
		if (this.lastEmittedAt !== undefined && event.createdAt - this.lastEmittedAt > this.gapMs) {
			gaps.push({ after: this.lastEmittedAt, before: event.createdAt });
		}
		this.lastEmittedAt = Math.max(this.lastEmittedAt ?? event.createdAt, event.createdAt);
		this.markSeen(event.id);
		return { action: "emit", event, gaps };
	}

	private markSeen(id: string): void {
		this.seen.add(id);
		this.seenOrder.push(id);
		if (this.seenOrder.length <= this.maxSeen) return;
		const evicted = this.seenOrder.splice(0, this.seenOrder.length - this.maxSeen);
		for (const key of evicted) this.seen.delete(key);
	}
}
