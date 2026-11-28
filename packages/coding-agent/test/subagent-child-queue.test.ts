import { expect, test } from "vitest";
import type { StepSubagentResultRecord, StepSubagentRunResult } from "../src/features/step-subagent.ts";
import { parseJsonEvent } from "../src/features/step-subagent.ts";
import { emptyUsage } from "../src/features/subagent/helpers.ts";
import { readSubagentLaneSnapshot } from "../src/features/subagent/lane-events.ts";
import { liveRecord, liveRoster } from "../src/features/subagent/projection.ts";

/**
 * A child's model calls wait in Step's queue on their own. The parent sees them as `model_queue` frames of the
 * child's rpc stream (the runner starts it with `--include-live-events`); they fold into one `queue` on the live
 * record, shown by the call updated last, and never reach a final result.
 */

function emptyResult(): StepSubagentRunResult {
	return { messages: [], stderr: "", exitCode: 0, usage: emptyUsage() };
}

const frame = (queueId: string, queue: unknown) => JSON.stringify({ type: "model_queue", queueId, queue });

function record(queue?: StepSubagentRunResult["queue"]): StepSubagentResultRecord {
	return {
		...emptyResult(),
		agent: "general",
		agentSource: "builtin",
		task: "inspect",
		status: "running",
		...(queue ? { queue } : {}),
	};
}

test("a child's queue frame sets its live queue, and leaving the line clears it", () => {
	const current = emptyResult();
	parseJsonEvent(frame("a", { state: "waiting", position: 3 }), current, undefined);
	expect(current.queue).toEqual({ state: "waiting", position: 3 });
	parseJsonEvent(frame("a", { state: "ready" }), current, undefined);
	expect(current.queue).toEqual({ state: "ready" });
	parseJsonEvent(frame("a", null), current, undefined);
	expect(current.queue).toBeUndefined();
	expect("queue" in current).toBe(false);
});

test("several calls in line fold into the one updated last, and one leaving keeps the others", () => {
	const current = emptyResult();
	parseJsonEvent(frame("a", { state: "waiting", position: 3 }), current, undefined);
	parseJsonEvent(frame("b", { state: "waiting", position: 7 }), current, undefined);
	expect(current.queue).toEqual({ state: "waiting", position: 7 });
	// A moved up the line, so it is the one updated last even though it started first.
	parseJsonEvent(frame("a", { state: "waiting", position: 1 }), current, undefined);
	expect(current.queue).toEqual({ state: "waiting", position: 1 });
	parseJsonEvent(frame("a", null), current, undefined);
	expect(current.queue).toEqual({ state: "waiting", position: 7 });
	parseJsonEvent(frame("b", null), current, undefined);
	expect(current.queue).toBeUndefined();
});

test("two children never share a fold", () => {
	const one = emptyResult();
	const other = emptyResult();
	parseJsonEvent(frame("a", { state: "waiting", position: 2 }), one, undefined);
	parseJsonEvent(frame("a", null), other, undefined);
	expect(one.queue).toEqual({ state: "waiting", position: 2 });
	expect(other.queue).toBeUndefined();
});

test("malformed queue frames never invent a place in line", () => {
	const current = emptyResult();
	// No queue id: nothing to fold.
	parseJsonEvent(
		JSON.stringify({ type: "model_queue", queue: { state: "waiting", position: 1 } }),
		current,
		undefined,
	);
	expect(current.queue).toBeUndefined();
	// An unknown phase is not a place in line.
	parseJsonEvent(frame("a", { state: "something_new", position: 1 }), current, undefined);
	expect(current.queue).toBeUndefined();
	// A position that is not a place is dropped; the phase still shows.
	parseJsonEvent(frame("a", { state: "waiting", position: -1 }), current, undefined);
	expect(current.queue).toEqual({ state: "waiting" });
	parseJsonEvent(frame("a", { state: "waiting", position: 1.5 }), current, undefined);
	expect(current.queue).toEqual({ state: "waiting" });
	parseJsonEvent(frame("a", "waiting"), current, undefined);
	expect(current.queue).toBeUndefined();
});

test("a queue frame reaches the parent's update callback as a live frame", () => {
	const current = emptyResult();
	const seen: Array<StepSubagentRunResult["queue"]> = [];
	parseJsonEvent(frame("a", { state: "waiting", position: 2 }), current, (result) => seen.push(result.queue));
	expect(seen).toEqual([{ state: "waiting", position: 2 }]);
});

test("the live projection carries the queue field by field, and omits it when there is none", () => {
	expect(liveRecord(record()).queue).toBeUndefined();
	expect("queue" in liveRecord(record())).toBe(false);
	expect(liveRecord(record({ state: "waiting", position: 4 })).queue).toEqual({ state: "waiting", position: 4 });
	expect(liveRecord(record({ state: "ready" })).queue).toEqual({ state: "ready" });
	// Anything beyond the known fields stays behind.
	const wide = record({ state: "waiting", position: 1, eta: 30 } as unknown as StepSubagentRunResult["queue"]);
	expect(liveRecord(wide).queue).toEqual({ state: "waiting", position: 1 });
	expect(liveRoster([record({ state: "ready" })]).results[0]?.queue).toEqual({ state: "ready" });
});

function lane(queue: unknown) {
	const row = { ...liveRecord(record()), ...(queue === undefined ? {} : { queue }) };
	return {
		laneId: "lane_1",
		status: "running",
		details: {
			mode: "single",
			agentScope: "user",
			userAgentsDir: "/tmp/agents",
			projectAgentsDir: null,
			agentId: "lane_1",
			status: "running",
			results: [row],
		},
	};
}

test("a lane snapshot keeps the child's queue across the validation boundary", () => {
	expect(readSubagentLaneSnapshot(lane(undefined))?.details.results[0]?.queue).toBeUndefined();
	expect(readSubagentLaneSnapshot(lane({ state: "waiting", position: 2 }))?.details.results[0]?.queue).toEqual({
		state: "waiting",
		position: 2,
	});
	expect(readSubagentLaneSnapshot(lane({ state: "ready" }))?.details.results[0]?.queue).toEqual({ state: "ready" });
});

test("a lane snapshot with a malformed queue is refused whole, never half trusted", () => {
	expect(readSubagentLaneSnapshot(lane({ state: "bogus" }))).toBeUndefined();
	expect(readSubagentLaneSnapshot(lane({ state: "waiting", position: -1 }))).toBeUndefined();
	expect(readSubagentLaneSnapshot(lane("waiting"))).toBeUndefined();
});
