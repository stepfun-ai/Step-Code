import type { AssistantMessage } from "@step-harness/providers";
import { describe, expect, it } from "vitest";
import { RequestLedger, type RequestUsageProvenance, rememberRequestUsage } from "../src/core/request-provenance.ts";

function provenance(requestId: string, outcome: RequestUsageProvenance["outcome"] = "ok"): RequestUsageProvenance {
	return {
		requestId,
		sessionId: "s",
		sourceLeafId: null,
		reasoningAtDispatch: "off",
		requestedProvider: "p",
		requestedModel: "m",
		outcome,
	};
}

function message(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "p",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

describe("RequestLedger", () => {
	it("claims the provenance a reply carries and removes it from the ledger", () => {
		const ledger = new RequestLedger();
		const reply = message("stop");
		const value = provenance("a");
		rememberRequestUsage(reply, value);
		ledger.record(value, undefined);
		expect(ledger.claimReply(reply)).toBe(value);
		// A later synthesized failure must not take the already-claimed request.
		expect(ledger.claimReply(message("error"))).toBeUndefined();
	});

	it("gives a synthesized error message the latest failed reply request, never a summary's", () => {
		const ledger = new RequestLedger();
		ledger.record(provenance("summary", "transport_error"), "compaction");
		ledger.record(provenance("ok-reply"), undefined);
		ledger.record(provenance("failed", "transport_error"), undefined);
		expect(ledger.claimReply(message("error"))?.requestId).toBe("failed");
		// A normal reply without provenance does not borrow another request's record.
		expect(ledger.claimReply(message("stop"))).toBeUndefined();
		expect(ledger.claimPurpose("compaction").map((value) => value.requestId)).toEqual(["summary"]);
		expect(ledger.claimPurpose("compaction")).toEqual([]);
	});
});
