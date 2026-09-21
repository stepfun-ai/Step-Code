import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createStepCodingAgentHarness } from "./step-harness.ts";

const stepCodingAgentHarness = createStepCodingAgentHarness({ noTools: "all" });

describeEval("Step Coding Agent smoke", { harness: stepCodingAgentHarness }, (it) => {
	it("runs a basic prompt end to end", async ({ run }) => {
		const result = await run("What's the capital of France? Respond with only the city name.");

		expect(result.output.trim()).toBe("Paris");
		expect(result.errors).toEqual([]);
		expect(result.usage.provider).toBe(process.env.STEP_PROVIDER);
		expect(result.usage.model).toBe(process.env.STEP_MODEL);
		expect(result.usage.totalTokens).toBeGreaterThan(0);
	});
});
