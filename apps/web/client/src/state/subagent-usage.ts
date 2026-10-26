/**
 * Token accounting for one subagent run.
 *
 * A subagent's cost is invisible everywhere else: its turns run in a child
 * session, so the parent's usage totals do not include them. The kernel already
 * sums them per run (`step-subagent.ts`'s `usageFromMessage`) and attaches the
 * totals to the tool result, so that is the primary source. Summing the
 * transcript is the fallback: a run whose details predate the field, or a child
 * transcript inspected on its own.
 *
 * Cache rates answer the two questions people ask of a subagent: how much of the
 * *context it sent* was served from cache, and how much of *all* the tokens it
 * moved were cache reads.
 */

import type { SessionEntry, SubagentTask, SubagentUsage } from "./types";

/** Token counts, without the record count that makes them comparable. */
export type TokenTotals = Omit<SubagentUsage, "records">;

/** The two cache rates, as fractions in 0..1; `undefined` when the denominator is 0. */
export interface SubagentCacheRates {
	/** cacheRead / (input + cacheRead + cacheWrite): how much sent context was cached. */
	readonly context: number | undefined;
	/** cacheRead / total: how much of everything the run moved was a cache read. */
	readonly total: number | undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Validate one message's (or one run's) `usage`, or undefined when it carries no
 * usable numbers. A provider reports `totalTokens`; when it does not, the parts
 * are summed, which is what the parts are for.
 */
export function readMessageUsage(value: unknown): TokenTotals | undefined {
	const usage = record(value);
	if (!usage) return undefined;
	const input = count(usage.input);
	const output = count(usage.output);
	if (input === undefined && output === undefined) return undefined;
	const cacheRead = count(usage.cacheRead) ?? 0;
	const cacheWrite = count(usage.cacheWrite) ?? 0;
	const reported = count(usage.totalTokens) ?? count(usage.total);
	const cost = count(record(usage.cost)?.total) ?? count(usage.cost);
	return {
		input: input ?? 0,
		output: output ?? 0,
		cacheRead,
		cacheWrite,
		total: reported ?? (input ?? 0) + (output ?? 0) + cacheRead + cacheWrite,
		...(cost === undefined ? {} : { cost }),
	};
}

function add(total: SubagentUsage, usage: TokenTotals): SubagentUsage {
	return {
		records: total.records + 1,
		input: total.input + usage.input,
		output: total.output + usage.output,
		cacheRead: total.cacheRead + usage.cacheRead,
		cacheWrite: total.cacheWrite + usage.cacheWrite,
		total: total.total + usage.total,
		...(total.cost === undefined && usage.cost === undefined ? {} : { cost: (total.cost ?? 0) + (usage.cost ?? 0) }),
	};
}

/**
 * Sum the usage a transcript recorded.
 *
 * Only `assistant` messages carry it. A retried or rewound attempt left in the
 * same file is counted here — this is the fallback path, and a run whose details
 * carry their own totals never reaches it.
 */
export function usageFromEntries(entries: readonly SessionEntry[]): SubagentUsage | undefined {
	let total: SubagentUsage = { records: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const usage = readMessageUsage(entry.message.usage);
		if (usage) total = add(total, usage);
	}
	return total.records > 0 ? total : undefined;
}

/** The totals the tool result reported for a run, when it reported any. */
export function usageFromTask(task: SubagentTask | undefined): SubagentUsage | undefined {
	const usage = task?.usage;
	return usage && usage.records > 0 ? usage : undefined;
}

/** Sum several runs, so a parallel or chained call can report one figure. */
export function sumUsage(totals: readonly (SubagentUsage | undefined)[]): SubagentUsage | undefined {
	let sum: SubagentUsage | undefined;
	for (const total of totals) {
		if (!total) continue;
		sum = sum
			? {
					records: sum.records + total.records,
					input: sum.input + total.input,
					output: sum.output + total.output,
					cacheRead: sum.cacheRead + total.cacheRead,
					cacheWrite: sum.cacheWrite + total.cacheWrite,
					total: sum.total + total.total,
					...(sum.cost === undefined && total.cost === undefined
						? {}
						: { cost: (sum.cost ?? 0) + (total.cost ?? 0) }),
				}
			: total;
	}
	return sum;
}

/** The two cache rates for `totals`; a zero denominator is "unknown", never 0%. */
export function cacheRates(totals: SubagentUsage): SubagentCacheRates {
	const sent = totals.input + totals.cacheRead + totals.cacheWrite;
	return {
		context: sent > 0 ? totals.cacheRead / sent : undefined,
		total: totals.total > 0 ? totals.cacheRead / totals.total : undefined,
	};
}

/** `12345` -> `12.3k`; a compact figure for a strip, never a rounded-to-nothing `0k`. */
export function compactTokens(value: number): string {
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) {
		const thousands = value / 1000;
		return `${thousands >= 100 ? Math.round(thousands) : Number(thousands.toFixed(1))}k`;
	}
	const millions = value / 1_000_000;
	return `${millions >= 100 ? Math.round(millions) : Number(millions.toFixed(2))}M`;
}

/** `0.4231` -> `42.3%`; one decimal, so figures read side by side. */
export function formatRate(rate: number | undefined): string {
	if (rate === undefined) return "—";
	return `${(rate * 100).toFixed(1)}%`;
}
