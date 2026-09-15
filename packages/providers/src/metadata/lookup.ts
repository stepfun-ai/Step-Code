import type { ModelMetadata } from "./types.ts";

/**
 * Look up pure {@link ModelMetadata} by model id. This is the `metadataDefaults`
 * source consumed by `flattenProviders` — it provides the cost / context /
 * thinking / compat defaults that a declaration may override per field. It has
 * NOTHING to do with dispatch (guarded by check-metadata-not-in-dispatch.mjs).
 */
export interface MetadataLookup {
	get(id: string): ModelMetadata | undefined;
	has(id: string): boolean;
	ids(): string[];
}

/** Build a {@link MetadataLookup} from a list of metadata entries (last write wins on id). */
export function createMetadataLookup(entries: Iterable<ModelMetadata>): MetadataLookup {
	const byId = new Map<string, ModelMetadata>();
	for (const entry of entries) byId.set(entry.id, entry);
	return {
		get: (id) => byId.get(id),
		has: (id) => byId.has(id),
		ids: () => [...byId.keys()],
	};
}
