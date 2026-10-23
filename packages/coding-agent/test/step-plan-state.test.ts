import { describe, expect, it } from "vitest";
import { getStepPlanState } from "../src/features/step-plan.ts";

const entry = (data: unknown) => ({ type: "custom", customType: "step-plan", data });

describe("getStepPlanState for host UI", () => {
	it("reports the latest plan entry", () => {
		expect(getStepPlanState([entry({ enabled: true, planFilePath: "/w/plans/s.md", planSource: "user" })])).toEqual({
			enabled: true,
			planFilePath: "/w/plans/s.md",
			planSource: "user",
		});
	});

	it("reports the exit recorded after an enter", () => {
		const state = getStepPlanState([
			entry({ enabled: true, planFilePath: "/w/plans/s.md", planSource: "user" }),
			entry({ enabled: false }),
		]);
		expect(state).toEqual({ enabled: false, planSource: "unknown" });
	});

	it("reports nothing when the branch records no plan state", () => {
		expect(getStepPlanState([])).toBeUndefined();
		expect(getStepPlanState([{ type: "message" }])).toBeUndefined();
	});

	it("ignores a malformed entry instead of trusting it", () => {
		expect(getStepPlanState([entry({ planFilePath: "/w/plans/s.md" })])).toBeUndefined();
		expect(getStepPlanState([entry(undefined)])).toBeUndefined();
	});
});
