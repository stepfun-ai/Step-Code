import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type {
	BackgroundAgentLane,
	StepSubagentDetails,
	StepSubagentResultRecord,
} from "../src/features/step-subagent.ts";
import {
	buildLaneFinalDetail,
	completedOutputHash,
	completedResponseLines,
	notifyLaneEvent,
	readSubagentLaneSnapshot,
} from "../src/features/subagent/lane-events.ts";

/** Deliver a lane's terminal notification the way the lifecycle does. */
async function notifyLaneFinal(pi: ExtensionAPI, target: BackgroundAgentLane): Promise<void> {
	notifyLaneEvent(pi, target, "background_failed", await buildLaneFinalDetail(target, "/nonexistent-unused"));
}

interface Sent {
	content: string;
	details?: { event?: string; status?: string };
}

function fakePi(): { pi: ExtensionAPI; sent: Sent[] } {
	const sent: Sent[] = [];
	const pi = {
		sendMessage: (message: { content: string; details?: Sent["details"] }) => {
			sent.push({ content: message.content, details: message.details });
		},
	} as unknown as ExtensionAPI;
	return { pi, sent };
}

function record(overrides: Partial<StepSubagentResultRecord>): StepSubagentResultRecord {
	return {
		agent: "general",
		agentSource: "builtin",
		task: "do the thing",
		status: "completed",
		messages: [],
		stdout: "",
		stderr: "",
		exitCode: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		...overrides,
	} as StepSubagentResultRecord;
}

function lane(overrides: Partial<BackgroundAgentLane>): BackgroundAgentLane {
	return {
		id: "lane_00000001",
		status: "failed",
		subscribe: "final",
		startedAt: 0,
		updatedAt: 0,
		details: { mode: "single", results: [] },
		lastProgressNotifyAt: 0,
		...overrides,
	} as unknown as BackgroundAgentLane;
}

describe("lane failure notifications", () => {
	test("a failed lane always carries each failed task's reason", async () => {
		const { pi, sent } = fakePi();
		await notifyLaneFinal(
			pi,
			lane({
				result: { content: [{ type: "text", text: "partial output without the cause" }], details: undefined },
				details: {
					mode: "parallel",
					results: [
						record({ status: "completed" }),
						record({ status: "failed", errorMessage: "provider returned 500", step: 2 }),
						record({ status: "failed", stderr: "ENOENT: missing fixture" }),
					],
				},
			} as unknown as Partial<BackgroundAgentLane>),
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.details?.event).toBe("background_failed");
		expect(sent[0]?.content).toContain("Failure reasons:");
		expect(sent[0]?.content).toContain("provider returned 500");
		expect(sent[0]?.content).toContain("ENOENT: missing fixture");
	});

	test("a reason already present in the output is not repeated", async () => {
		const { pi, sent } = fakePi();
		await notifyLaneFinal(
			pi,
			lane({
				result: { content: [{ type: "text", text: "task failed: provider returned 500" }], details: undefined },
				details: { mode: "single", results: [record({ status: "failed", errorMessage: "provider returned 500" })] },
			} as unknown as Partial<BackgroundAgentLane>),
		);
		expect(sent[0]?.content).not.toContain("Failure reasons:");
	});

	test("a failed lane with no output still reports the cause", async () => {
		const { pi, sent } = fakePi();
		await notifyLaneFinal(
			pi,
			lane({
				details: { mode: "single", results: [record({ status: "failed" })] },
			} as unknown as Partial<BackgroundAgentLane>),
		);
		expect(sent[0]?.content).toContain("no error detail captured");
	});
});

describe("lane restart notifications", () => {
	test("background_restarted announces the respawned child", () => {
		const { pi, sent } = fakePi();
		notifyLaneEvent(
			pi,
			lane({ status: "running" }),
			"background_restarted",
			"the previous child process exited; a new child resumed its transcript from disk",
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.details?.event).toBe("background_restarted");
		expect(sent[0]?.content).toContain("restarted its child process");
		expect(sent[0]?.content).toContain("resumed its transcript");
	});
});

test("a large completed answer cannot hide the current failure, and history views stay bounded", async () => {
	const directory = await mkdtemp(join(tmpdir(), "lane-outcome-"));
	try {
		const response = {
			laneId: "lane_00000001",
			agent: "explore",
			task: "inspect",
			taskIndex: 0,
			sessionId: "subagent-fixture",
			timestamp: 1,
			output: "old report line\n".repeat(20_000),
		};
		const target = lane({
			completedResponses: Array.from({ length: 6 }, (_, index) => ({ ...response, timestamp: index })),
			result: { content: [{ type: "text", text: "CURRENT FAILURE" }], details: undefined },
			details: { mode: "single", results: [record({ status: "failed", errorMessage: "provider failed" })] },
		} as unknown as Partial<BackgroundAgentLane>);
		const detail = await buildLaneFinalDetail(target, directory);
		expect(detail).toContain("Current outcome: failed");
		expect(detail).toContain("provider failed");
		expect(detail.indexOf("CURRENT FAILURE")).toBeLessThan(detail.indexOf("Completed response"));
		expect(completedResponseLines(target, "CURRENT FAILURE").join("\n").length).toBeLessThan(16_300);
		expect(detail).toContain("earlier completed responses omitted");
		expect(target.completedResponses).toHaveLength(6);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("trailing whitespace and retained previews do not duplicate the current answer", async () => {
	const details: StepSubagentDetails = {
		mode: "single",
		agentScope: "user",
		userAgentsDir: "/fixture",
		projectAgentsDir: null,
		results: [],
	};
	for (const retained of ["the answer\n\n", "[retained preview]"]) {
		const target = lane({
			status: "completed",
			completedResponses: [
				{
					laneId: "lane_00000001",
					agent: "explore",
					task: "inspect",
					taskIndex: 0,
					sessionId: "subagent-fixture",
					timestamp: 1,
					output: retained,
					outputHash: completedOutputHash("the answer\n"),
				},
			],
			result: { content: [{ type: "text", text: "the answer\n" }], details },
		});
		expect(completedResponseLines(target, "the answer")).toEqual([]);
		const detail = await buildLaneFinalDetail(target, "/nonexistent-unused");
		expect(detail.match(/the answer/g)).toHaveLength(1);
	}
});

test("lane bus input is validated and re-projected before a host caches it", () => {
	const value = {
		laneId: "lane_00000001",
		status: "running",
		unexpected: "discard",
		details: {
			mode: "single",
			agentScope: "user",
			userAgentsDir: "/fixture",
			projectAgentsDir: null,
			agentId: "lane_00000001",
			results: [record({ status: "running", activeText: "x".repeat(20_000) })],
		},
	};
	const parsed = readSubagentLaneSnapshot(value);
	expect(parsed?.details.results[0]?.activeText?.length).toBeLessThanOrEqual(2_000);
	expect(parsed).not.toHaveProperty("unexpected");
	for (const malformed of [
		null,
		undefined,
		{},
		{ ...value, status: { toString: () => "running" } },
		{ ...value, details: { ...value.details, results: [{ ...value.details.results[0], activeText: 1 }] } },
		{
			...value,
			details: { ...value.details, results: [{ ...value.details.results[0], messages: [{ role: "assistant" }] }] },
		},
	])
		expect(readSubagentLaneSnapshot(malformed)).toBeUndefined();
});

test("short completed answers are not removed just because a later error contains them", () => {
	const target = lane({
		completedResponses: [
			{
				laneId: "lane_00000001",
				agent: "explore",
				task: "inspect",
				taskIndex: 0,
				sessionId: "subagent-fixture",
				timestamp: 1,
				output: "OK",
				outputHash: completedOutputHash("OK"),
			},
		],
	});
	expect(completedResponseLines(target, "OK, but the follow-up failed").join("\n")).toContain("Completed response");
	expect(completedResponseLines(target, "OK, but the follow-up failed").join("\n")).toContain("OK");
});

test.each([200, 1000])(
	"%i-task diagnostics retain the full metadata without hiding the current result",
	async (count) => {
		const directory = await mkdtemp(join(tmpdir(), "lane-metadata-"));
		try {
			const target = lane({
				status: "failed",
				details: {
					mode: "parallel",
					results: Array.from({ length: count }, (_, index) =>
						record({
							status: "failed",
							errorMessage: `error-${index}`,
							sessionId: `subagent-${index}`,
							sessionFile: `/sessions/${"path/".repeat(60)}child-${index}.jsonl`,
							cancelledPrompts: Array.from({ length: 20 }, () => "cancelled dialog"),
						}),
					),
				},
				result: { content: [{ type: "text", text: "CURRENT FAILURE" }], details: undefined },
				completedResponses: [
					{
						laneId: "lane_00000001",
						agent: "explore",
						task: "inspect",
						taskIndex: 0,
						sessionId: "subagent-old",
						timestamp: 1,
						output: "PREVIOUS SUCCESS",
					},
				],
			} as unknown as Partial<BackgroundAgentLane>);
			const view = await buildLaneFinalDetail(target, directory);
			expect(Buffer.byteLength(view)).toBeLessThan(40_000);
			expect(view).toContain("CURRENT FAILURE");
			expect(view).toContain("PREVIOUS SUCCESS");
			const path = JSON.parse(view.match(/Full output: ("[^\n]+")/)![1]) as string;
			const full = await readFile(path, "utf8");
			expect(full).toContain(`subagent-${count - 1}`);
			expect(full).toContain("CURRENT FAILURE");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
