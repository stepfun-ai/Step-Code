import type { ModelApiDialect } from "./types.ts";

/**
 * A read-only view keyed by dialect (`model.api`) — the S5 name for the
 * api-keyed adapter lookup that ALREADY drives dispatch (a Provider's `byApi`
 * map in models.ts, and compat.ts `getApiProvider(model.api)`).
 *
 * This registry does NOT replace or move that live lookup. It is a thin,
 * dependency-injected wrapper: callers pass whatever `api -> adapter` function
 * they already have, so new code and tests can speak the double-lookup
 * vocabulary (dialect via {@link DialectRegistry}, identity via
 * ProviderRegistry) without rewiring the working dispatch path. The adapter
 * type is a parameter (`TAdapter`) precisely so this introduces no new coupling
 * to the concrete stream implementation.
 */
export interface DialectRegistry<TAdapter> {
	/** The adapter for a dialect, or undefined if none is registered. */
	get(api: ModelApiDialect): TAdapter | undefined;
	has(api: ModelApiDialect): boolean;
	/** The dialects this registry can resolve (empty if the source is not enumerable). */
	dialects(): ModelApiDialect[];
}

export function createDialectRegistry<TAdapter>(
	lookup: (api: ModelApiDialect) => TAdapter | undefined,
	dialects: () => ModelApiDialect[] = () => [],
): DialectRegistry<TAdapter> {
	return {
		get: (api) => lookup(api),
		has: (api) => lookup(api) !== undefined,
		dialects,
	};
}
