/**
 * Action fusion: edit_file/write_file accept an optional `then_run` command
 * that runs after the mutation succeeds.  Gates (permissions, workflow ACL,
 * active tools, SDK acceptEdits) treat it as an embedded run_command call.
 */

export const THEN_RUN_TOOL_NAMES: ReadonlySet<string> = new Set(["edit_file", "write_file"]);

export function readThenRunCommand(input: unknown): string | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const value = (input as Record<string, unknown>).then_run;
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function getThenRunCommand(toolName: string, input: unknown): string | undefined {
	return THEN_RUN_TOOL_NAMES.has(toolName.trim().toLowerCase()) ? readThenRunCommand(input) : undefined;
}
