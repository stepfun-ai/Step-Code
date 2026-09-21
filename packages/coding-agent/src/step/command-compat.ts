/**
 * Step's small top-level command compatibility layer.
 *
 * Pi owns the actual runtime and command implementations.  This module only
 * translates the legacy Step command spelling to Pi's public CLI flags, and
 * handles the few configuration inspection operations that pi's package
 * manager does not provide.  Keeping this boundary separate makes upgrades to
 * Pi's parser/local runtime low-risk.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { readStepConfig, resolveStepConfigPath, STEP_CONFIG_FILE_NAME } from "./config-toml.ts";
import { resolveStepAgentDir, resolveStepConfigDir, resolveStepConfigRoot } from "./environment.ts";
import { normalizeStepStableVersion } from "./local-update.ts";

export type StepTopLevelCommand = "config" | "exec" | "models" | "resume";

export interface StepUpdateCommand {
	readonly command: "update" | "upgrade";
	readonly version?: string;
}

export interface StepCommandCompatibilityResult {
	/** The rewritten argv for Pi's existing `main()` entry. */
	readonly args?: string[];
	/** Whether the caller should skip Pi's normal `main()` invocation. */
	readonly handled: boolean;
}

const STEP_DEFAULT_SESSION_FILE = "session";

/**
 * Normalize the session selector emitted by older StepCode launchers.
 *
 * StepCode passes a local session selector as `--session-file`, while Pi's
 * runtime accepts a project session id via `--session-id`. The StepCode uses
 * the basename (without its extension) as that id; its default `session`
 * selector deliberately means "create a fresh session".
 */
export function normalizeStepSessionSelectorArgs(argv: readonly string[]): string[] {
	const separatorIndex = argv.indexOf("--");
	const optionArgs = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
	const trailingArgs = separatorIndex === -1 ? [] : argv.slice(separatorIndex);
	const hasExplicitSessionId = optionArgs.some((arg) => arg === "--session-id" || arg.startsWith("--session-id="));
	const hasResume = optionArgs.includes("--resume") || optionArgs.includes("-r");
	let sessionId: string | undefined;
	const result: string[] = [];

	for (let index = 0; index < optionArgs.length; index++) {
		const arg = optionArgs[index];
		let sessionFile: string | undefined;
		if (arg === "--session-file") {
			const value = optionArgs[index + 1];
			// Only a non-option token can be the value. Testing for a single "-" (not
			// "--") keeps short flags such as `-p` in place for parseArgs: consuming
			// one silently dropped it and changed the run's mode. A flag-like token is
			// left where it is, so a genuinely bogus one surfaces as a parse error
			// rather than disappearing.
			if (value !== undefined && !value.startsWith("-")) {
				sessionFile = value;
				index++;
			}
		} else if (arg.startsWith("--session-file=")) {
			sessionFile = arg.slice("--session-file=".length);
		} else {
			result.push(arg);
			continue;
		}

		if (!sessionId && !hasExplicitSessionId && !hasResume && sessionFile) {
			const trimmed = sessionFile.trim();
			if (trimmed !== STEP_DEFAULT_SESSION_FILE) {
				const derived = basename(trimmed, extname(trimmed));
				if (isValidPiSessionId(derived)) sessionId = derived;
			}
		}
	}

	if (sessionId) result.push("--session-id", sessionId);
	return [...result, ...trailingArgs];
}

function isValidPiSessionId(value: string): boolean {
	return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);
}

/**
 * Translate a legacy Step subcommand to Pi's native root flags.
 *
 * `undefined` means this is an ordinary root invocation.  A result with
 * `handled:false` is intentionally returned for translated commands so the
 * caller can pass `args` to `main()` without another command parser.
 */
export function translateStepCommandArgs(argv: readonly string[]): StepCommandCompatibilityResult | undefined {
	const [command, ...rest] = argv;
	if (!command) return undefined;

	switch (command) {
		case "exec":
			return { handled: false, args: translateExecArgs(rest) };
		case "resume":
			return { handled: false, args: translateResumeArgs(rest) };
		case "models":
			return { handled: false, args: translateModelsArgs(rest) };
		default:
			return undefined;
	}
}

/** Parse the intentionally small Step self-update surface. */
export function parseStepUpdateCommand(argv: readonly string[]): StepUpdateCommand | { error: string } | undefined {
	const command = argv[0];
	if (command !== "update" && command !== "upgrade") return undefined;
	const rest = argv.slice(1);
	if (rest.length === 0) return { command };
	if (rest.length > 1) return { error: `Usage: step ${command} [version]` };
	const value = rest[0];
	if (value.startsWith("-")) return { error: `Usage: step ${command} [version]` };
	const version = normalizeStepStableVersion(value);
	if (!version) return { error: `Invalid Step release version "${value}". Expected MAJOR.MINOR.PATCH.` };
	return { command, version };
}

/** Return whether argv selects a Step config inspection command. */
export function isStepConfigCommand(argv: readonly string[]): boolean {
	return argv[0] === "config" && ["path", "show", "init"].includes(argv[1] ?? "");
}

export interface StepConfigCommandIo {
	stdout?: Pick<NodeJS.WriteStream, "write">;
	cwd?: string;
	homeEnv?: Record<string, string | undefined>;
}

/**
 * Run the Step-owned config inspection commands.
 *
 * Settings live in `config.toml`; `models.json` and `auth.json` stay JSON but
 * hold model definitions and credentials rather than settings. Everything sits
 * below `.stepcode`; secrets are never printed.
 */
export async function runStepConfigCommand(argv: readonly string[], io: StepConfigCommandIo = {}): Promise<void> {
	const stdout = io.stdout ?? process.stdout;
	const cwd = resolve(io.cwd ?? process.cwd());
	const env = io.homeEnv ?? process.env;
	const agentDir = resolveStepAgentDir(env);
	const configRoot = resolveStepConfigRoot(env);
	const configDirName = resolveStepConfigDir(env);
	const projectDir = join(cwd, configDirName);
	const paths = {
		agentDir,
		globalSettings: resolveStepConfigPath(env),
		globalModels: join(configRoot, "models.json"),
		globalAuth: join(configRoot, "auth.json"),
		projectDir,
		projectSettings: join(projectDir, STEP_CONFIG_FILE_NAME),
	};

	const subcommand = argv[1];

	// `--help` and unknown-flag handling must run before any subcommand acts:
	// `init` writes a file, so without this an invocation like
	// `step config init --help` — or a mistyped flag — silently writes the
	// template instead of printing help or reporting the bad option.
	const knownFlags = STEP_CONFIG_SUBCOMMAND_FLAGS[subcommand ?? ""];
	if (knownFlags) {
		const flagArgs = argv.slice(2);
		if (flagArgs.includes("--help") || flagArgs.includes("-h")) {
			stdout.write(`${stepConfigUsage(subcommand)}\n`);
			return;
		}
		const unknownFlag = flagArgs.find(
			(arg) => arg.startsWith("-") && arg !== "--" && !knownFlags.includes(arg.split("=")[0]),
		);
		if (unknownFlag) {
			throw new Error(
				`Unknown option "${unknownFlag}" for step config ${subcommand}. Run "step config ${subcommand} --help".`,
			);
		}
	}

	if (subcommand === "path") {
		const json = argv.includes("--json");
		const payload = {
			globalAgentDir: paths.agentDir,
			globalSettingsPath: paths.globalSettings,
			globalModelsPath: paths.globalModels,
			globalAuthPath: paths.globalAuth,
			workspaceConfigDir: paths.projectDir,
			workspaceSettingsPath: paths.projectSettings,
			existingPaths: Object.values(paths).filter((value) => existsSync(value)),
		};
		if (json) {
			stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		} else {
			stdout.write(
				`${[
					`global: ${paths.agentDir}`,
					`global settings: ${paths.globalSettings}`,
					`global models: ${paths.globalModels}`,
					`global auth: ${paths.globalAuth}`,
					`workspace: ${paths.projectDir}`,
					`workspace settings: ${paths.projectSettings}`,
					`existing: ${payload.existingPaths.length > 0 ? payload.existingPaths.join(", ") : "(none)"}`,
				].join("\n")}\n`,
			);
		}
		return;
	}

	if (subcommand === "init") {
		const scope = readOption(argv, "--scope") ?? "user";
		if (scope !== "user" && scope !== "workspace") {
			throw new Error(`Invalid config scope "${scope}". Use user or workspace.`);
		}
		const explicitPath = readOption(argv, "--path");
		const target = resolve(explicitPath ?? (scope === "workspace" ? paths.projectSettings : paths.globalSettings));
		const force = argv.includes("--force");
		if (existsSync(target) && !force) {
			throw new Error(`Config file already exists: ${target} (pass --force to overwrite)`);
		}
		await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
		const template = [
			"# StepCode configuration",
			'defaultProvider = "step"',
			'defaultModel = "step-5-preview"',
			"",
		].join("\n");
		await writeFile(target, template, { encoding: "utf8", mode: 0o600 });
		stdout.write(`Wrote Step config template: ${target}\n`);
		return;
	}

	if (subcommand === "show") {
		const json = argv.includes("--json");
		const readJson = async (path: string): Promise<unknown> => {
			try {
				return JSON.parse(await readFile(path, "utf8")) as unknown;
			} catch {
				return undefined;
			}
		};
		// Settings are TOML; a missing or malformed file reads as absent here
		// because `show` is a diagnostic, not a validator.
		const readToml = (path: string): unknown => {
			try {
				return readStepConfig(path);
			} catch {
				return undefined;
			}
		};
		const payload = {
			paths,
			globalSettings: readToml(paths.globalSettings),
			globalModels: await readJson(paths.globalModels),
			workspaceSettings: readToml(paths.projectSettings),
			// Auth presence is useful for diagnostics; credential material is not.
			auth: { configured: existsSync(paths.globalAuth), path: paths.globalAuth },
		};
		if (json) {
			stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		} else {
			stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
		}
		return;
	}

	throw new Error(`Usage: step config ${"path|show|init"}`);
}

function translateExecArgs(args: readonly string[]): string[] {
	const result: string[] = ["--print"];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--output-format" || arg.startsWith("--output-format=")) {
			const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index];
			if (value === "json") result.push("--mode", "json");
			else if (value === "text" || value === undefined) {
				// Pi's default print mode is text.
			} else {
				// Keep unsupported formats visible to Pi's normal diagnostics rather
				// than silently dropping a requested stream protocol.
				result.push("--output-format", value);
			}
			continue;
		}
		if (arg === "--json") {
			result.push("--mode", "json");
			continue;
		}
		result.push(arg);
	}
	return result;
}

/**
 * `step resume` has two shapes and they map to different pi flags.
 *
 * Without an id it opens the interactive picker, which is `--resume`. With an
 * id it must open that specific session, and pi rejects `--session-id`
 * alongside `--resume` (see validateSessionIdFlags in main.ts), so the pair
 * would fail before reaching the session layer. `--session <path|id>` is the
 * selector that resolves an existing session and reports a missing one.
 *
 * Only the first argument can be the id. Scanning for any non-flag token would
 * pick up a flag's value instead, so `step resume --model step-3` would resume
 * a session named `step-3` rather than opening the picker.
 */
function translateResumeArgs(args: readonly string[]): string[] {
	const sessionId = args[0];
	if (sessionId === undefined || sessionId.startsWith("-")) return ["--resume", ...args];
	return ["--session", sessionId, ...args.slice(1)];
}

function translateModelsArgs(args: readonly string[]): string[] {
	const subcommand = args[0];
	if (subcommand === "check") {
		// Pi has no probe command. Preserve an explicit, actionable failure rather
		// than treating `check` as a model search string.
		return ["--list-models", "--step-models-check-unsupported", ...args.slice(1)];
	}
	if (subcommand === "list" || subcommand === undefined) {
		return ["--list-models", ...args.slice(subcommand ? 1 : 0)];
	}
	return ["--list-models", ...args];
}

function readOption(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	if (index >= 0) {
		// Reject a missing, empty or flag-like value rather than consuming the next
		// option: `config init --path --force` must report the missing --path value
		// instead of writing a file literally named "--force", and `--path ""`
		// must not resolve to the cwd and fail later with a raw EISDIR.
		const value = argv[index + 1];
		if (value === undefined || value === "" || value.startsWith("-")) {
			throw new Error(`Option "${name}" requires a value.`);
		}
		return value;
	}
	const prefix = `${name}=`;
	const inline = argv.find((arg) => arg.startsWith(prefix));
	if (inline === undefined) return undefined;
	const value = inline.slice(prefix.length);
	if (value === "") {
		throw new Error(`Option "${name}" requires a value.`);
	}
	return value;
}

/** Flags each `step config` subcommand accepts. Anything else is a user error. */
const STEP_CONFIG_SUBCOMMAND_FLAGS: Record<string, readonly string[]> = {
	path: ["--json"],
	show: ["--json"],
	init: ["--scope", "--path", "--force"],
};

/** `step config` subcommands with one-line summaries, surfaced by `config --help`. */
export const STEP_CONFIG_SUBCOMMANDS: readonly { readonly name: string; readonly summary: string }[] = [
	{ name: "path", summary: "Print the resolved Step config file paths." },
	{ name: "show", summary: "Print the effective Step config (credentials omitted)." },
	{ name: "init", summary: "Write a Step config template (--scope, --path, --force)." },
];

function stepConfigUsage(subcommand: string): string {
	switch (subcommand) {
		case "path":
			return "Usage: step config path [--json]\n  Print the resolved Step config file paths.";
		case "show":
			return "Usage: step config show [--json]\n  Print the effective Step config (credentials omitted).";
		case "init":
			return [
				"Usage: step config init [--scope user|workspace] [--path <file>] [--force]",
				"  Write a Step config template. Defaults to the user scope; --force overwrites an existing file.",
			].join("\n");
		default:
			return "Usage: step config path|show|init";
	}
}
