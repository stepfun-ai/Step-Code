import type { AgentMessage, AgentTool } from "@step-harness/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@step-harness/providers";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import type { BackgroundAgentLane } from "../../../src/features/step-subagent.ts";
import { notifyLaneEvent } from "../../../src/features/subagent/lane-events.ts";
import { createHarness, type Harness } from "../harness.ts";

function laneEvents(messages: AgentMessage[]): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "custom" || message.customType !== "agent-notification") return [];
		const event = (message.details as { event?: string } | undefined)?.event;
		return event ? [event] : [];
	});
}

// Session 01a123da: four progress-subscribed lanes ran while the parent sat in
// minutes-long tool calls. Progress was steered, the steering queue drains one
// message per turn, and the lanes' completion notices waited behind dozens of
// queued progress notices for over half an hour.
describe("background lane notifications during a long tool call", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("delivers a completion on the next model call, not behind queued progress", async () => {
		let duringTool: (() => void) | undefined;
		const slowTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "A long tool call, e.g. sleep",
			parameters: Type.Object({}),
			execute: async () => {
				duringTool?.();
				return { content: [{ type: "text", text: "waited" }], details: {} };
			},
		};

		const harness = await createHarness({ tools: [slowTool] });
		harnesses.push(harness);
		const pi = {
			sendMessage: (message: Parameters<ExtensionAPI["sendMessage"]>[0], options?: never) => {
				void harness.session.sendCustomMessage(message, options);
			},
		} as unknown as ExtensionAPI;
		const lane = {
			id: "96e529c1",
			subscribe: "progress",
			status: "running",
			details: { results: [{ agent: "general" }] },
		} as unknown as BackgroundAgentLane;
		duringTool = () => {
			for (let turn = 1; turn <= 12; turn++) {
				notifyLaneEvent(pi, lane, "background_progress", `step 1/1; turns ${turn}`);
			}
			lane.status = "completed";
			notifyLaneEvent(pi, lane, "background_done", "REPORT");
		};

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("got the report"),
		]);

		await harness.session.prompt("start the lanes and wait");

		const messages = harness.session.messages;
		const reply = messages.findIndex((message) => message.role === "assistant" && message.stopReason === "stop");
		const beforeReply = laneEvents(messages.slice(0, reply));
		expect(beforeReply).toContain("background_done");
		expect(beforeReply.filter((event) => event === "background_progress")).toHaveLength(12);
		// Nothing is left to replay after the parent's reply: no further model calls.
		expect(laneEvents(messages.slice(reply + 1))).toEqual([]);
		expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});
});
