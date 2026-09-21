// Step-only build test fixture for agent-core tests. The generated model catalog
// is empty, so tests build the Model here (openai-completions is the Step protocol).
import type { Model } from "@step-harness/providers";

export function stepModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	const model: Model<"openai-completions"> = {
		id: "step-5-preview",
		name: "Step 5 Preview",
		api: "openai-completions",
		provider: "step",
		baseUrl: "https://api.stepfun.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
		...overrides,
	};
	return model;
}
