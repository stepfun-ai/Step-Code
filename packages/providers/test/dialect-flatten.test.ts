import { describe, expect, it } from "vitest";
import type { ModelApiDialect } from "../src/dialect/types.ts";
import { createMetadataLookup } from "../src/metadata/lookup.ts";
import type { ModelMetadata } from "../src/metadata/types.ts";
import { MODELS } from "../src/models.generated.ts";
import type { ProviderDeclaration } from "../src/provider/declaration.ts";
import { flattenProviders, mergeMetadata } from "../src/provider/flatten.ts";
import type { Api, Model } from "../src/types.ts";

// Every builtin model in the generated catalog (the shape flattenProviders must
// reproduce byte-for-byte).
const ALL_BUILTINS: Model<Api>[] = Object.values(MODELS).flatMap((group) => Object.values(group) as Model<Api>[]);

/** Split a real `Model<Api>` into its identity axis and its pure metadata. */
function split(model: Model<Api>): {
	api: ModelApiDialect;
	provider: string;
	baseUrl: string;
	metadata: ModelMetadata;
} {
	const { api, provider, baseUrl, ...metadata } = model;
	return { api: api as ModelApiDialect, provider, baseUrl, metadata: metadata as ModelMetadata };
}

/** Express a builtin as a single-model declaration (no overrides) + its metadata. */
function roundTrip(model: Model<Api>): Model<Api> {
	const { api, provider, baseUrl, metadata } = split(model);
	const lookup = createMetadataLookup([metadata]);
	const declaration: ProviderDeclaration = {
		id: provider,
		label: `${provider} profile`,
		dialect: api,
		baseUrl,
		authRef: "TEST_API_KEY",
		models: [{ id: metadata.id }],
	};
	const flat = flattenProviders([declaration], lookup);
	expect(flat).toHaveLength(1);
	return flat[0];
}

describe("flattenProviders reproduces the existing Model<Api> shape (MAJ-9)", () => {
	it("round-trips a representative builtin model byte-for-byte", () => {
		const builtin = ALL_BUILTINS[0];
		expect(builtin, "generated catalog should contain at least one model").toBeDefined();
		expect(roundTrip(builtin)).toEqual(builtin);
	});

	it("round-trips a broad sample of builtins across dialects", () => {
		// Sample every ~11th model so the test stays fast but crosses many providers/dialects.
		const sample = ALL_BUILTINS.filter((_, index) => index % 11 === 0);
		expect(sample.length).toBeGreaterThan(3);
		for (const builtin of sample) {
			expect(roundTrip(builtin), `round-trip mismatch for ${builtin.provider}/${builtin.id}`).toEqual(builtin);
		}
	});

	it("preserves tiered pricing (ModelCost.tiers) — cost regression guard for condition 10", () => {
		const tiered = ALL_BUILTINS.find((model) => (model.cost.tiers?.length ?? 0) > 0);
		expect(tiered, "expected at least one builtin with tiered pricing (openai / openai-codex / …)").toBeDefined();
		const flattened = roundTrip(tiered as Model<Api>);
		expect(flattened.cost.tiers).toEqual((tiered as Model<Api>).cost.tiers);
	});
});

describe("flattenProviders mapping rules", () => {
	const baseMeta: ModelMetadata = {
		id: "m1",
		name: "Model One",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
	const lookup = createMetadataLookup([baseMeta]);

	it("model-level api overrides the provider default dialect", () => {
		const declaration: ProviderDeclaration = {
			id: "acme",
			label: "Acme",
			dialect: "openai-completions",
			baseUrl: "https://acme.test/v1",
			authRef: "ACME_KEY",
			models: [{ id: "m1" }, { id: "m1", api: "anthropic-messages" }],
		};
		const flat = flattenProviders([declaration], lookup);
		expect(flat[0].api).toBe("openai-completions"); // inherits provider dialect
		expect(flat[1].api).toBe("anthropic-messages"); // model override wins
	});

	it("fills provider identity/baseUrl and never leaks authRef onto the model", () => {
		const declaration: ProviderDeclaration = {
			id: "acme",
			label: "Acme",
			dialect: "openai-completions",
			baseUrl: "https://acme.test/v1",
			authRef: "ACME_SECRET",
			models: [{ id: "m1" }],
		};
		const [model] = flattenProviders([declaration], lookup);
		expect(model.provider).toBe("acme");
		expect(model.baseUrl).toBe("https://acme.test/v1");
		expect(JSON.stringify(model)).not.toContain("ACME_SECRET");
		expect("authRef" in model).toBe(false);
	});

	it("applies declaration per-field overrides over the metadata default", () => {
		const declaration: ProviderDeclaration = {
			id: "acme",
			label: "Acme",
			dialect: "openai-completions",
			baseUrl: "https://acme.test/v1",
			authRef: "ACME_KEY",
			models: [{ id: "m1", name: "Overridden", maxTokens: 512 }],
		};
		const [model] = flattenProviders([declaration], lookup);
		expect(model.name).toBe("Overridden");
		expect(model.maxTokens).toBe(512);
		expect(model.contextWindow).toBe(1000); // untouched default
	});

	it("throws when a required field is supplied by neither metadata nor declaration", () => {
		const emptyLookup = createMetadataLookup([]);
		const declaration: ProviderDeclaration = {
			id: "acme",
			label: "Acme",
			dialect: "openai-completions",
			baseUrl: "https://acme.test/v1",
			authRef: "ACME_KEY",
			models: [{ id: "unknown" }],
		};
		expect(() => flattenProviders([declaration], emptyLookup)).toThrow(/missing required field/);
	});

	it("mergeMetadata leaves the metadata default intact when there are no overrides", () => {
		const merged = mergeMetadata(baseMeta, { id: "m1" });
		expect(merged.name).toBe("Model One");
		expect(merged.cost).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
	});
});
