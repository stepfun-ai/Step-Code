/**
 * The `step config` subcommand table.
 *
 * Kept in its own module with no imports. `package-manager-cli.ts` renders the
 * `config --help` subcommand list from it, and that module is loaded by every
 * invocation, so a dependency here would be paid by every command. `cli/args.ts`
 * names the same subcommands in its inline help text.
 */

export interface StepConfigSubcommand {
	readonly name: string;
	readonly summary: string;
	/** Flags the subcommand accepts. Anything else is a user error. */
	readonly flags: readonly string[];
}

/** Every `step config` subcommand, in the order `--help` lists them. */
export const STEP_CONFIG_SUBCOMMANDS: readonly StepConfigSubcommand[] = [
	{
		name: "path",
		summary: "Print the resolved Step config file paths.",
		flags: ["--json"],
	},
	{
		name: "show",
		summary: "Print the stored config.toml and models.json documents (credentials redacted).",
		flags: ["--json"],
	},
	{
		name: "init",
		summary: "Write a Step config template (--scope, --path, --force).",
		flags: ["--scope", "--path", "--force"],
	},
	{
		name: "schema",
		summary: "Print the editor JSON Schema for config.toml or models.json (--out <file>).",
		flags: ["--out"],
	},
];

/** Whether `name` selects a subcommand, so a bare `step config` still opens the TUI. */
export function isStepConfigSubcommand(name: string | undefined): boolean {
	return STEP_CONFIG_SUBCOMMANDS.some((sub) => sub.name === name);
}

/** The `path|show|init|…` form used in usage text. */
export function stepConfigSubcommandNames(): string {
	return STEP_CONFIG_SUBCOMMANDS.map((sub) => sub.name).join("|");
}
