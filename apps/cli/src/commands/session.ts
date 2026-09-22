import type { Command, CommandContext, CommandResult } from "#commands/context";

/**
 * `session` command (resume / continue / fork selection).
 *
 * S3 skeleton: session selection is still driven by pi's main() and the Step
 * session facade. The interactive session picker relocates in step 4, at which
 * point this descriptor gains the needs-input path (missing session id → prompt
 * decided by the caller, no selector opened here).
 */
export const sessionCommand: Command = {
	name: "session",
	async run(_ctx: CommandContext): Promise<CommandResult> {
		return { status: "not-handled" };
	},
};
