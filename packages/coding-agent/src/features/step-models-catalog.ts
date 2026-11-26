/**
 * Model discovery for the model itself.
 *
 * A caller that wants to name a model somewhere — the `subagent` call's `model`
 * parameter, a workflow agent node — needs the exact `provider/modelId` string.
 * Guessing produces a fuzzy CLI match or a failed turn, so the catalog is
 * answerable through a tool instead of being pasted into every tool description.
 *
 * This is deliberately a general capability, not a subagent detail: it describes
 * the models this session can run at all, and any feature that accepts a model
 * reference points here. Keeping it general is also what makes the answer cheap
 * — the catalog is large and changes with credentials, so it must be read at
 * call time (a tool result) rather than baked into a cached tool definition.
 */

import type { Model } from "@step-harness/providers";

/**
 * The catalog a context can offer, or an empty list when it cannot answer.
 *
 * A host that cannot produce one is not an error: embedded hosts and test
 * doubles may omit the registry, and in that case there is nothing to validate
 * against, so the CLI stays the authority exactly as it did before this
 * parameter existed. Rejecting every call for lack of a catalog would be worse
 * than the failure this check exists to prevent.
 */
export function availableModels(ctx: { readonly modelRegistry?: unknown }): readonly Model<any>[] {
	const registry = ctx.modelRegistry as { getAvailable?: () => Model<any>[] } | undefined;
	if (typeof registry?.getAvailable !== "function") return [];
	try {
		return registry.getAvailable();
	} catch {
		// A registry that throws while enumerating is a host fault; the delegation
		// still has a valid route to forward, so validation degrades to none rather
		// than failing the call.
		return [];
	}
}

export interface ModelsCatalogEntry {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
}

export interface ListModelsRequest {
	/** Provider id or display name, matched case-insensitively. */
	readonly provider?: string;
	/** Free text matched against `provider/id` and the display name. */
	readonly query?: string;
	readonly all?: boolean;
}

const DEFAULT_LIMIT = 20;

/**
 * Render the models a session can run, most relevant first.
 *
 * Ordering puts the caller's own provider first so the common case — naming
 * another model on the provider already in use, which keeps credentials and
 * routing unchanged — is the first thing read. Within a provider, newest
 * releases come first; `released` is absent on hand-written entries, which sort
 * last rather than crashing.
 */
export function listModelsText(
	models: readonly Model<any>[],
	request: ListModelsRequest,
	ownProvider: string | undefined,
	limit = DEFAULT_LIMIT,
): string {
	if (models.length === 0) {
		return "(no models are available in this session; check the provider configuration)";
	}

	const provider = request.provider?.trim().toLowerCase();
	const terms = (request.query ?? "")
		.toLowerCase()
		.split(/\s+/)
		.filter((term) => term.length > 0);

	const matching = models
		.filter(
			(model) =>
				provider === undefined ||
				model.provider.toLowerCase() === provider ||
				model.name.toLowerCase() === provider,
		)
		.filter((model) => {
			const text = `${model.provider}/${model.id} ${model.name}`.toLowerCase();
			return terms.every((term) => text.includes(term));
		})
		.sort(
			(left, right) =>
				Number(right.provider === ownProvider) - Number(left.provider === ownProvider) ||
				left.provider.localeCompare(right.provider) ||
				left.id.localeCompare(right.id),
		);

	if (matching.length === 0) {
		const providers = [...new Set(models.map((model) => model.provider))].sort();
		const filter = [
			provider ? `provider "${request.provider?.trim()}"` : "",
			terms.length > 0 ? `query "${request.query}"` : "",
		]
			.filter(Boolean)
			.join(" and ");
		return `No model matches ${filter || "that request"}. Providers in this session: ${providers.join(", ")}.`;
	}

	const shown = matching.slice(0, limit);
	const byProvider = new Map<string, Model<any>[]>();
	for (const model of shown) {
		const entries = byProvider.get(model.provider);
		if (entries === undefined) byProvider.set(model.provider, [model]);
		else entries.push(model);
	}

	const lines = [
		`${matching.length} model${matching.length === 1 ? "" : "s"} available` +
			(ownProvider ? ` (this session runs ${ownProvider}; its models are listed first)` : "") +
			":",
	];
	for (const [providerId, entries] of byProvider) {
		for (const model of entries) {
			const facts = [model.reasoning ? "reasoning" : "", model.input.includes("image") ? "image input" : ""].filter(
				Boolean,
			);
			lines.push(
				`- ${providerId}/${model.id}${model.name === model.id ? "" : ` (${model.name})`}${facts.length > 0 ? ` [${facts.join(", ")}]` : ""}`,
			);
		}
	}
	if (matching.length > shown.length) {
		lines.push(
			`… ${matching.length - shown.length} more; narrow the search with \`query\` or \`provider\`, or raise \`limit\`.`,
		);
	}
	if (provider === undefined && terms.length === 0 && ownProvider !== undefined) {
		lines.push("Pass the `provider/modelId` exactly as shown; do not guess it.");
	}
	return lines.join("\n");
}

/** The entry for one exact route, or undefined when the session cannot run it. */
export function findModel(models: readonly Model<any>[], provider: string, id: string): ModelsCatalogEntry | undefined {
	const lowered = provider.toLowerCase();
	const model = models.find((candidate) => candidate.provider.toLowerCase() === lowered && candidate.id === id);
	return model === undefined ? undefined : { provider: model.provider, id: model.id, name: model.name };
}
