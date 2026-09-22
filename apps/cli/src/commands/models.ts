import type { Command, CommandContext, CommandResult } from "#commands/context";

/**
 * `models` command (list / select model).
 *
 * S3 skeleton and target home for pi's cli/list-models (MAJ-5: L34
 * list-models → commands/models). The listing is still invoked by pi's main()
 * for `--list-models`; this descriptor reserves the shared slot. When a model
 * pattern is required but absent, the eventual implementation returns
 * needsInput({ capability: "models", ... }) instead of opening a selector.
 */
export const modelsCommand: Command = {
	name: "models",
	async run(_ctx: CommandContext): Promise<CommandResult> {
		return { status: "not-handled" };
	},
};
