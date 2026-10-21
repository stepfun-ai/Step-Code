import { describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { BackgroundAgentLane, StepSubagentResultRecord } from "../src/features/step-subagent.ts";
import { buildLaneFinalDetail, notifyLaneEvent } from "../src/features/subagent/lane-events.ts";

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
