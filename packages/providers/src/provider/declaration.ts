import type { ModelApiDialect } from "../dialect/types.ts";
import type { ModelMetadataFields } from "../metadata/types.ts";
import type { ProviderProfileId } from "./types.ts";

// —— S5-4: declarative providers ——
//
// A `ProviderDeclaration` is what a user writes in config to add a provider —
// which protocol (dialect), where (baseUrl), which credential (authRef), and a
// set of models — WITHOUT touching code (acceptance condition 3). Per-model
// fields override the metadata defaults. `flattenProviders` (./flatten.ts) turns
// declarations + a MetadataLookup into the existing `Model<Api>[]` shape.

/**
 * One model under a provider declaration. `api` may override the provider's
 * default `dialect`. Every other field is an OPTIONAL per-field override of the
 * metadata default (see MetadataLookup) — same field types as `Model` so the
 * override is byte-compatible.
 */
export interface ModelDeclaration extends Partial<ModelMetadataFields> {
	id: string;
	/** Overrides the provider's default `dialect` for this model. */
	api?: ModelApiDialect;
}

/**
 * A provider's declarative form. `dialect` is the default protocol for its
 * models (each may override via `ModelDeclaration.api`); `authRef` is the
 * profile-private credential reference and is the one field that never reaches
 * `Model` (it flows into the adapter context instead).
 */
export interface ProviderDeclaration {
	id: ProviderProfileId;
	label: string;
	dialect: ModelApiDialect;
	baseUrl: string;
	authRef: string;
	models: ModelDeclaration[];
}
