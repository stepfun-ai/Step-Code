import type { ToolDefinition } from "./extensions/types.ts";

const coreToolDefinitions = new WeakSet<object>();

/** Mark a freshly created first-party profile definition without making provenance cloneable. */
export function markCoreToolDefinition<T extends ToolDefinition>(tool: T): T {
	tool.origin = "core";
	coreToolDefinitions.add(tool);
	return tool;
}

/** Object identity prevents arbitrary SDK definitions from opting into the core tier. */
export function isMarkedCoreToolDefinition(tool: ToolDefinition): boolean {
	return coreToolDefinitions.has(tool);
}
