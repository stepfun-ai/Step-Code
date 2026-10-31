import type { AgentToolResult } from "./types.ts";

/** An execution failure whose diagnostic message precedes retained output and recovery metadata. */
export class ToolExecutionError<T = unknown> extends Error {
	readonly result: AgentToolResult<T>;

	constructor(message: string, result: AgentToolResult<T>, options?: ErrorOptions) {
		super(message, options);
		this.name = "ToolExecutionError";
		this.result = { ...result, content: [{ type: "text", text: message }, ...result.content], isError: true };
	}
}
