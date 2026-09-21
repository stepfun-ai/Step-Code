/**
 * CLI argument parsing and help display
 */

import type { ThinkingLevel } from "@step-harness/agent-core";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, ENV_SESSION_DIR, IS_STEP_ENTRYPOINT } from "../config.ts";
import type { ExtensionFlag } from "../core/extensions/types.ts";
import type { TuiMode } from "../core/settings-manager.ts";
import { getStepDefaultProvider } from "../step/defaults.ts";
import type { StepNonInteractiveApproval, StepPermissionMode, StepToolPermissionMode } from "../step/permissions.ts";

export type Mode = "text" | "json" | "rpc";

export interface Args {
	provider?: string;
	model?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ThinkingLevel;
	continue?: boolean;
	resume?: boolean;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	/** Length-prefixed bidirectional Step Agent SDK protocol. */
	sdkStdio?: boolean;
	name?: string;
	noSession?: boolean;
	session?: string;
	sessionId?: string;
	fork?: string;
	sessionDir?: string;
	models?: string[];
	tools?: string[];
	excludeTools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	extensions?: string[];
	noExtensions?: boolean;
	print?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	useTheme?: string;
	noThemes?: boolean;
	noContextFiles?: boolean;
	listModels?: string | true;
	/** Enable/disable the Step binary update check for this invocation. */
	updateCheck?: boolean;
	tuiMode?: TuiMode;
	verbose?: boolean;
	/** Request-time lightweight context projection mode (step.compaction.contextProjection). */
	contextProjection?: "off" | "lightweight-v1";
	projectTrustOverride?: boolean;
	/** Step tool approval mode (confirm, auto, or strict). */
	approvalMode?: StepPermissionMode;
	/** Fallback for approval requests when no interactive UI is available. */
	nonInteractiveApproval?: StepNonInteractiveApproval;
	/** Repeated per-tool approval overrides (canonical runtime option name). */
	toolOverride?: Record<string, StepToolPermissionMode>;
	/** Backward-compatible plural alias for callers that used the TUI vocabulary. */
	toolOverrides?: Record<string, StepToolPermissionMode>;
	messages: string[];
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isValidThinkingLevel(level: string): level is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(level as ThinkingLevel);
}

export function normalizeSessionName(value: string): string | undefined {
	const name = value.trim();
	return name.length > 0 ? name : undefined;
}

/**
 * Split a single `@`-prefixed CLI argument into its file token and any trailing
 * message text, recording both on `result`.
 *
 * The file token follows the same rule the interactive editor teaches users
 * (see packages/tui/src/components/editor.ts `buildDebouncePattern`, which matches
 * `@(?:"[^"]*|[^\s]*)`): it runs to the first whitespace (JS `\s`, so Unicode-aware —
 * the same boundary the editor uses), unless it is written as `@"..."`, in which case
 * the closing quote bounds it and spaces inside are part of the path. The boundary is
 * deliberately whitespace + the `@"..."` quote ONLY — not the wider autocomplete
 * `PATH_DELIMITERS` set, which also treats `'` and `=` as boundaries; those are
 * valid filename characters that must not truncate a path here.
 *
 * A bare `@` (or `@` followed only by whitespace, or an empty `@""`) is not a file
 * reference; the original argument is kept as message text instead.
 */
function pushAtFileArg(result: Args, rawArg: string): void {
	const rest = rawArg.slice(1); // strip leading "@"

	let file: string;
	let message: string;
	if (rest.startsWith('"')) {
		const close = rest.indexOf('"', 1);
		if (close === -1) {
			// Unclosed quote: tolerant, matching the editor — the whole rest is the path.
			file = rest.slice(1);
			message = "";
		} else {
			file = rest.slice(1, close);
			message = rest.slice(close + 1).trim();
		}
	} else {
		const wsIndex = rest.search(/\s/);
		if (wsIndex === -1) {
			file = rest;
			message = "";
		} else {
			file = rest.slice(0, wsIndex);
			message = rest.slice(wsIndex).trim();
		}
	}

	if (file.length > 0) {
		result.fileArgs.push(file);
		if (message.length > 0) {
			result.messages.push(message);
		}
	} else {
		// No usable file token (bare "@", `@""`, or "@ ..."): keep the literal argument as text.
		result.messages.push(rawArg);
	}
}

/**
 * Read the value for a value-taking option.
 *
 * If the next token is missing or looks like another option, record a
 * "requires a value" diagnostic and return undefined WITHOUT consuming the token,
 * so it is still parsed on the next loop iteration: `--session-dir --version`
 * reports the missing value and leaves `--version` to be parsed as the flag it is,
 * instead of creating a directory named "--version".
 *
 * "Looks like another option" means it starts with "-" AND contains no whitespace,
 * because an option token never contains whitespace. That distinction matters for
 * free-text options: `--append-system-prompt "- be terse"` and a prompt opening
 * with YAML front matter are ordinary values, not options, and must still be
 * accepted. A dash-leading single word (`--system-prompt -terse`) is genuinely
 * ambiguous and is rejected; pass such text via a file instead, which
 * resolvePromptInput already supports.
 *
 * `flag` is the canonical long name used in the message, even when a short alias
 * (e.g. `-t`) was typed, so it lines up with the help text.
 */
function takeOptionValue(
	args: string[],
	i: number,
	flag: string,
	result: Args,
): { value: string; nextIndex: number } | undefined {
	const next = args[i + 1];
	if (next === undefined || (next.startsWith("-") && !/\s/.test(next))) {
		result.diagnostics.push({ type: "error", message: `${flag} requires a value` });
		return undefined;
	}
	return { value: next, nextIndex: i + 1 };
}

export function parseArgs(args: string[]): Args {
	const result: Args = {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--") {
			for (const positionalArg of args.slice(i + 1)) {
				if (positionalArg.startsWith("@")) {
					pushAtFileArg(result, positionalArg);
				} else {
					result.messages.push(positionalArg);
				}
			}
			break;
		} else if (arg === "--help" || arg === "-h") {
			result.help = true;
		} else if (arg === "--version" || arg === "-v") {
			result.version = true;
		} else if (arg === "--mode") {
			const taken = takeOptionValue(args, i, "--mode", result);
			if (taken) {
				i = taken.nextIndex;
				if (taken.value === "text" || taken.value === "json" || taken.value === "rpc") {
					result.mode = taken.value;
				}
			}
		} else if (arg === "--approval-mode" || arg.startsWith("--approval-mode=")) {
			const value = arg === "--approval-mode" ? args[i + 1] : arg.slice("--approval-mode=".length);
			if (arg === "--approval-mode" && (value === undefined || value.startsWith("-"))) {
				result.diagnostics.push({ type: "error", message: "--approval-mode requires confirm, auto, or strict" });
			} else {
				if (arg === "--approval-mode") i++;
				if (value === "confirm" || value === "auto" || value === "strict") {
					result.approvalMode = value;
				} else {
					result.diagnostics.push({
						type: "error",
						message: `Invalid approval mode "${value}". Valid values: confirm, auto, strict`,
					});
				}
			}
		} else if (arg === "--non-interactive-approval" || arg.startsWith("--non-interactive-approval=")) {
			const value =
				arg === "--non-interactive-approval" ? args[i + 1] : arg.slice("--non-interactive-approval=".length);
			if (arg === "--non-interactive-approval" && (value === undefined || value.startsWith("-"))) {
				result.diagnostics.push({
					type: "error",
					message: "--non-interactive-approval requires allow or deny",
				});
			} else {
				if (arg === "--non-interactive-approval") i++;
				if (value === "allow" || value === "deny") {
					result.nonInteractiveApproval = value;
				} else {
					result.diagnostics.push({
						type: "error",
						message: `Invalid non-interactive approval mode "${value}". Valid values: allow, deny`,
					});
				}
			}
		} else if (arg === "--tool-override" || arg.startsWith("--tool-override=")) {
			const value = arg === "--tool-override" ? args[i + 1] : arg.slice("--tool-override=".length);
			if (arg === "--tool-override" && (value === undefined || value.startsWith("-"))) {
				result.diagnostics.push({
					type: "error",
					message: "--tool-override requires <tool=allow|confirm|deny>",
				});
			} else {
				if (arg === "--tool-override") i++;
				const separator = value?.indexOf("=") ?? -1;
				const tool = separator > 0 ? value!.slice(0, separator).trim() : "";
				const mode = separator > 0 ? value!.slice(separator + 1).trim() : "";
				if (!tool || (mode !== "allow" && mode !== "confirm" && mode !== "deny")) {
					result.diagnostics.push({
						type: "error",
						message: `Invalid --tool-override "${value}". Expected <tool=allow|confirm|deny>`,
					});
				} else {
					result.toolOverride ??= {};
					result.toolOverride[tool] = mode;
					result.toolOverrides = result.toolOverride;
				}
			}
		} else if (arg === "--continue" || arg === "-c") {
			result.continue = true;
		} else if (arg === "--resume" || arg === "-r") {
			// Optional value: `--resume <path|id>` opens that session directly
			// (same resolution as --session); bare `--resume` opens the selector.
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				result.session = args[++i];
			} else {
				result.resume = true;
			}
		} else if (arg === "--provider") {
			const taken = takeOptionValue(args, i, "--provider", result);
			if (taken) {
				result.provider = taken.value;
				i = taken.nextIndex;
			}
		} else if (arg === "--model") {
			const taken = takeOptionValue(args, i, "--model", result);
			if (taken) {
				result.model = taken.value;
				i = taken.nextIndex;
			}
		} else if (arg === "--api-key") {
			const taken = takeOptionValue(args, i, "--api-key", result);
			if (taken) {
				result.apiKey = taken.value;
				i = taken.nextIndex;
			}
		} else if (arg === "--system-prompt") {
			const taken = takeOptionValue(args, i, "--system-prompt", result);
			if (taken) {
				result.systemPrompt = taken.value;
				i = taken.nextIndex;
			}
		} else if (arg === "--append-system-prompt") {
			const taken = takeOptionValue(args, i, "--append-system-prompt", result);
			if (taken) {
				result.appendSystemPrompt = result.appendSystemPrompt ?? [];
				result.appendSystemPrompt.push(taken.value);
				i = taken.nextIndex;
			}
		} else if (arg === "--name" || arg === "-n") {
			const taken = takeOptionValue(args, i, "--name", result);
			if (taken) {
				result.name = taken.value;
				i = taken.nextIndex;
			}
		} else if (arg === "--no-session") {
			result.noSession = true;
		} else if (arg === "--session") {
			const taken = takeOptionValue(args, i, "--session", result);
			if (taken) {
				result.session = taken.value;
				i = taken.nextIndex;
			}
		} else if (arg === "--session-id") {
			const taken = takeOptionValue(args, i, "--session-id", result);
			if (taken) {
				result.sessionId = taken.value;
				i = taken.nextIndex;
			}
		} else if (arg === "--fork") {
			const taken = takeOptionValue(args, i, "--fork", result);
			if (taken) {
				result.fork = taken.value;
				i = taken.nextIndex;
			}
		} else if (arg === "--session-dir") {
			const taken = takeOptionValue(args, i, "--session-dir", result);
			if (taken) {
				result.sessionDir = taken.value;
				i = taken.nextIndex;
			}
		} else if (arg === "--models") {
			const taken = takeOptionValue(args, i, "--models", result);
			if (taken) {
				result.models = taken.value.split(",").map((s) => s.trim());
				i = taken.nextIndex;
			}
		} else if (arg === "--no-tools" || arg === "-nt") {
			result.noTools = true;
		} else if (arg === "--no-builtin-tools" || arg === "-nbt") {
			result.noBuiltinTools = true;
		} else if (arg === "--tools" || arg === "-t") {
			const taken = takeOptionValue(args, i, "--tools", result);
			if (taken) {
				result.tools = taken.value
					.split(",")
					.map((s) => s.trim())
					.filter((name) => name.length > 0);
				i = taken.nextIndex;
			}
		} else if (arg === "--exclude-tools" || arg === "-xt") {
			const taken = takeOptionValue(args, i, "--exclude-tools", result);
			if (taken) {
				result.excludeTools = taken.value
					.split(",")
					.map((s) => s.trim())
					.filter((name) => name.length > 0);
				i = taken.nextIndex;
			}
		} else if (arg === "--thinking") {
			const taken = takeOptionValue(args, i, "--thinking", result);
			if (taken) {
				i = taken.nextIndex;
				if (isValidThinkingLevel(taken.value)) {
					result.thinking = taken.value;
				} else {
					result.diagnostics.push({
						type: "warning",
						message: `Invalid thinking level "${taken.value}". Valid values: ${VALID_THINKING_LEVELS.join(", ")}`,
					});
				}
			}
		} else if (arg === "--print" || arg === "-p") {
			result.print = true;
			const next = args[i + 1];
			if (next !== undefined && !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---"))) {
				result.messages.push(next);
				i++;
			}
		} else if (arg === "--export") {
			const taken = takeOptionValue(args, i, "--export", result);
			if (taken) {
				result.export = taken.value;
				i = taken.nextIndex;
			}
		} else if (arg === "--extension" || arg === "-e") {
			const taken = takeOptionValue(args, i, "--extension", result);
			if (taken) {
				result.extensions = result.extensions ?? [];
				result.extensions.push(taken.value);
				i = taken.nextIndex;
			}
		} else if (arg === "--no-extensions" || arg === "-ne") {
			result.noExtensions = true;
		} else if (arg === "--skill") {
			const taken = takeOptionValue(args, i, "--skill", result);
			if (taken) {
				result.skills = result.skills ?? [];
				result.skills.push(taken.value);
				i = taken.nextIndex;
			}
		} else if (arg === "--prompt-template") {
			const taken = takeOptionValue(args, i, "--prompt-template", result);
			if (taken) {
				result.promptTemplates = result.promptTemplates ?? [];
				result.promptTemplates.push(taken.value);
				i = taken.nextIndex;
			}
		} else if (arg === "--theme") {
			const taken = takeOptionValue(args, i, "--theme", result);
			if (taken) {
				result.themes = result.themes ?? [];
				result.themes.push(taken.value);
				i = taken.nextIndex;
			}
		} else if (arg === "--use-theme") {
			const themeName = args[i + 1];
			if (themeName === undefined || themeName.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--use-theme requires a theme name" });
			} else {
				result.useTheme = themeName;
				i++;
			}
		} else if (arg === "--no-skills" || arg === "-ns") {
			result.noSkills = true;
		} else if (arg === "--no-prompt-templates" || arg === "-np") {
			result.noPromptTemplates = true;
		} else if (arg === "--no-themes") {
			result.noThemes = true;
		} else if (arg === "--no-context-files" || arg === "-nc") {
			result.noContextFiles = true;
		} else if (arg === "--list-models") {
			// Check if next arg is a search pattern (not a flag or file arg)
			if (i + 1 < args.length && !args[i + 1].startsWith("-") && !args[i + 1].startsWith("@")) {
				result.listModels = args[++i];
			} else {
				result.listModels = true;
			}
		} else if (arg === "--tui-mode") {
			const mode = args[i + 1];
			if (mode === "regular" || mode === "fullscreen") {
				result.tuiMode = mode;
				i++;
			} else if (mode === undefined || mode.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--tui-mode requires regular or fullscreen" });
			} else {
				i++;
				result.diagnostics.push({
					type: "error",
					message: `Invalid TUI mode "${mode}". Valid values: regular, fullscreen`,
				});
			}
		} else if (arg === "--verbose") {
			result.verbose = true;
		} else if (arg === "--context-projection") {
			const mode = args[i + 1];
			if (mode === "off" || mode === "lightweight-v1") {
				result.contextProjection = mode;
				i++;
			} else if (mode === undefined || mode.startsWith("-")) {
				result.diagnostics.push({ type: "error", message: "--context-projection requires off or lightweight-v1" });
			} else {
				i++;
				result.diagnostics.push({
					type: "error",
					message: `Invalid context projection mode "${mode}". Valid values: off, lightweight-v1`,
				});
			}
		} else if (arg === "--approve" || arg === "-a") {
			result.projectTrustOverride = true;
		} else if (arg === "--no-approve" || arg === "-na") {
			result.projectTrustOverride = false;
		} else if (arg === "--update-check") {
			result.updateCheck = true;
		} else if (arg === "--no-update-check") {
			result.updateCheck = false;
		} else if (arg === "--sdk-stdio") {
			result.sdkStdio = true;
		} else if (arg.startsWith("@")) {
			pushAtFileArg(result, arg); // "@path [message]" — split file token from trailing text
		} else if (arg.startsWith("--")) {
			const eqIndex = arg.indexOf("=");
			if (eqIndex !== -1) {
				result.unknownFlags.set(arg.slice(2, eqIndex), arg.slice(eqIndex + 1));
			} else {
				const flagName = arg.slice(2);
				const next = args[i + 1];
				if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
					result.unknownFlags.set(flagName, next);
					i++;
				} else {
					result.unknownFlags.set(flagName, true);
				}
			}
		} else if (arg.startsWith("-") && !arg.startsWith("--")) {
			result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
		} else if (!arg.startsWith("-")) {
			result.messages.push(arg);
		}
	}

	return result;
}

export function printHelp(extensionFlags?: ExtensionFlag[]): void {
	const defaultProvider = IS_STEP_ENTRYPOINT ? getStepDefaultProvider() : "google";
	const stepEnvironmentText = IS_STEP_ENTRYPOINT
		? [
				"  STEP_PROVIDER                    Default provider for the step entrypoint",
				"  STEP_MODEL                       Default model for the step entrypoint",
				"  STEP_API_KEY                     API key for the Step provider",
				"  STEP_BASE_URL                    Step provider API base URL",
				"  STEPCODE_DEFAULT_THEME           Default interactive theme for step",
				"  STEPCODE_DISABLE_PI_SERVICES     Disable upstream update/catalog services (enabled by step)",
				"  STEP_APPROVAL_MODE               Default tool approval mode (confirm|auto|strict)",
				"  STEP_NON_INTERACTIVE_APPROVAL    Fallback when no approval UI is available (allow|deny)",
				"  STEP_AUTOPILOT                   Enable bounded model-error auto-resume",
			].join("\n")
		: "";
	const stepPermissionOptionsText = IS_STEP_ENTRYPOINT
		? "\n  --approval-mode <mode>           Tool approval mode: confirm, auto, or strict\n  --non-interactive-approval <mode> Fallback without a UI: allow or deny\n  --tool-override <tool=mode>       Per-tool override (repeatable; mode: allow, confirm, deny)"
		: "";
	const stepAuthCommandsText = IS_STEP_ENTRYPOINT
		? `\n  ${APP_NAME} login                       Sign in with the Step account (OAuth)\n  ${APP_NAME} logout                      Remove the stored Step credential`
		: "";
	const extensionFlagsText =
		extensionFlags && extensionFlags.length > 0
			? `\n${chalk.bold("Extension CLI Flags:")}\n${extensionFlags
					.map((flag) => {
						const value = flag.type === "string" ? " <value>" : "";
						const description = flag.description ?? `Registered by ${flag.extensionPath}`;
						return `  --${flag.name}${value}`.padEnd(30) + description;
					})
					.join("\n")}\n`
			: "";
	console.log(`${chalk.bold(APP_NAME)} - AI coding assistant with read, bash, edit, write tools

${chalk.bold("Usage:")}
  ${APP_NAME} [options] [--] [@files...] [messages...]

${chalk.bold("Commands:")}
  ${APP_NAME} install <source> [-l]     Install extension source and add to settings
  ${APP_NAME} remove <source> [-l]      Remove extension source from settings
  ${APP_NAME} uninstall <source> [-l]   Alias for remove
  ${APP_NAME} update [source|self|${APP_NAME}]   Update ${APP_NAME}, extensions, or model catalogs
  ${APP_NAME} list                      List installed extensions from settings
  ${APP_NAME} config [-l]               Open TUI to enable/disable package resources (Tab switches scope)
  ${APP_NAME} auth <command>            Print credentials or check provider readiness
${stepAuthCommandsText}
  ${APP_NAME} <command> --help          Show help for install/remove/uninstall/update/list/config/auth

${chalk.bold("Options:")}
  --provider <name>              Provider name (default: ${defaultProvider})
  --model <pattern>              Model pattern or ID (supports "provider/id" and optional ":<thinking>")
  --api-key <key>                API key (defaults to env vars)
  --system-prompt <text>         System prompt (default: coding assistant prompt)
  --append-system-prompt <text>  Append text or file contents to the system prompt (can be used multiple times)
  --mode <mode>                  Output mode: text (default), json, or rpc
${stepPermissionOptionsText}
  --sdk-stdio                    Run the Step Agent SDK length-prefixed stdio host
  --print, -p                    Non-interactive mode: process prompt and exit
  --continue, -c                 Continue previous session
  --resume, -r [path|id]         Resume a session: with a path/id resume it directly, without opens a selector
  --session <path|id>            Use specific session file or partial UUID
  --session-id <id>              Use exact project session ID, creating it if missing
  --fork <path|id>               Fork specific session file or partial UUID into a new session
  --session-dir <dir>            Directory for session storage and lookup
  --no-session                   Don't save session (ephemeral)
  --name, -n <name>              Set session display name
  --models <patterns>            Comma-separated model patterns for Ctrl+P cycling
                                 Supports globs (step/*, *flash*) and fuzzy matching
  --no-tools, -nt                Disable all tools by default (built-in and extension)
  --no-builtin-tools, -nbt       Disable built-in tools by default but keep extension/custom tools enabled
  --tools, -t <tools>            Comma-separated allowlist of tool names to enable
                                 Applies to built-in, extension, and custom tools
  --exclude-tools, -xt <tools>   Comma-separated denylist of tool names to disable
                                 Applies to built-in, extension, and custom tools
  --thinking <level>             Set thinking level: off, minimal, low, medium, high, xhigh, max
  --extension, -e <path>         Load an extension file (can be used multiple times)
  --no-extensions, -ne           Disable extension discovery (explicit -e paths still work)
  --skill <path>                 Load a skill file or directory (can be used multiple times)
  --no-skills, -ns               Disable skills discovery and loading
  --prompt-template <path>       Load a prompt template file or directory (can be used multiple times)
  --no-prompt-templates, -np     Disable prompt template discovery and loading
  --theme <path>                 Load a theme file or directory (can be used multiple times)
  --use-theme <name[/name]>      Set the initial interactive theme for this run
  --no-themes                    Disable theme discovery and loading
  --no-context-files, -nc        Disable AGENTS.md and CLAUDE.md discovery and loading
  --export <file>                Export session file to HTML and exit
  --list-models [search]         List available models (with optional fuzzy search)
  --verbose                      Force verbose startup (overrides quietStartup setting)
  --context-projection <mode>    Request-time context projection: off (default) or lightweight-v1
  --tui-mode <mode>              TUI mode: regular (default) or fullscreen
  --approve, -a                  Trust project-local files for this run
  --no-approve, -na              Ignore project-local files for this run
  --update-check                 Check for a newer Step binary at startup
  --no-update-check              Skip the Step binary update check for this run
  --                             End option parsing; treat remaining arguments as messages/files
  --help, -h                     Show this help
  --version, -v                  Show version number

Extensions can register additional flags (e.g., --plan from plan-mode extension).${extensionFlagsText}

${chalk.bold("Examples:")}
  # Print a provider API key for an external client
  ${APP_NAME} auth print-api-key --provider step

  # Print an OAuth bearer token for an external client (refreshes if expired)
  ${APP_NAME} auth print-bearer-token --provider step

  # Interactive mode
  ${APP_NAME}

  # Interactive mode with initial prompt
  ${APP_NAME} "List all .ts files in src/"

  # Include files in initial message
  ${APP_NAME} @prompt.md @image.png "What color is the sky?"

  # Non-interactive mode (process and exit)
  ${APP_NAME} -p "List all .ts files in src/"

  # Prompt beginning with a dash
  ${APP_NAME} -p -- "- Summarize these points"

  # Multiple messages (interactive)
  ${APP_NAME} "Read package.json" "What dependencies do we have?"

  # Continue previous session
  ${APP_NAME} --continue "What did we discuss?"

  # Resume a specific session by id (or open a selector with bare --resume)
  ${APP_NAME} --resume 9b8fe41b-40f1-4f10-a869-1d2a6128a52e

  # Start a named session
  ${APP_NAME} --name "Refactor auth module"

  # Use a specific model
  ${APP_NAME} --model step-3.7-flash "Help me refactor this code"

  # Use model with provider prefix (no --provider needed)
  ${APP_NAME} --model step/step-3.7-flash "Help me refactor this code"

  # Use model with thinking level shorthand
  ${APP_NAME} --model step-3.7-flash:high "Solve this complex problem"

  # Limit model cycling to specific models
  ${APP_NAME} --models step-3.7-flash,step-3.5-flash

  # Limit to a specific provider with glob pattern
  ${APP_NAME} --models "step/*"

  # Cycle models with fixed thinking levels
  ${APP_NAME} --models step-3.7-flash:high,step-3.5-flash:low

  # Start with a specific thinking level
  ${APP_NAME} --thinking high "Solve this complex problem"

  # Read-only mode (no file modifications possible)
  ${APP_NAME} --tools read,grep,find,ls -p "Review the code in src/"

  # Disable one tool while keeping the rest available
  ${APP_NAME} --exclude-tools ask_question

  # Export a session file to HTML
  ${APP_NAME} --export ~/${CONFIG_DIR_NAME}/agent/sessions/--path--/session.jsonl
  ${APP_NAME} --export session.jsonl output.html

${chalk.bold("Environment Variables:")}
  ${ENV_AGENT_DIR.padEnd(32)} - Config directory (default: ~/${CONFIG_DIR_NAME}/agent)
  ${ENV_SESSION_DIR.padEnd(32)} - Session storage directory (overridden by --session-dir)
${stepEnvironmentText}

${chalk.bold("Built-in Tool Names:")}
  read       - Read file contents
  bash       - Execute bash commands
  powershell - Execute PowerShell commands on Windows
  edit       - Edit files with find/replace
  write      - Write files (creates/overwrites)
  grep       - Search file contents (read-only, off by default)
  find       - Find files by glob pattern (read-only, off by default)
  ls         - List directory contents (read-only, off by default)
`);
}
