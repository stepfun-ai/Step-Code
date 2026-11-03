import { expect, test } from "vitest";
import type { StepSubagentRunResult } from "../src/features/step-subagent.ts";
import {
	isFailed,
	parseJsonEvent,
	readSettledFailure,
	resultText,
	settledTurnOutcome,
} from "../src/features/step-subagent.ts";
import { emptyUsage } from "../src/features/subagent/helpers.ts";

function emptyResult(): StepSubagentRunResult {
	return { messages: [], stderr: "", exitCode: 0, usage: emptyUsage() };
}

test("a settled run without failure is a success", () => {
	expect(readSettledFailure({ type: "agent_settled" })).toBeUndefined();
});

test("a settled run that reports a failure carries its message", () => {
	expect(
		readSettledFailure({
			type: "agent_settled",
			failure: {
				kind: "incomplete_turn",
				reason: "no_visible_output",
				message: "The model returned no visible answer or executable tool call.",
			},
		}),
	).toBe("The model returned no visible answer or executable tool call.");
});

test("a settled run whose failure has no usable message still fails", () => {
	expect(readSettledFailure({ type: "agent_settled", failure: { kind: "incomplete_turn" } })).toBe(
		"The agent run ended without a usable answer.",
	);
});

test("only agent_settled reports a run-level failure", () => {
	expect(readSettledFailure({ type: "agent_end", failure: { message: "ignored" } })).toBeUndefined();
	expect(readSettledFailure({ type: "message_end", failure: { message: "ignored" } })).toBeUndefined();
});

test("the JSON projection of an empty turn keeps the provider stop reason", () => {
	const current = emptyResult();
	// The assistant message keeps `stop`, so a parent reading only message_end would
	// call this a success; the failure arrives on agent_settled instead.
	parseJsonEvent(
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "reasoning only" }],
				api: "openai-responses",
				provider: "openai",
				model: "mock",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				stopReason: "stop",
				incomplete: "no_visible_output",
				timestamp: 1,
			},
		}),
		current,
		undefined,
	);
	expect(current.stopReason).toBe("stop");
	expect(isFailed(current)).toBe(false);
	expect(resultText(current)).toBe("(no output)");
});

test("a failed lane surfaces the run failure instead of an empty answer", () => {
	const current = emptyResult();
	const failure = readSettledFailure({
		type: "agent_settled",
		failure: {
			kind: "incomplete_turn",
			reason: "missing_tool_call",
			message: "The model ended a tool-use turn without an executable tool call.",
		},
	});
	Object.assign(current, settledTurnOutcome(failure, false));
	expect(isFailed(current)).toBe(true);
	expect(resultText(current)).toBe("The model ended a tool-use turn without an executable tool call.");
});

test("a settled run without a reported failure succeeds even when the turn is empty", () => {
	const current = emptyResult();
	// The assistant message keeps `stop`, so nothing in the transcript says the run
	// failed. Only `agent_settled.failure` may, and this run did not report one.
	Object.assign(current, settledTurnOutcome(undefined, false));
	expect(current.exitCode).toBe(0);
	expect(current.stopReason).toBeUndefined();
});

test("a cancelled lane is the caller's stop, not a failure", () => {
	const current = emptyResult();
	Object.assign(current, settledTurnOutcome("whatever the run said", true));
	expect(current.stopReason).toBe("aborted");
	expect(current.errorMessage).toBe("Subagent was aborted");
});
