import assert from "node:assert/strict";
import test from "node:test";
import {
	currentProviderGroup,
	groupModelsByProvider,
	isStepModel,
	pinFirst,
	providerSwitchTarget,
	readLastModelByProvider,
	readPinnedModels,
} from "../client/src/features/composer/models.ts";
import type { ModelInfo } from "../client/src/state/types.ts";

function model(provider: string, id: string, providerName?: string): ModelInfo {
	return { provider, id, name: id, api: "openai-completions", ...(providerName ? { providerName } : {}) } as ModelInfo;
}

/**
 * The reported case: a signed-in Step Plan account plus a custom gateway that
 * exposes hundreds of ids. The panel shows one provider at a time, so the
 * gateway can no longer bury the account's models — but the account's section
 * must still come first when no model is resolved yet.
 */
const ACCOUNT = ["step-5-preview", "step-3.7-flash", "step-router-v1"].map((id) => model("step", id));
const CUSTOM = Array.from({ length: 300 }, (_, index) => model("my-gateway", `custom-${index}`));
const MIXED = [...CUSTOM, ...ACCOUNT];

test("account models are recognised by their provider, custom models are not", () => {
	assert.equal(isStepModel(model("step", "step-5-preview")), true);
	assert.equal(isStepModel(model("my-gateway", "step-5-preview")), false);
});

test("every provider is its own section, the account's models first", () => {
	const groups = groupModelsByProvider(MIXED);
	assert.deepEqual(
		groups.map((group) => group.provider),
		["step", "my-gateway"],
	);
	assert.equal(groups[0].source, "account");
	assert.equal(groups[0].models.length, ACCOUNT.length);
	assert.equal(groups[1].source, "custom");
	assert.equal(groups[1].models.length, CUSTOM.length);
});

test("custom providers each get a section, in catalog order, named by declaration", () => {
	const models = [
		...CUSTOM.slice(0, 2),
		...ACCOUNT,
		model("deepseek", "deepseek-chat", "DeepSeek 开放平台"),
		model("my-gateway", "custom-late"),
	];
	const groups = groupModelsByProvider(models);
	assert.deepEqual(
		groups.map((group) => [group.provider, group.source, group.name]),
		[
			["step", "account", "step"],
			["my-gateway", "custom", "my-gateway"],
			["deepseek", "custom", "DeepSeek 开放平台"],
		],
	);
	// A provider's models stay together even when the flat list interleaves them.
	assert.deepEqual(
		groups[1].models.map((entry) => entry.id),
		["custom-0", "custom-1", "custom-late"],
	);
});

test("a single provider still yields one section; none yields none", () => {
	assert.deepEqual(
		groupModelsByProvider(CUSTOM).map((group) => group.provider),
		["my-gateway"],
	);
	assert.deepEqual(groupModelsByProvider([]), []);
});

test("the panel lists the current model's provider, the account's when nothing is chosen", () => {
	const onCustom = currentProviderGroup({ models: MIXED, model: { provider: "my-gateway", id: "custom-9" } });
	assert.equal(onCustom?.provider, "my-gateway");

	const undecided = currentProviderGroup({ models: MIXED });
	assert.equal(undecided?.provider, "step", "no model yet: the account's section is what opens first");

	assert.equal(currentProviderGroup({ models: [] }), undefined, "an empty catalog has no section to show");
});

test("switching providers lands on the remembered model, else the first listed one", () => {
	const group = groupModelsByProvider(MIXED).find((candidate) => candidate.provider === "my-gateway");
	assert.ok(group);
	assert.equal(providerSwitchTarget(group, `my-gateway\u0000custom-42`)?.id, "custom-42");
	// A remembered id the catalog no longer lists falls back to the first row.
	assert.equal(providerSwitchTarget(group, `my-gateway\u0000gone`)?.id, "custom-0");
	assert.equal(providerSwitchTarget(group, undefined)?.id, "custom-0");
});

test("a broken or missing model memory reads as empty instead of throwing", () => {
	// No localStorage in the test host (or a private window): never a crash.
	assert.deepEqual(readLastModelByProvider(), {});
});

test("favourited models pin to the top of their own provider's list, in favourite order", () => {
	const list = [model("my-gateway", "m0"), model("my-gateway", "m1"), model("my-gateway", "m2")];
	const key = (id: string) => `my-gateway\u0000${id}`;
	// Pinned first, favourites in the order they were added; the rest keep catalog order.
	assert.deepEqual(
		pinFirst(list, [key("m2"), key("m0")]).map((entry) => entry.id),
		["m2", "m0", "m1"],
	);
	// Keys pinned under other providers are ignored.
	assert.deepEqual(pinFirst(list, ["step\u0000step-5-preview"]).map((entry) => entry.id), ["m0", "m1", "m2"]);
	assert.deepEqual(pinFirst([], [key("m0")]), []);
	assert.deepEqual(readPinnedModels(), []);
});
