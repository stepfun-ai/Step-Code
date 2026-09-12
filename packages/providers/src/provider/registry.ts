import type { ProviderProfile, ProviderProfileId } from "./types.ts";

/**
 * A read-only view keyed by profile id (identity) — the other half of the S5
 * double lookup: identity via {@link ProviderRegistry}, protocol via
 * DialectRegistry. It answers "which endpoint / auth / catalog / display name
 * does this profile have" and NEVER selects a protocol implementation.
 *
 * Like DialectRegistry this is a thin, dependency-injected wrapper over whatever
 * provider-identity source the caller already has (builtinProviders, or the
 * product-side provider-composer). It does not move or replace that source.
 */
export interface ProviderRegistry {
	/** The profile for an id, or undefined if unknown. */
	get(id: ProviderProfileId): ProviderProfile | undefined;
	has(id: ProviderProfileId): boolean;
	/** The profile ids this registry can resolve (empty if the source is not enumerable). */
	ids(): ProviderProfileId[];
}

export function createProviderRegistry(
	lookup: (id: ProviderProfileId) => ProviderProfile | undefined,
	ids: () => ProviderProfileId[] = () => [],
): ProviderRegistry {
	return {
		get: (id) => lookup(id),
		has: (id) => lookup(id) !== undefined,
		ids,
	};
}
