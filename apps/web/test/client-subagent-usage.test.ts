import assert from "node:assert/strict";
import test from "node:test";
import { subagentTasks } from "../client/src/state/subagent-tasks.ts";
import {
	cacheRates,
	compactTokens,
	formatRate,
	readMessageUsage,
	sumUsage,
	usageFromEntries,
	usageFromTask,
} from "../client/src/state/subagent-usage.ts";
import type { SessionEntry } from "../client/src/state/types.ts";

/**
 * A subagent spends its tokens in a child session, so nothing else in the UI
 * accounts for them. These cases pin how the panel derives the run's figures:
 * the tool result's own sums when present, the transcript otherwise, and a cache
 * rate that is reported as unknown rather than as zero when there is no
 * denominator.
 */

const usage = (overrides: Record<string, unknown> = {}) => ({
	input: 1000,
	output: 200,
	cacheRead: 8000,
	cacheWrite: 100,
	totalTokens: 9300,
	...overrides,
});

test("the tool result's totals reach the task, tokens included", () => {
	const details = {
		mode: "single",
		results: [
			{
				agent: "general",
				task: "audit",
				status: "completed",
				model: "step-5-preview",
				usage: { ...usage(), turns: 3, cost: 0.02, contextTokens: 9300 },
			},
		],
	};
	const [task] = subagentTasks({}, details, "completed");
	assert.ok(task?.usage);
	assert.equal(task.usage.records, 3, "records is the turn count the kernel reported");
	assert.equal(task.usage.input, 1000);
	assert.equal(task.usage.cacheRead, 8000);
	assert.equal(task.usage.total, 9300, "the provider's total is kept, not re-derived");
	assert.equal(task.usage.cost, 0.02);
});

test("a total the provider did not report is the sum of its parts", () => {
	const totals = readMessageUsage({ input: 10, output: 5, cacheRead: 100, cacheWrite: 2 });
	assert.equal(totals?.total, 117);
});

test("an unusable usage record is dropped, not zeroed into the figures", () => {
	for (const value of [undefined, null, {}, { input: "10" }, { input: Number.NaN }, []]) {
		assert.equal(readMessageUsage(value), undefined, JSON.stringify(value));
	}
	// One number is enough: a provider may omit the other half.
	assert.deepEqual(readMessageUsage({ input: 7 }), {
		input: 7,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 7,
	});
});

test("the transcript sum counts assistant usage only", () => {
	const entries = [
		{ id: "u", type: "message", message: { role: "user", content: "task" } },
		{ id: "a1", type: "message", message: { role: "assistant", content: [], usage: usage() } },
		{ id: "t", type: "message", message: { role: "toolResult", toolName: "read" } },
		{ id: "a2", type: "message", message: { role: "assistant", content: [], usage: usage({ input: 0, output: 0, cacheRead: 500, cacheWrite: 0, totalTokens: 500 }) } },
	] as unknown as SessionEntry[];
	const totals = usageFromEntries(entries);
	assert.equal(totals?.records, 2);
	assert.equal(totals?.input, 1000);
	assert.equal(totals?.cacheRead, 8500);
	assert.equal(totals?.total, 9800);
});

test("a transcript with no assistant usage reports nothing at all", () => {
	assert.equal(usageFromEntries([] as unknown as SessionEntry[]), undefined);
	assert.equal(
		usageFromEntries([{ id: "u", type: "message", message: { role: "user", content: "hi" } }] as unknown as SessionEntry[]),
		undefined,
	);
});

test("the run's own totals win over the transcript", () => {
	const task = { agent: "a", task: "t", status: "completed" as const, usage: { records: 2, ...readMessageUsage(usage())! } };
	const transcript = { records: 9, input: 999, output: 0, cacheRead: 0, cacheWrite: 0, total: 999 };
	assert.deepEqual(usageFromTask(task), task.usage);
	assert.notDeepEqual(usageFromTask(task), transcript);
	// A task whose details carried no usage falls back to the transcript.
	assert.equal(usageFromTask({ agent: "a", task: "t", status: "completed" }), undefined);
});

test("cache rates are the two questions people ask, and unknown stays unknown", () => {
	const totals = { records: 1, input: 1000, output: 200, cacheRead: 8000, cacheWrite: 100, total: 9300 };
	const rates = cacheRates(totals);
	// 8000 / (1000 + 8000 + 100)
	assert.equal(Number(rates.context?.toFixed(4)), 0.8791);
	// 8000 / 9300
	assert.equal(Number(rates.total?.toFixed(4)), 0.8602);
	assert.equal(formatRate(rates.context), "87.9%");

	// Nothing sent: a rate would be a division by zero, so it is not reported as 0%.
	const empty = cacheRates({ records: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
	assert.equal(empty.context, undefined);
	assert.equal(empty.total, undefined);
	assert.equal(formatRate(undefined), "—");
});

test("a dispatch of several runs adds up, and only the parts that reported usage", () => {
	const one = { records: 1, input: 100, output: 10, cacheRead: 900, cacheWrite: 0, total: 1010, cost: 0.01 };
	const two = { records: 2, input: 50, output: 5, cacheRead: 400, cacheWrite: 0, total: 455, cost: 0.02 };
	const sums = sumUsage([one, undefined, two]);
	assert.equal(sums?.records, 3);
	assert.equal(sums?.input, 150);
	assert.equal(sums?.cacheRead, 1300);
	assert.equal(sums?.total, 1465);
	assert.equal(Number(sums?.cost?.toFixed(4)), 0.03);
	// A dispatch where nobody reported usage has no figure to show.
	assert.equal(sumUsage([undefined, undefined]), undefined);
});

test("compact figures stay readable at every scale", () => {
	assert.equal(compactTokens(0), "0");
	assert.equal(compactTokens(999), "999");
	assert.equal(compactTokens(1000), "1k");
	assert.equal(compactTokens(12_345), "12.3k");
	assert.equal(compactTokens(999_999), "1000k");
	assert.equal(compactTokens(1_500_000), "1.5M");
});
