import type { ModelInfo, ModelRef } from "../../state/types";

/** A configured catalogue is not enough if the current selection still points at a removed model. */
export function modelConfigurationRequired(input: {
	readonly model?: ModelRef;
	readonly models?: readonly ModelInfo[];
}): boolean {
	if (!input.model) return true;
	return !(input.models ?? []).some(
		(model) => model.provider === input.model?.provider && model.id === input.model?.id,
	);
}
