/**
 * Host-observed timing of each thinking block in an assistant reply.
 *
 * The clock starts when a block's first thinking event arrives and stops when
 * the model moves on (text, a tool call, the end of the message) — never from
 * message creation, and never inferred from provider content. One
 * `step.thinking_timing` custom entry is written per reply once every observed
 * block has stopped, outside the model context.
 *
 * Earlier web builds wrote the same data as `stepcode-web.thinking-timing`;
 * readers accept both names.
 */

import type { AgentEvent } from "@step-harness/agent-core";
import type { AgentSessionEvent } from "./agent-session.ts";
import type { SessionEntry } from "./session-manager.ts";

export const THINKING_TIMING_ENTRY_TYPE = "step.thinking_timing";
/** Name written by web builds before the session recorded thinking timing itself. */
export const LEGACY_THINKING_TIMING_ENTRY_TYPE = "stepcode-web.thinking-timing";

export function isThinkingTimingEntryType(customType: string | undefined): boolean {
	return customType === THINKING_TIMING_ENTRY_TYPE || customType === LEGACY_THINKING_TIMING_ENTRY_TYPE;
}

export interface ThinkingTiming {
	readonly startedAt: number;
	readonly endedAt?: number;
}

/** Keyed by the thinking block's index in the assistant message's `content`. */
export type ThinkingTimings = Readonly<Record<string, ThinkingTiming>>;

export interface ThinkingObservation {
	readonly version: 1;
	readonly messageTimestamp: number;
	/** Session entry of the reply; absent in entries written before it was recorded. */
	readonly assistantEntryId?: string;
	readonly thinkingTimings: ThinkingTimings;
}

/** Validate host-owned metadata, never provider content or inferred message durations. */
export function readThinkingObservation(value: unknown): ThinkingObservation | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		typeof record.messageTimestamp !== "number" ||
		!Number.isFinite(record.messageTimestamp) ||
		!record.thinkingTimings ||
		typeof record.thinkingTimings !== "object" ||
		Array.isArray(record.thinkingTimings)
	)
		return undefined;
	const timings: Record<string, ThinkingTiming> = {};
	for (const [key, value] of Object.entries(record.thinkingTimings)) {
		if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) > 10000 || !value || typeof value !== "object") return undefined;
		const timing = value as Record<string, unknown>;
		if (
			typeof timing.startedAt !== "number" ||
			!Number.isFinite(timing.startedAt) ||
			typeof timing.endedAt !== "number" ||
			!Number.isFinite(timing.endedAt) ||
			timing.endedAt < timing.startedAt
		)
			return undefined;
		timings[key] = { startedAt: timing.startedAt, endedAt: timing.endedAt };
	}
	return {
		version: 1,
		messageTimestamp: record.messageTimestamp,
		...(typeof record.assistantEntryId === "string" && record.assistantEntryId
			? { assistantEntryId: record.assistantEntryId }
			: {}),
		thinkingTimings: timings,
	};
}

/** Saved timings by the reply's `message.timestamp`, from either entry name. */
export function savedThinkingTimings(entries: readonly SessionEntry[]): ReadonlyMap<number, ThinkingTimings> {
	const result = new Map<number, ThinkingTimings>();
	for (const entry of entries) {
		if (entry.type !== "custom" || !isThinkingTimingEntryType(entry.customType)) continue;
		const observation = readThinkingObservation(entry.data);
		if (observation) result.set(observation.messageTimestamp, observation.thinkingTimings);
	}
	return result;
}

/** One observer per bound session; clocks start only on actual thinking stream events. */
export class ThinkingClock {
	private messageTimestamp?: number;
	private timings: Record<string, ThinkingTiming> = {};
	private saved = false;

	observe(event: AgentEvent | AgentSessionEvent, now = Date.now()): ThinkingTimings | undefined {
		if (
			(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "assistant"
		) {
			if (event.message.timestamp !== this.messageTimestamp) {
				this.messageTimestamp = event.message.timestamp;
				this.timings = {};
				this.saved = false;
			}
			if (event.type === "message_update") {
				const delta = event.assistantMessageEvent;
				if ("contentIndex" in delta) {
					const index = delta.contentIndex;
					if (Number.isInteger(index) && index >= 0 && index <= 10000) {
						if (delta.type === "thinking_start" || delta.type === "thinking_delta") {
							this.stop(now, index);
							this.timings[index] ??= { startedAt: now };
						} else if (delta.type === "thinking_end") {
							const timing = this.timings[index];
							if (timing && timing.endedAt === undefined)
								this.timings[index] = { ...timing, endedAt: Math.max(timing.startedAt, now) };
						} else if (delta.type.startsWith("text_") || delta.type.startsWith("toolcall_")) {
							this.stop(now);
						}
					}
				}
			}
			if (event.type === "message_end") this.stop(now);
			return { ...this.timings };
		}
		if (event.type === "tool_execution_start" || event.type === "agent_end" || event.type === "agent_settled") {
			this.stop(now);
			return { ...this.timings };
		}
		return undefined;
	}

	private stop(now: number, except?: number): void {
		for (const [index, timing] of Object.entries(this.timings)) {
			if (Number(index) !== except && timing.endedAt === undefined)
				this.timings[index] = { ...timing, endedAt: Math.max(timing.startedAt, now) };
		}
	}

	/** A single metadata entry per message, only after every observed block has stopped. */
	completed(assistantEntryId?: string): ThinkingObservation | undefined {
		if (
			this.saved ||
			this.messageTimestamp === undefined ||
			!Object.keys(this.timings).length ||
			Object.values(this.timings).some((timing) => timing.endedAt === undefined)
		)
			return undefined;
		this.saved = true;
		return {
			version: 1,
			messageTimestamp: this.messageTimestamp,
			...(assistantEntryId ? { assistantEntryId } : {}),
			thinkingTimings: { ...this.timings },
		};
	}
}
