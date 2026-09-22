/**
 * Shared command layer (S3 first-party set: auth / models / session / config).
 *
 * Backs both subcommands and in-UI slash commands from one definition. The 30+
 * pure-UI slash commands (/compact, /thinking, /copy, /export, ...) are not
 * commands and do not belong here.
 */

export { authCommand } from "#commands/auth";
export { configCommand } from "#commands/config";
export {
	type CapabilityKey,
	type Command,
	type CommandContext,
	type CommandResult,
	type NeedsInputIntent,
	needsInput,
} from "#commands/context";
export { modelsCommand } from "#commands/models";
export { sessionCommand } from "#commands/session";
