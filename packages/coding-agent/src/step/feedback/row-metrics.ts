/**
 * Per-row metrics for the transcript copy inside a feedback bundle.
 *
 * A session line already carries the model's usage for that message, which is
 * where a per-request cache hit rate comes from. Timing lives in the
 * `step.usage_provenance` entry written right after the message, joined by
 * `usageEntryId`. This module folds both onto the row they describe, so an
 * investigator reads one line instead of correlating three.
 *
 * The annotations are written to the **bundle copy only**. The canonical
 * session file is never rewritten: a report is a projection, and growing every
 * session on disk to serve support would be the wrong trade.
 */

import type { FeedbackRequestProvenance } from "./session-summary.ts";

/** Metrics attached to one transcript row under the `feedback` key. */
export interface FeedbackRowMetrics {
	/** 1-based turn the row belongs to (a user message opens a turn). */
	turn?: number;
	model?: string;
	provider?: string;
	stopReason?: string;
	/** Tokens this single request or result was billed for. */
	tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	/** cacheRead / (input + cacheRead) for this request alone. */
	cacheHitRate?: number;
	costUsd?: number;
	/** Wall-clock duration of the model request that produced this row. */
	durationMs?: number;
	/** Time to the first stream event; absent when nothing arrived. */
	ttftMs?: number | null;
	outcome?: "ok" | "http_error" | "transport_error";
	/** How far the model got, for an attempt that was cancelled or failed. */
	reached?: "thinking" | "text" | "toolCall";
	/** Host-observed thinking time for this message. */
	thinkingMs?: number;
	/** The server-side request this row came from. */
	requestId?: string;
	/** Tool result: call issued to result recorded, when the batch had one call. */
	elapsedMs?: number;
}

const METRICS_KEY = "feedback";

/**
 * Annotate a JSONL transcript excerpt.
 *
 * Line-oriented and tolerant: a line that is not a JSON object, or that has no
 * metrics, is passed through byte-for-byte, so an annotated transcript is still
 * a valid transcript. Returns the original text unchanged when nothing matched.
 */
export function annotateTranscriptRows(text: string): string {
	if (text.length === 0) return text;
	const rows = text.split("\n");
	const entries: Array<Record<string, unknown> | undefined> = rows.map((row) => parseRecord(row));
	const metrics = collectMetrics(entries);
	if (metrics.size === 0) return text;
	let annotated = 0;
	const output = rows.map((row, index) => {
		const entry = entries[index];
		if (!entry) return row;
		const id = typeof entry.id === "string" ? entry.id : undefined;
		const values = id ? metrics.get(id) : undefined;
		if (!values) return row;
		annotated += 1;
		return JSON.stringify({ ...entry, [METRICS_KEY]: values });
	});
	// Preserve a trailing newline: the archive is read by tools that split on it.
	const trailing = text.endsWith("\n");
	const joined = output.join("\n");
	return annotated === 0 ? text : trailing && !joined.endsWith("\n") ? `${joined}\n` : joined;
}

function parseRecord(line: string): Record<string, unknown> | undefined {
	if (line.trim().length === 0) return undefined;
	try {
		const value: unknown = JSON.parse(line);
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function collectMetrics(entries: readonly (Record<string, unknown> | undefined)[]): Map<string, FeedbackRowMetrics> {
	const metrics = new Map<string, FeedbackRowMetrics>();
	/** requestId and timing by the assistant entry they belong to. */
	const requests = new Map<string, FeedbackRequestProvenance>();
	/** thinking time by the assistant message timestamp it was observed for. */
	const thinking = new Map<number, number>();
	/** The assistant message that issued each pending tool call, for elapsed time. */
	const callOrigins = new Map<string, { entryId: string; timestamp: number; batchSize: number }>();
	let turn = 0;

	// Requests and thinking time are written *after* the message they describe,
	// so they are collected first and applied on a second pass.
	for (const entry of entries) {
		if (entry?.type === "custom") readCustom(entry);
	}

	for (const entry of entries) {
		if (!entry) continue;
		if (entry.type !== "message") continue;
		const message = asRecord(entry.message);
		if (!message) continue;
		const id = typeof entry.id === "string" ? entry.id : undefined;
		const role = message.role;
		if (role === "user") {
			turn += 1;
			continue;
		}
		if (role === "assistant") {
			const values = assistantMetrics(message, id ? requests.get(id) : undefined);
			const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;
			const thought = timestamp === undefined ? undefined : thinking.get(timestamp);
			if (values || thought) {
				metrics.set(id ?? `assistant-${metrics.size}`, {
					...(turn > 0 ? { turn } : {}),
					...(values ?? {}),
					...(thought ? { thinkingMs: thought } : {}),
				});
			}
			if (id && timestamp !== undefined) {
				const calls = Array.isArray(message.content)
					? message.content.filter((block) => asRecord(block)?.type === "toolCall").length
					: 0;
				for (const block of Array.isArray(message.content) ? message.content : []) {
					const call = asRecord(block);
					if (call?.type !== "toolCall" || typeof call.id !== "string") continue;
					callOrigins.set(call.id, { entryId: id, timestamp, batchSize: calls });
				}
			}
			continue;
		}
		if (role !== "toolResult") continue;
		const origin = typeof message.toolCallId === "string" ? callOrigins.get(message.toolCallId) : undefined;
		const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;
		// A parallel batch shares one start, so a per-call duration would be a guess.
		const elapsed =
			origin && origin.batchSize === 1 && timestamp !== undefined && timestamp >= origin.timestamp
				? timestamp - origin.timestamp
				: undefined;
		// A row with nothing to report is left exactly as it was.
		if (id && elapsed !== undefined) metrics.set(id, { ...(turn > 0 ? { turn } : {}), elapsedMs: elapsed });
	}

	return metrics;

	function readCustom(entry: Record<string, unknown>): void {
		const data = asRecord(entry.data);
		if (!data) return;
		if (entry.customType === "step.usage_provenance") {
			const entryId = data.usageEntryId;
			const requestId = data.requestId;
			if (typeof entryId !== "string" || typeof requestId !== "string") return;
			requests.set(entryId, {
				requestId,
				...(typeof data.requestedProvider === "string" ? { provider: data.requestedProvider } : {}),
				...(typeof data.requestedModel === "string" ? { model: data.requestedModel } : {}),
				...(typeof data.api === "string" ? { api: data.api } : {}),
				...(typeof data.reasoningAtDispatch === "string" ? { reasoning: data.reasoningAtDispatch } : {}),
				...(typeof data.durationMs === "number" ? { durationMs: data.durationMs } : {}),
				...(data.ttftMs === null || typeof data.ttftMs === "number" ? { ttftMs: data.ttftMs } : {}),
				...readOutcome(data.outcome),
			});
			return;
		}
		if (entry.customType === "stepcode-web.thinking-timing") {
			const messageTimestamp = data.messageTimestamp;
			const timings = asRecord(data.thinkingTimings);
			if (typeof messageTimestamp !== "number" || !timings) return;
			let total = 0;
			for (const timing of Object.values(timings)) {
				const value = asRecord(timing);
				if (typeof value?.startedAt !== "number" || typeof value.endedAt !== "number") continue;
				const elapsed = value.endedAt - value.startedAt;
				if (elapsed > 0) total += elapsed;
			}
			if (total > 0) thinking.set(messageTimestamp, total);
		}
	}
}

function assistantMetrics(
	message: Record<string, unknown>,
	request: FeedbackRequestProvenance | undefined,
): FeedbackRowMetrics | undefined {
	const usage = asRecord(message.usage);
	const tokens = usage
		? {
				input: nonNegative(usage.input),
				output: nonNegative(usage.output),
				cacheRead: nonNegative(usage.cacheRead),
				cacheWrite: nonNegative(usage.cacheWrite),
				total: nonNegative(usage.totalTokens ?? usage.total),
			}
		: undefined;
	const cacheable = tokens ? tokens.input + tokens.cacheRead : 0;
	const cost = asRecord(usage?.cost);
	const values: FeedbackRowMetrics = {
		...(tokens ? { tokens, cacheHitRate: cacheable > 0 ? tokens.cacheRead / cacheable : 0 } : {}),
		...(typeof cost?.total === "number" && Number.isFinite(cost.total) ? { costUsd: cost.total } : {}),
		...(typeof message.model === "string" ? { model: message.model } : {}),
		...(typeof message.provider === "string" ? { provider: message.provider } : {}),
		...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
		...(request?.requestId ? { requestId: request.requestId } : {}),
		...(typeof request?.durationMs === "number" ? { durationMs: request.durationMs } : {}),
		...(request?.ttftMs === null || typeof request?.ttftMs === "number" ? { ttftMs: request.ttftMs } : {}),
		...(request?.outcome ? { outcome: request.outcome } : {}),
		...(message.stopReason === "aborted" || message.stopReason === "error" ? readReached(message) : {}),
	};
	return Object.keys(values).length > 0 ? values : undefined;
}

function readReached(record: Record<string, unknown>): Pick<FeedbackRowMetrics, "reached"> {
	const content = record.content;
	if (!Array.isArray(content)) return {};
	let reached: "thinking" | "text" | "toolCall" | undefined;
	for (const part of content) {
		const type = asRecord(part)?.type;
		if (type === "toolCall") return { reached: "toolCall" };
		if (type === "text") reached = "text";
		else if (type === "thinking" && reached === undefined) reached = "thinking";
	}
	return reached ? { reached } : {};
}

function readOutcome(value: unknown): Pick<FeedbackRequestProvenance, "outcome"> {
	return value === "ok" || value === "http_error" || value === "transport_error" ? { outcome: value } : {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
