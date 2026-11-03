// Step-only build test fixtures. The generated model catalog is empty (MODELS={}),
// so tests build Model objects here instead of getModel("anthropic"|"openai", …).
// The model id is the neutral Step model; the `api` selects the protocol adapter
// under test (adapters are dispatched by `model.api`, not by provider/id).
import type { Api, Model } from "../../src/types.ts";

function stepFixture<A extends Api>(api: A, overrides: Partial<Model<A>>): Model<A> {
	const model: Model<Api> = {
		id: "step-5-preview",
		name: "Step 5 Preview",
		api,
		provider: "step",
		baseUrl: "https://api.stepfun.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
		...overrides,
	};
	return model as Model<A>;
}

/** openai-completions Model (the protocol the Step provider itself uses). */
export function stepModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return stepFixture("openai-completions", overrides);
}

/** anthropic-messages Model — exercises the kept anthropic-messages adapter. */
export function anthropicModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return stepFixture("anthropic-messages", overrides);
}

/** openai-responses Model — exercises the kept openai-responses adapter. */
export function responsesModel(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
	return stepFixture("openai-responses", overrides);
}
