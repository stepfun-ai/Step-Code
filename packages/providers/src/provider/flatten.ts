import type { ModelApiDialect } from "../dialect/types.ts";
import type { MetadataLookup } from "../metadata/lookup.ts";
import type { ModelMetadata, ModelMetadataFields } from "../metadata/types.ts";
import type { Api, Model } from "../types.ts";
import type { ModelDeclaration, ProviderDeclaration } from "./declaration.ts";

// —— S5-4: the ONE piece of new mapping code ——
//
// `flattenProviders` turns declarative providers + pure metadata into the
// EXISTING `Model<Api>` shape (MAJ-9), so model switching / catalog / persistence
// / cost accounting see exactly what they see today. It is a pure function
// (unit-testable) and is intentionally ADDITIVE: it does NOT replace the live
// generated-catalog load path (models.generated.ts -> provider factories ->
// createModels). Wiring it into the live config load is deferred to avoid any
// regression to those downstream consumers; here it is proven to reproduce a
// real builtin `Model<Api>` byte-for-byte (see dialect-flatten.test.ts).

/** The `Model<Api>` fields that are required (must be present after merge). */
const REQUIRED_METADATA_FIELDS = ["name", "reasoning", "input", "cost", "contextWindow", "maxTokens"] as const;

/**
 * Resolve a model's metadata by overlaying a declaration's per-field overrides on
 * top of the metadata default (override wins per field; only DEFINED override
 * fields replace the default). Note: overrides are top-level per `Model` field —
 * a declaration replaces the whole `cost` object rather than a single rate
 * (the design's `Partial<Pricing>` sub-field merge is not reproduced in this
 * additive step; the metadata default carries the full cost). Throws when a
 * required field is supplied by neither side (mirrors provider-composer's
 * throw-on-missing rather than emitting a malformed model).
 */
export function mergeMetadata(base: ModelMetadata | undefined, declaration: ModelDeclaration): ModelMetadataFields {
	const { id: _id, api: _api, ...overrides } = declaration;
	const merged: Record<string, unknown> = {};
	if (base) {
		const { id: _baseId, ...baseFields } = base;
		Object.assign(merged, baseFields);
	}
	for (const [key, value] of Object.entries(overrides)) {
		if (value !== undefined) merged[key] = value;
	}
	for (const field of REQUIRED_METADATA_FIELDS) {
		if (merged[field] === undefined) {
			throw new Error(
				`flattenProviders: model "${declaration.id}" is missing required field "${field}" — no declaration override and no metadata default`,
			);
		}
	}
	return merged as unknown as ModelMetadataFields;
}

/**
 * Assemble one `Model<Api>` from identity (id + resolved api + provider profile +
 * baseUrl) and resolved metadata. `authRef` is profile-private and deliberately
 * never copied onto the model.
 */
export function toModel(
	id: string,
	api: ModelApiDialect,
	declaration: ProviderDeclaration,
	metadata: ModelMetadataFields,
): Model<Api> {
	return {
		...metadata,
		id,
		api,
		provider: declaration.id,
		baseUrl: declaration.baseUrl,
	} as Model<Api>;
}

/**
 * Flatten declarative providers into the existing `Model<Api>` list. Model-level
 * `api` overrides the provider default `dialect`. Output is ordinary
 * `Model<Api>` — no new type, no downstream change (§5.6.3).
 */
export function flattenProviders(declarations: ProviderDeclaration[], metadataDefaults: MetadataLookup): Model<Api>[] {
	const flat: Model<Api>[] = [];
	for (const declaration of declarations) {
		for (const model of declaration.models) {
			const api = model.api ?? declaration.dialect;
			const metadata = mergeMetadata(metadataDefaults.get(model.id), model);
			flat.push(toModel(model.id, api, declaration, metadata));
		}
	}
	return flat;
}
