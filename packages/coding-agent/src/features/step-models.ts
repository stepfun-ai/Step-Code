/**
 * The `models` tool: the model-facing way to read this session's model catalog.
 *
 * Split from `step-models-catalog.ts` so the formatting and filtering stay
 * testable without mounting an extension, and kept separate from the subagent
 * feature because naming a model is not a subagent-specific need.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { availableModels, listModelsText } from "./step-models-catalog.ts";

const MODELS_PARAMS = Type.Object(
	{
		provider: Type.Optional(
			Type.String({
				description:
					"Provider id or name to filter by. Try your own provider first: another model on the same provider keeps the current credentials and routing.",
			}),
		),
		query: Type.Optional(Type.String({ description: "Text to search for in model ids and display names." })),
		limit: Type.Optional(
			Type.Number({
				description: "Maximum number of models to return. Default: 20.",
				minimum: 1,
				maximum: 200,
			}),
		),
	},
	{ additionalProperties: false },
);

function result(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
	return { content: [{ type: "text", text }], details: {} };
}

/** Register the catalog tool. Safe on every host: it only reads the registry. */
export function createStepModelsExtension(): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI): void => {
		pi.registerTool<typeof MODELS_PARAMS>({
			name: "models",
			label: "Models",
			description: [
				"List the models this session can run, as exact `provider/modelId` references.",
				"Use this to turn a model the user names — or a model you intend to pass to `subagent` or a workflow agent — into the exact id before using it.",
				"The session's own provider comes first.",
				"No arguments lists every available model; `provider` narrows to one; `query` matches ids and names.",
			].join(" "),
			parameters: MODELS_PARAMS,
			executionMode: "sequential",
			execute: async (_id, params, _signal, _onUpdate, ctx: ExtensionContext) => {
				// Available, not merely configured: a model without credentials would fail
				// at the first request, so offering it would be a trap.
				return result(listModelsText(availableModels(ctx), params, ctx.model?.provider, params.limit));
			},
		});
	};
}
