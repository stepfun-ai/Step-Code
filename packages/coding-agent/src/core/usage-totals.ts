import type { Usage } from "@step-harness/providers/compat";
import type { SessionEntry } from "./session-manager.ts";

export interface SessionUsage extends NormalizedUsage {
	cacheHit: number | null;
	invalid: number;
	missing: number;
}

export interface NormalizedUsage {
	/** Complete input, including cache reads and writes. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

export function normalizeUsage(raw: unknown): NormalizedUsage | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const u = raw as Record<string, unknown>;
	if (
		![u.input, u.output, u.cacheRead, u.cacheWrite].every(
			(n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
		)
	)
		return undefined;
	const input = (u.input as number) + (u.cacheRead as number) + (u.cacheWrite as number),
		output = u.output as number;
	if (!Number.isSafeInteger(input + output)) return undefined;
	return {
		input,
		output,
		cacheRead: u.cacheRead as number,
		cacheWrite: u.cacheWrite as number,
		total: input + output,
	};
}

export function entryUsage(value: unknown): { raw?: unknown; expected: boolean; assistant: boolean } {
	if (!value || typeof value !== "object") return { expected: false, assistant: false };
	const entry = value as Record<string, unknown>;
	const message = entry.message as Record<string, unknown> | undefined;
	if (entry.type === "message" && message?.role === "assistant")
		return { raw: message.usage, expected: true, assistant: true };
	if (entry.type === "message" && message?.role === "toolResult")
		return { raw: message.usage, expected: message.usage !== undefined, assistant: false };
	if (entry.type === "compaction" || entry.type === "branch_summary")
		return { raw: entry.usage, expected: entry.usage !== undefined, assistant: false };
	if (entry.type === "custom" && entry.customType === "step-auto-clm-usage") {
		const data = entry.data as Record<string, unknown> | undefined;
		return { raw: data?.usage, expected: true, assistant: false };
	}
	return { expected: false, assistant: false };
}

/** Add one validated increment. Input here excludes cache reads/writes, as in provider Usage. */
export function addUsageToTotals(totals: UsageTotals, raw: unknown): boolean {
	const usage = normalizeUsage(raw);
	if (
		!usage ||
		!Number.isSafeInteger(totals.input + totals.output + totals.cacheRead + totals.cacheWrite + usage.total)
	)
		return false;
	totals.input += usage.input - usage.cacheRead - usage.cacheWrite;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	const cost = (raw as { cost?: { total?: unknown } }).cost?.total;
	if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && Number.isFinite(totals.cost + cost))
		totals.cost += cost;
	return true;
}

/** Project the shared session ledger into the Account panel's complete-input convention. */
export function collectSessionUsage(
	entries: readonly SessionEntry[] | readonly Record<string, unknown>[],
): SessionUsage {
	const totals = createUsageTotals();
	let invalid = 0,
		missing = 0;
	for (const entry of entries) {
		const picked = entryUsage(entry);
		if (!addUsageToTotals(totals, picked.raw) && picked.expected) {
			if (picked.raw === undefined) missing++;
			else invalid++;
		}
	}
	const input = totals.input + totals.cacheRead + totals.cacheWrite;
	return {
		input,
		output: totals.output,
		cacheRead: totals.cacheRead,
		cacheWrite: totals.cacheWrite,
		total: input + totals.output,
		cacheHit: input > 0 ? totals.cacheRead / input : null,
		invalid,
		missing,
	};
}

/** Maintenance requests do not become ordinary task messages; their billing still belongs to the session. */
export function getAutoClmUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type !== "custom" || entry.customType !== "step-auto-clm-usage") return undefined;
	const data = entry.data as { usage?: Usage } | undefined;
	const usage = data?.usage;
	if (!usage?.cost || !normalizeUsage(usage) || !Number.isFinite(usage.cost.total) || usage.cost.total < 0)
		return undefined;
	return usage;
}

export interface UsageCostBreakdownEntry {
	key: string;
	cost: number;
	tokens: number;
}

/** Group attributable assistant usage by model and all other usage into a separate bucket. */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
	const totalsByKey = new Map<string, UsageTotals>();

	for (const entry of entries) {
		const picked = entryUsage(entry);
		if (!picked.expected) continue;
		const key =
			entry.type === "message" && entry.message.role === "assistant"
				? `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`
				: "Tools/summaries";

		let totals = totalsByKey.get(key);
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set(key, totals);
		}
		addUsageToTotals(totals, picked.raw);
	}

	return Array.from(totalsByKey, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
	}))
		.filter((entry) => entry.cost > 0 || entry.tokens > 0)
		.sort((a, b) => b.cost - a.cost);
}
