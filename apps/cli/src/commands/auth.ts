import type { Command, CommandContext, CommandResult } from "#commands/context";

/**
 * `auth` command (login / logout / check / print-*).
 *
 * S3 skeleton: the auth surface is still executed by pi's runAuthCommand (inside
 * main()) and the Step top-level login/logout routing in the shell. This
 * descriptor reserves the shared slot; wiring the execution here follows once
 * the interactive login dialog relocates in step 4.
 */
export const authCommand: Command = {
	name: "auth",
	async run(_ctx: CommandContext): Promise<CommandResult> {
		return { status: "not-handled" };
	},
};
