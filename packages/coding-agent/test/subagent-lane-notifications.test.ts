import { describe, expect, test } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { BackgroundAgentLane, StepSubagentResultRecord } from "../src/features/step-subagent.ts";
import { notifyLaneEvent, notifyLaneFinal } from "../src/features/subagent/lane-events.ts";

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
		id: "lane-1",
		status: "failed",
		subscribe: "final",
		details: { results: [] },
		lastProgressNotifyAt: 0,
		...overrides,
	} as unknown as BackgroundAgentLane;
}

describe("lane failure notifications", () => {
	test("a failed lane always carries each failed task's reason", () => {
		const { pi, sent } = fakePi();
		notifyLaneFinal(
			pi,
			lane({
				result: { content: [{ type: "text", text: "partial output without the cause" }], details: undefined },
				details: {
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

	test("a reason already present in the output is not repeated", () => {
		const { pi, sent } = fakePi();
		notifyLaneFinal(
			pi,
			lane({
				result: { content: [{ type: "text", text: "task failed: provider returned 500" }], details: undefined },
				details: { results: [record({ status: "failed", errorMessage: "provider returned 500" })] },
			} as unknown as Partial<BackgroundAgentLane>),
		);
		expect(sent[0]?.content).not.toContain("Failure reasons:");
	});

	test("a failed lane with no output still reports the cause", () => {
		const { pi, sent } = fakePi();
		notifyLaneFinal(
			pi,
			lane({
				details: { results: [record({ status: "failed" })] },
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

	test("subscribe none suppresses restart notifications too", () => {
		const { pi, sent } = fakePi();
		notifyLaneEvent(pi, lane({ status: "running", subscribe: "none" }), "background_restarted");
		expect(sent).toHaveLength(0);
	});
});
