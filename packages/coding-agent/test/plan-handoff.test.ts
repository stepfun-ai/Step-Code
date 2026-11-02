import type { AgentMessage } from "@step-harness/agent-core";
import { expect, test } from "vitest";
import { pendingHandoffText } from "../src/features/plan-handoff.ts";

const handoff = {
	role: "toolResult" as const,
	toolCallId: "handoff",
	toolName: "exit_plan_mode",
	content: [{ type: "text" as const, text: "Review this plan.\n\n# Plan\n1. Do it\n" }],
	details: {
		outcome: "external_approval_required",
		planFilePath: "/workspace/.stepcode/plans/session-example.md",
		planContents: "# Plan\n1. Do it\n",
		planHash: "a".repeat(64),
		planModeExited: false,
	},
	isError: false,
	timestamp: 1,
};

const user = { role: "user" as const, content: [{ type: "text" as const, text: "Approved." }], timestamp: 2 };

test("a waiting proposal is reported instead of the line that introduced it", () => {
	const text = pendingHandoffText({ pendingProposalHash: "a".repeat(64) }, [handoff as AgentMessage]);
	// The scan trims the joined text, so the trailing newline is gone.
	expect(text).toBe("Review this plan.\n\n# Plan\n1. Do it");
});

test("the session fact decides, not the shape of the transcript", () => {
	// A host that draws the card approves with a hidden custom message, so the
	// transcript can still end in a handoff after the decision is over.
	const messages = [handoff] as AgentMessage[];
	expect(pendingHandoffText({}, messages)).toBeUndefined();
	expect(pendingHandoffText(undefined, messages)).toBeUndefined();
});

test("a user message after the handoff ends the scan", () => {
	const messages = [handoff, user] as AgentMessage[];
	expect(pendingHandoffText({ pendingProposalHash: "a".repeat(64) }, messages)).toBeUndefined();
});
