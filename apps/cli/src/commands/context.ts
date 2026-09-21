/**
 * Shared command contract.
 *
 * `commands/` is the neutral layer between the shell (main/args/bootstrap/modes)
 * and the interactive UI: the same command definition backs both a subcommand
 * (`step auth ...`) and an in-UI slash command. Commands never render — when an
 * argument is missing they return `{ status: "needs-input", needsInput }` and
 * let the caller decide whether to prompt (subcommand → error text; UI → open a
 * selector). Commands must not import the shell or any extension implementation;
 * capabilities (mic factory, provider registry, ...) are reached lazily through
 * `ctx.activate(key)` so a capability is only constructed when a command needs
 * it never constructs an unused capability at startup.
 */

/** Capabilities a command may lazily activate through the host. */
export type CapabilityKey = "auth" | "models" | "session" | "config";

/** Host surface handed to every command. */
export interface CommandContext {
	/** Raw arguments for the command (excluding the command name). */
	readonly args: readonly string[];
	/** Whether a UI is attached (drives whether needs-input can be prompted). */
	readonly hasUI: boolean;
	/**
	 * Lazily construct and return a capability. The registry only stores
	 * factories, so nothing heavy (microphone, network client) is created until a
	 * command actually asks for it.
	 */
	activate<T = unknown>(key: CapabilityKey): Promise<T>;
}

/** A command could not proceed because required input is missing. */
export interface NeedsInputIntent {
	/** Which command surface needs input. */
	readonly capability: CapabilityKey;
	/** Human-readable description of what is missing. */
	readonly prompt: string;
	/** Names of the missing arguments/fields. */
	readonly missing: readonly string[];
}

/** Outcome of running a command. */
export type CommandResult =
	| { status: "ok"; exitCode?: number }
	| { status: "needs-input"; needsInput: NeedsInputIntent }
	| { status: "not-handled" };

/** A command usable from both the subcommand surface and the UI slash surface. */
export interface Command {
	readonly name: CapabilityKey;
	run(ctx: CommandContext): Promise<CommandResult>;
}

/** Build a needs-input result without opening any selector. */
export function needsInput(intent: NeedsInputIntent): CommandResult {
	return { status: "needs-input", needsInput: intent };
}
