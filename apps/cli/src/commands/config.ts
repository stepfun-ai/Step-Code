import type { Command, CommandContext, CommandResult } from "#commands/context";

/**
 * `config` command (resource toggles / scope switching).
 *
 * S3 skeleton: `step config` is still routed by the shell to pi's config command
 * (runStepConfigCommand / handleConfigCommand). The in-UI config selector
 * relocates in step 4; this descriptor reserves the shared slot.
 */
export const configCommand: Command = {
	name: "config",
	async run(_ctx: CommandContext): Promise<CommandResult> {
		return { status: "not-handled" };
	},
};
