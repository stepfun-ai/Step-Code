/**
 * Route syntax and catalog validation for naming a child agent's model.
 *
 * A call may name one route as `provider/modelId`, or as a bare model id that
 * resolves against the caller's own provider. One string expresses the whole
 * route — the same form `--model` accepts — so no second field is needed.
 *
 * There is no allowlist. The session's model catalog is the authority, and the
 * `models` tool is how a caller reads it. This module only adds the syntax, the
 * exact-match comparison, and the check against that catalog, so a route named
 * once resolves to the same thing everywhere.
 */

import type { Model } from "@step-harness/providers";

/** One exact provider/model pair. */
export interface SubagentModelRoute {
	readonly provider: string;
	readonly model: string;
}

/**
 * Stable identity for one route.
 *
 * Provider ids and model ids are matched case-insensitively by the CLI's
 * `--model` resolver, so identity is case-folded too: `Step/x` and `step/X` name
 * the same route.
 */
export function subagentRouteKey(route: SubagentModelRoute): string {
	return `${route.provider.toLowerCase()}\0${route.model.toLowerCase()}`;
}

/** Whether two routes name the same provider/model pair. */
export function sameSubagentRoute(left: SubagentModelRoute, right: SubagentModelRoute): boolean {
	return subagentRouteKey(left) === subagentRouteKey(right);
}

/**
 * Read one route out of a `model` value.
 *
 * A bare id resolves against the parent's provider, because that is the only
 * provider a bare id can mean in a session whose parent runs elsewhere. Returns
 * undefined for a value that names no usable route.
 */
export function parseSubagentModelRoute(value: string, parent?: SubagentModelRoute): SubagentModelRoute | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash === -1) {
		if (!parent) return undefined;
		return { provider: parent.provider, model: trimmed };
	}
	const provider = trimmed.slice(0, slash).trim();
	const model = trimmed.slice(slash + 1).trim();
	if (!provider || !model) return undefined;
	return { provider, model };
}

export type CatalogMatch =
	| { readonly ok: true; readonly route: SubagentModelRoute }
	| { readonly ok: false; readonly reason: string };

/**
 * Resolve `route` against the models this session can actually run.
 *
 * The catalog's own spelling is returned, so a case-insensitive match still
 * yields the exact `provider/id` the child must be started with. A miss is
 * explained in terms the caller can act on: the nearest candidates on the same
 * provider, because the common mistake is a stale or mistyped id, not a wrong
 * provider.
 *
 * `models` empty means this host has no catalog to consult (an embedded host, or
 * a session with no credentials yet). Validation is skipped rather than failing
 * every call: the CLI remains the authority in that case, exactly as before.
 */
export function matchCatalogRoute(route: SubagentModelRoute, models: readonly Model<any>[]): CatalogMatch | undefined {
	if (models.length === 0) return undefined;
	const wanted = route.model.toLowerCase();
	const sameProvider = models.filter((model) => model.provider.toLowerCase() === route.provider.toLowerCase());
	const exact = sameProvider.find((model) => model.id.toLowerCase() === wanted);
	if (exact !== undefined) return { ok: true, route: { provider: exact.provider, model: exact.id } };

	const providers = [...new Set(models.map((model) => model.provider))].sort();
	if (sameProvider.length === 0) {
		return {
			ok: false,
			reason: `provider "${route.provider}" has no available model; providers in this session: ${providers.join(", ")}`,
		};
	}
	const candidates = sameProvider
		.map((model) => `${model.provider}/${model.id}`)
		.slice(0, 10)
		.join(", ");
	const more = sameProvider.length > 10 ? `, and ${sameProvider.length - 10} more` : "";
	return {
		ok: false,
		reason: `no model "${route.model}" on provider "${route.provider}"; available there: ${candidates}${more}`,
	};
}
