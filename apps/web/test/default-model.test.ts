import assert from "node:assert/strict";
import test from "node:test";
import { type ModelRuntime, STEP_DEFAULT_MODEL, STEP_PROVIDER_ID } from "@step-harness/coding-agent";
import { pickFallbackModel, predictDraftModel, resolveWebDefaultModel } from "../src/runtime.ts";

// Order returned by `{base}/v1/models`: the product default is listed last.
const catalog = [
	{ provider: STEP_PROVIDER_ID, id: "step-3.7-flash" },
	{ provider: STEP_PROVIDER_ID, id: "step-router-v1" },
	{ provider: STEP_PROVIDER_ID, id: STEP_DEFAULT_MODEL },
];

test("without a configured model, a Step session defaults to the product model like the CLI", () => {
	assert.deepEqual(resolveWebDefaultModel({}), { provider: STEP_PROVIDER_ID, modelId: STEP_DEFAULT_MODEL });
	assert.deepEqual(resolveWebDefaultModel({ provider: STEP_PROVIDER_ID }), {
		provider: STEP_PROVIDER_ID,
		modelId: STEP_DEFAULT_MODEL,
	});
});

test("a configured model wins, and another provider gets no Step model id", () => {
	assert.deepEqual(resolveWebDefaultModel({ model: "step-3.5-flash" }), {
		provider: STEP_PROVIDER_ID,
		modelId: "step-3.5-flash",
	});
	assert.deepEqual(resolveWebDefaultModel({ provider: "openai" }), { provider: "openai" });
});

test("the fallback prefers the default model over catalog order", () => {
	assert.equal(pickFallbackModel(catalog, resolveWebDefaultModel({}))?.id, STEP_DEFAULT_MODEL);
});

test("the fallback uses the first listed model when the default is unavailable", () => {
	assert.equal(pickFallbackModel(catalog.slice(0, 2), resolveWebDefaultModel({}))?.id, "step-3.7-flash");
	assert.equal(pickFallbackModel([], resolveWebDefaultModel({})), undefined);
});

/** Just enough of a catalog model for thinking-level resolution. */
function catalogModel(id: string, reasoning: boolean) {
	return {
		provider: STEP_PROVIDER_ID,
		id,
		name: id,
		api: "openai-completions" as const,
		baseUrl: "https://example.invalid",
		reasoning,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	};
}

/** The parts of ModelRuntime that draft prediction reads, all signed in. */
function fakeRuntime(models: ReturnType<typeof catalogModel>[]): ModelRuntime {
	const runtime = {
		getAvailableSnapshot: () => models,
		getModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		// The picker labels each provider section with its declared name.
		getProvider: (providerId: string) => ({
			id: providerId,
			name: providerId === STEP_PROVIDER_ID ? "StepFun" : providerId,
		}),
		hasConfiguredAuth: () => true,
	};
	return runtime as unknown as ModelRuntime;
}

type DraftSettings = Parameters<typeof predictDraftModel>[1];
type Level = NonNullable<ReturnType<DraftSettings["getDefaultThinkingLevel"]>>;

function fakeSettings(overrides: { model?: string; thinking?: Level; perModel?: Record<string, Level> }): DraftSettings {
	return {
		getDefaultProvider: () => (overrides.model ? STEP_PROVIDER_ID : undefined),
		getDefaultModel: () => overrides.model,
		getDefaultThinkingLevel: () => overrides.thinking,
		getAllModelThinkingLevels: () => overrides.perModel ?? {},
	};
}

const stepCatalog = [
	catalogModel("step-3.7-flash", true),
	catalogModel("step-router-v1", false),
	catalogModel(STEP_DEFAULT_MODEL, true),
];

test("a draft predicts the product default model, its effort and the full catalog", async () => {
	const draft = await predictDraftModel(fakeRuntime(stepCatalog), fakeSettings({}), {});
	assert.deepEqual(draft.model, { provider: STEP_PROVIDER_ID, id: STEP_DEFAULT_MODEL });
	assert.equal(draft.thinkingLevel, "medium");
	assert.ok(draft.availableThinkingLevels.includes("high"));
	assert.deepEqual(
		draft.models.map((model) => model.id),
		stepCatalog.map((model) => model.id),
	);
	assert.deepEqual(draft.models.find((model) => model.id === "step-router-v1")?.thinkingLevels, ["off"]);
	// The picker partitions by provider; each row carries the declared name.
	assert.equal(draft.models.every((model) => model.providerName === "StepFun"), true);
});

test("a draft follows the saved default model and its per-model effort", async () => {
	const settings = fakeSettings({ model: "step-3.7-flash", perModel: { "step/step-3.7-flash": "high" } });
	const draft = await predictDraftModel(fakeRuntime(stepCatalog), settings, {});
	assert.equal(draft.model?.id, "step-3.7-flash");
	assert.equal(draft.thinkingLevel, "high");
});

test("a draft without any model reports an empty panel", async () => {
	const draft = await predictDraftModel(fakeRuntime([]), fakeSettings({}), {});
	assert.equal(draft.model, undefined);
	assert.deepEqual(draft.models, []);
});
