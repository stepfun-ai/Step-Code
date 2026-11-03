import type { ExtensionAPI, ExtensionFactory } from "../core/extensions/types.ts";
import { createToolSearchToolDefinition } from "../core/tools/tool-search.ts";

/**
 * Mount `tool_search`: it is registered inactive and finds the tools that are registered but not
 * declared to the model, so a session can keep a large tool catalogue out of the prompt.
 *
 * Enable it per session with `defaultTools`, `--tools`, or the tool settings.
 */
export function createStepToolSearchExtension(): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		pi.registerTool(createToolSearchToolDefinition(pi));
	};
}
