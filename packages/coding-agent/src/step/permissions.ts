/**
 * Step's permission presets layered on top of pi's native tool-call hook.
 *
 * The agent loop and tool executor remain pi-owned. This module only decides
 * whether a prepared call is allowed, needs a UI confirmation, or is blocked,
 * and schedules the optional autopilot continuation after a failed run.
 */

import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AgentEndEvent,
	ExtensionContext,
	ExtensionUIContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "../core/extensions/types.ts";

export type StepPermissionPresetId = "ask" | "read-only" | "bypass" | "autopilot";
export type StepPermissionMode = "confirm" | "strict" | "auto";
export type StepNonInteractiveApproval = "allow" | "deny";
export type StepToolPermissionMode = "allow" | "confirm" | "deny";

export interface StepPermissionPreset {
	id: StepPermissionPresetId;
	label: string;
	description: string;
	mode: StepPermissionMode;
	nonInteractiveApproval: StepNonInteractiveApproval;
	autoResume: boolean;
}

export const STEP_PERMISSION_PRESETS: readonly StepPermissionPreset[] = [
	{
		id: "ask",
		label: "Ask",
		description: "Safe tools run; writes and commands ask first",
		mode: "confirm",
		nonInteractiveApproval: "deny",
		autoResume: false,
	},
	{
		id: "read-only",
		label: "Read Only",
		description: "Read and discovery tools only",
		mode: "strict",
		nonInteractiveApproval: "deny",
		autoResume: false,
	},
	{
		id: "bypass",
		label: "Bypass",
		description: "Run tools without approval prompts",
		mode: "auto",
		nonInteractiveApproval: "allow",
		autoResume: false,
	},
	{
		id: "autopilot",
		label: "Autopilot",
		description: "Bypass approvals and resume transient model failures",
		mode: "auto",
		nonInteractiveApproval: "allow",
		autoResume: true,
	},
];

const STEP_PERMISSION_PRESET_IDS = new Set<StepPermissionPresetId>(STEP_PERMISSION_PRESETS.map((preset) => preset.id));

/** Tools which do not mutate the workspace or start an external process. */
const READ_ONLY_TOOLS = new Set([
	"list_directory",
	"find_files",
	"search_files",
	"search_web",
	"read_file",
	"find_tools",
	// Keep native names safe when a caller explicitly enables a native tool.
	"ls",
	"find",
	"grep",
	"read",
]);

const WRITE_OR_EXECUTE_TOOLS = new Set([
	"write_file",
	"edit_file",
	"run_command",
	"write",
	"edit",
	"bash",
	"powershell",
	"user_bash",
]);

const DANGEROUS_COMMAND_PATTERNS = [
	/\bmkfs(?:\.[\w.-]+)?\b/iu,
	/\bdd\s+if=/iu,
	/\b:>\s*\/dev\//u,
	/\bgit\s+(?:reset\s+--hard|clean\s+-[^\n]*f|push\s+[^\n]*--force(?:-with-lease)?)/iu,
	/\b(?:drop\s+database|truncate\s+table)\b/iu,
];

const DANGEROUS_LIFECYCLE_COMMANDS = new Set(["reboot", "shutdown"]);
const DANGEROUS_LIFECYCLE_SUBCOMMANDS = new Set(["init", "loginctl", "systemctl", "telinit"]);
const COMMAND_WRAPPERS = new Set(["command", "doas", "env", "exec", "nohup", "sudo"]);
const SHELL_INTERPRETERS = new Set(["bash", "dash", "fish", "ksh", "powershell", "pwsh", "sh", "zsh"]);
const SHELL_CONTROL_PREFIXES = new Set(["!", "{", "}", "do", "elif", "else", "if", "then", "until", "while"]);
const WRAPPER_OPTIONS_WITH_VALUES = new Set(["--chdir", "--chroot", "--group", "--user", "-c", "-r", "-g", "-u"]);
const HOME_SHORTHAND_PATTERN = /^(~|\$HOME|\$\{HOME\})\/?$/u;
const CRITICAL_RM_RF_ROOTS = [
	"/",
	"/etc",
	"/usr",
	"/bin",
	"/sbin",
	"/var",
	"/boot",
	"/root",
	"/System",
	"/Library",
	"/Applications",
	"/Users",
];

/** Backoff shared with the previous Step gateway host (5s, 15s, 45s, 2m, 5m). */
const DEFAULT_AUTO_RESUME_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000] as const;
/** Unattended continuations are deliberately capped even when the ladder is extended. */
export const MAX_AUTO_RESUME_ATTEMPTS = 3;

export interface StepPermissionState {
	preset: StepPermissionPresetId;
	mode: StepPermissionMode;
	nonInteractiveApproval: StepNonInteractiveApproval;
	autoResume: boolean;
	/** Per-tool policy overrides supplied by the Step CLI or an embedding host. */
	toolOverrides?: Readonly<Record<string, StepToolPermissionMode>>;
}

export interface StepToolDecision {
	action: "allow" | "confirm" | "deny";
	hazardous: boolean;
	reason: string;
}

export interface StepPermissionControllerOptions {
	initialPreset?: StepPermissionPresetId;
	/** Explicit approval mode (CLI `--approval-mode` takes precedence over env). */
	approvalMode?: StepPermissionMode;
	/** Fallback for confirmation requests when no interactive UI exists. */
	nonInteractiveApproval?: StepNonInteractiveApproval;
	/** Enables the bounded continuation ladder when the mode permits it. */
	autoResume?: boolean;
	/** Per-tool overrides (CLI `--tool-override` is merged here). */
	toolOverrides?: Record<string, StepToolPermissionMode>;
	env?: Record<string, string | undefined>;
}

export function getStepPermissionPreset(id: string | undefined): StepPermissionPreset | undefined {
	const normalized = normalizeStepPermissionPresetId(id);
	if (!normalized || !STEP_PERMISSION_PRESET_IDS.has(normalized)) return undefined;
	return STEP_PERMISSION_PRESETS.find((preset) => preset.id === normalized);
}

/** Normalize the mode vocabulary used by older Step clients and pi hosts. */
export function normalizeStepPermissionPresetId(value: string | undefined): StepPermissionPresetId | undefined {
	switch (value?.trim().toLowerCase()) {
		case "ask":
		case "confirm":
			return "ask";
		case "read-only":
		case "readonly":
		case "strict":
			return "read-only";
		case "bypass":
		case "auto":
		case "bypasspermissions":
			return "bypass";
		case "autopilot":
			return "autopilot";
		default:
			return undefined;
	}
}

/** Normalize the low-level approval-mode vocabulary used by Step runtime options. */
export function normalizeStepPermissionMode(value: string | undefined): StepPermissionMode | undefined {
	switch (value?.trim().toLowerCase()) {
		case "confirm":
		case "ask":
		case "default":
		case "acceptedits":
			return "confirm";
		case "strict":
		case "read-only":
		case "readonly":
		case "plan":
			return "strict";
		case "auto":
		case "bypass":
		case "bypasspermissions":
			return "auto";
		default:
			return undefined;
	}
}

/** Resolve an initial product preset without changing pi's settings format. */
export function resolveInitialStepPermissionPreset(
	options: StepPermissionControllerOptions = {},
): StepPermissionPresetId {
	if (options.initialPreset && getStepPermissionPreset(options.initialPreset)) {
		return options.initialPreset;
	}

	const env = options.env ?? process.env;
	// `STEP_APPROVAL_MODE` is the explicit low-level override. Preserve the
	// existing preset-first behavior for the older `STEP_PERMISSION_MODE` alias.
	const explicitMode = options.approvalMode ?? normalizeStepPermissionMode(env.STEP_APPROVAL_MODE);
	if (explicitMode) {
		const nonInteractive =
			options.nonInteractiveApproval ??
			(env.STEP_NON_INTERACTIVE_APPROVAL ?? env.STEP_NONINTERACTIVE_APPROVAL)?.trim().toLowerCase();
		const autoResume = options.autoResume ?? (isTruthy(env.STEP_AUTOPILOT) || isTruthy(env.STEP_AUTO_RESUME));
		if (explicitMode === "auto") return autoResume && nonInteractive !== "deny" ? "autopilot" : "bypass";
		return explicitMode === "strict" ? "read-only" : "ask";
	}
	const explicitPreset = env.STEP_PERMISSION_PRESET?.trim().toLowerCase();
	const normalizedExplicitPreset = normalizeStepPermissionPresetId(explicitPreset);
	if (normalizedExplicitPreset) return normalizedExplicitPreset;

	const mode = env.STEP_PERMISSION_MODE?.trim().toLowerCase();
	if (mode === "strict" || mode === "read-only" || mode === "readonly") return "read-only";
	if (mode === "auto" || mode === "bypass" || mode === "bypasspermissions") {
		return isTruthy(env.STEP_AUTOPILOT) ? "autopilot" : "bypass";
	}
	if (mode === "confirm" || mode === "ask") return "ask";
	if (isTruthy(env.STEP_AUTOPILOT)) return "autopilot";
	// Default to bypass: tools run without approval prompts. Explicit CLI flags,
	// STEP_* env vars, and any persisted preset are all resolved above this line,
	// so they continue to override the default. Dangerous commands (see
	// decideStepToolCall / isDangerousCommand) still require confirmation even
	// under bypass.
	return "bypass";
}

export function stepPermissionStateForPreset(presetId: StepPermissionPresetId): StepPermissionState {
	const preset = getStepPermissionPreset(presetId) ?? STEP_PERMISSION_PRESETS[0]!;
	return {
		preset: preset.id,
		mode: preset.mode,
		nonInteractiveApproval: preset.nonInteractiveApproval,
		autoResume: preset.autoResume,
	};
}

/** Auto-resume is meaningful only when ordinary confirmations can run unattended. */
export function normalizeAutoResume(
	mode: StepPermissionMode,
	nonInteractiveApproval: StepNonInteractiveApproval,
	autoResume: boolean | undefined,
): boolean {
	return mode === "auto" && nonInteractiveApproval === "allow" && autoResume === true;
}

/**
 * Resolve the complete policy triple. The old Step runtime accepted the mode,
 * non-interactive fallback, and auto-resume flag independently; keep that
 * expressiveness while exposing the nearest preset for the TUI footer.
 */
export function resolveInitialStepPermissionState(options: StepPermissionControllerOptions = {}): StepPermissionState {
	const env = options.env ?? process.env;
	const preset = stepPermissionStateForPreset(resolveInitialStepPermissionPreset(options));
	const mode = options.approvalMode ?? normalizeStepPermissionMode(env.STEP_APPROVAL_MODE);
	const rawNonInteractive =
		options.nonInteractiveApproval ??
		(env.STEP_NON_INTERACTIVE_APPROVAL ?? env.STEP_NONINTERACTIVE_APPROVAL)?.trim().toLowerCase();
	const nonInteractiveApproval: StepNonInteractiveApproval =
		rawNonInteractive === "allow" || rawNonInteractive === "deny" ? rawNonInteractive : preset.nonInteractiveApproval;
	const effectiveMode = mode ?? preset.mode;
	const requestedAutoResume =
		options.autoResume ?? (isTruthy(env.STEP_AUTOPILOT) || isTruthy(env.STEP_AUTO_RESUME) || preset.autoResume);
	const autoResume = normalizeAutoResume(effectiveMode, nonInteractiveApproval, requestedAutoResume);
	const resolved: StepPermissionState = {
		preset: preset.preset,
		mode: effectiveMode,
		nonInteractiveApproval,
		autoResume,
	};
	const matchingPreset =
		STEP_PERMISSION_PRESETS.find(
			(candidate) =>
				candidate.mode === resolved.mode &&
				candidate.nonInteractiveApproval === resolved.nonInteractiveApproval &&
				candidate.autoResume === resolved.autoResume,
		) ?? STEP_PERMISSION_PRESETS.find((candidate) => candidate.mode === resolved.mode);
	if (matchingPreset) resolved.preset = matchingPreset.id;
	if (options.toolOverrides && Object.keys(options.toolOverrides).length > 0) {
		resolved.toolOverrides = cloneToolOverrides(options.toolOverrides);
	}
	return resolved;
}

/**
 * Decide a tool call without involving the terminal. This is intentionally
 * conservative for unknown tools: ask mode confirms them, read-only blocks
 * them, and bypass permits them unless the call is hazardous.
 */
export function decideStepToolCall(
	toolName: string,
	input: Record<string, unknown>,
	state: StepPermissionState,
	overrides: Readonly<Record<string, StepToolPermissionMode>> | undefined = state.toolOverrides,
): StepToolDecision {
	const normalizedName = toolName.trim().toLowerCase();
	const command = extractCommand(input);
	const hazardous = command !== undefined && isDangerousCommand(command);

	if (hazardous) {
		return {
			action: state.mode === "strict" ? "deny" : "confirm",
			hazardous: true,
			reason: `Dangerous command requires confirmation: ${summarizeToolInput(toolName, input)}`,
		};
	}

	const override = findToolOverride(normalizedName, overrides);
	if (override) {
		return {
			action: override,
			hazardous: false,
			reason: `Policy override for ${toolName}: ${override}`,
		};
	}

	const mutating = WRITE_OR_EXECUTE_TOOLS.has(normalizedName) || !READ_ONLY_TOOLS.has(normalizedName);
	if (state.mode === "strict" && mutating) {
		return {
			action: "deny",
			hazardous: false,
			reason: `Read-only mode blocks ${toolName}`,
		};
	}
	if (state.mode === "auto") {
		return {
			action: "allow",
			hazardous: false,
			reason: "Bypass approval mode is enabled",
		};
	}
	if (!mutating) {
		return {
			action: "allow",
			hazardous: false,
			reason: "Read-only tool",
		};
	}
	return {
		action: "confirm",
		hazardous: false,
		reason: `${toolName} can modify the workspace or execute a command`,
	};
}

/** Mutable policy state used by the Step extension instance for one session. */
export class StepPermissionController {
	private state: StepPermissionState;
	private toolOverrides: Record<string, StepToolPermissionMode>;

	constructor(options: StepPermissionControllerOptions = {}) {
		this.state = resolveInitialStepPermissionState(options);
		this.toolOverrides = cloneToolOverrides(options.toolOverrides ?? {});
		if (Object.keys(this.toolOverrides).length > 0) this.state.toolOverrides = { ...this.toolOverrides };
	}

	getState(): StepPermissionState {
		return {
			...this.state,
			...(Object.keys(this.toolOverrides).length > 0 ? { toolOverrides: { ...this.toolOverrides } } : {}),
		};
	}

	setPreset(presetId: string): StepPermissionState | undefined {
		const preset = getStepPermissionPreset(presetId);
		if (!preset) return undefined;
		this.state = stepPermissionStateForPreset(preset.id);
		return this.getState();
	}

	cycle(): StepPermissionState {
		const index = STEP_PERMISSION_PRESETS.findIndex((preset) => preset.id === this.state.preset);
		const next = STEP_PERMISSION_PRESETS[(index + 1) % STEP_PERMISSION_PRESETS.length]!;
		this.state = stepPermissionStateForPreset(next.id);
		return this.getState();
	}

	decide(toolName: string, input: Record<string, unknown>): StepToolDecision {
		return decideStepToolCall(toolName, input, this.state, this.toolOverrides);
	}

	getOverrides(): Record<string, StepToolPermissionMode> {
		return { ...this.toolOverrides };
	}

	setOverride(toolName: string, mode: StepToolPermissionMode): void {
		const normalizedName = toolName.trim();
		if (!normalizedName || (mode !== "allow" && mode !== "confirm" && mode !== "deny")) return;
		this.toolOverrides[normalizedName.toLowerCase()] = mode;
		this.state.toolOverrides = { ...this.toolOverrides };
	}

	clearOverride(toolName: string): void {
		delete this.toolOverrides[toolName.trim().toLowerCase()];
		if (Object.keys(this.toolOverrides).length === 0) delete this.state.toolOverrides;
		else this.state.toolOverrides = { ...this.toolOverrides };
	}

	/** Apply the policy through Pi's before-tool-call result contract. */
	async handleToolCall(event: ToolCallEvent, context: ExtensionContext): Promise<ToolCallEventResult | undefined> {
		const input = event.input;
		const decision = this.decide(event.toolName, input);
		if (decision.action === "allow") return undefined;

		if (decision.action === "deny") {
			return { block: true, terminate: true, reason: decision.reason };
		}

		if (!context.hasUI) {
			// Match the old Step policy: an explicit non-interactive `allow` can
			// approve an ordinary confirmation once, while hazardous commands always
			// fail closed. The default remains deny.
			if (!decision.hazardous && this.state.nonInteractiveApproval === "allow") return undefined;
			return {
				block: true,
				terminate: true,
				reason:
					decision.hazardous || this.state.nonInteractiveApproval === "deny"
						? `${decision.reason} (no interactive approval is available)`
						: decision.reason,
			};
		}

		const approved = await context.ui.confirm(
			decision.hazardous ? "Confirm dangerous tool call" : "Approve tool call",
			`${decision.reason}\n\n${summarizeToolInput(event.toolName, input)}`,
			{ signal: context.signal },
		);
		if (approved) return undefined;
		return { block: true, reason: `Tool call denied: ${event.toolName}` };
	}
}

function cloneToolOverrides(overrides: Record<string, StepToolPermissionMode>): Record<string, StepToolPermissionMode> {
	const result: Record<string, StepToolPermissionMode> = {};
	for (const [name, mode] of Object.entries(overrides)) {
		const normalizedName = name.trim().toLowerCase();
		if (!normalizedName || (mode !== "allow" && mode !== "confirm" && mode !== "deny")) continue;
		result[normalizedName] = mode;
	}
	return result;
}

function findToolOverride(
	toolName: string,
	overrides: Readonly<Record<string, StepToolPermissionMode>> | undefined,
): StepToolPermissionMode | undefined {
	if (!overrides) return undefined;
	const direct = overrides[toolName];
	if (direct === "allow" || direct === "confirm" || direct === "deny") return direct;
	return undefined;
}

function extractCommand(input: Record<string, unknown>): string | undefined {
	for (const key of ["command", "cmd", "script"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return undefined;
}

export function isDangerousCommand(command: string): boolean {
	const normalized = command.trim();
	return (
		containsDangerousRmRf(normalized) ||
		containsDangerousLifecycleCommand(normalized) ||
		DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))
	);
}

/** Detect reboot/shutdown at a shell command position, including wrappers. */
export function containsDangerousLifecycleCommand(command: string): boolean {
	for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/gu)) {
		const nested = match[1] ?? match[2];
		if (nested && containsDangerousLifecycleCommand(nested)) return true;
	}
	return tokenizeShellCommands(command).some((tokens) => {
		const commandToken = findShellCommandToken(tokens);
		if (!commandToken) return false;
		if (DANGEROUS_LIFECYCLE_COMMANDS.has(commandToken.name)) return true;
		if (DANGEROUS_LIFECYCLE_SUBCOMMANDS.has(commandToken.name)) {
			return tokens
				.slice(commandToken.index + 1)
				.some((token) => DANGEROUS_LIFECYCLE_COMMANDS.has(normalizeCommandToken(token)));
		}
		if (SHELL_INTERPRETERS.has(commandToken.name)) {
			for (let index = commandToken.index + 1; index < tokens.length; index += 1) {
				const option = normalizeCommandToken(tokens[index]!);
				if (!/^-.*c$/u.test(option) && option !== "-command") continue;
				return containsDangerousLifecycleCommand(tokens.slice(index + 1).join(" "));
			}
		}
		return false;
	});
}

function tokenizeShellCommands(command: string): string[][] {
	const segments: string[][] = [];
	let tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;
	const pushToken = (): void => {
		if (current.length > 0) tokens.push(current);
		current = "";
	};
	const pushSegment = (): void => {
		pushToken();
		if (tokens.length > 0) segments.push(tokens);
		tokens = [];
	};
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index]!;
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (quote === "'") {
			if (character === "'") quote = undefined;
			else current += character;
			continue;
		}
		if (quote === '"' || quote === "`") {
			if (character === quote) quote = undefined;
			else if (character === "\\") escaped = true;
			else current += character;
			continue;
		}
		if (character === "\\") escaped = true;
		else if (character === "'" || character === '"' || character === "`") quote = character;
		else if (character === ";" || character === "&" || character === "|") {
			pushSegment();
			if (command[index + 1] === character) index += 1;
		} else if (character === "\n" || character === "\r") pushSegment();
		else if (/\s/u.test(character)) pushToken();
		else current += character;
	}
	pushSegment();
	return segments;
}

function findShellCommandToken(tokens: string[]): { name: string; index: number } | undefined {
	let index = 0;
	while (index < tokens.length) {
		const rawToken = tokens[index]!;
		const token = normalizeCommandToken(rawToken);
		if (!token || token === "--" || SHELL_CONTROL_PREFIXES.has(token) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(rawToken)) {
			index += 1;
			continue;
		}
		if (COMMAND_WRAPPERS.has(token)) {
			index += 1;
			while (index < tokens.length) {
				const option = normalizeCommandToken(tokens[index]!);
				if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index]!)) {
					index += 1;
					continue;
				}
				if (option === "--") {
					index += 1;
					break;
				}
				if (!option.startsWith("-")) break;
				index += 1;
				if (WRAPPER_OPTIONS_WITH_VALUES.has(option) && index < tokens.length) index += 1;
			}
			continue;
		}
		return { name: token, index };
	}
	return undefined;
}

function normalizeCommandToken(token: string): string {
	const stripped = token
		.trim()
		.replace(/^[({!]+/u, "")
		.replace(/[)}]+$/u, "");
	if (!stripped) return "";
	const basename = stripped.split(/[\\/]/u).at(-1) ?? stripped;
	return basename.toLowerCase().replace(/\.exe$/u, "");
}

function containsDangerousRmRf(command: string): boolean {
	for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/gu)) {
		const nested = match[1] ?? match[2];
		if (nested && containsDangerousRmRf(nested)) return true;
	}
	return tokenizeShellCommands(command).some((tokens) => {
		const commandToken = findShellCommandToken(tokens);
		if (!commandToken) return false;
		if (SHELL_INTERPRETERS.has(commandToken.name)) {
			for (let index = commandToken.index + 1; index < tokens.length; index += 1) {
				const option = normalizeCommandToken(tokens[index]!);
				if (!/^-.*c$/u.test(option) && option !== "-command") continue;
				return containsDangerousRmRf(tokens.slice(index + 1).join(" "));
			}
			return false;
		}
		if (commandToken.name !== "rm") return false;
		let recursive = false;
		let force = false;
		for (let index = commandToken.index + 1; index < tokens.length; index += 1) {
			const token = tokens[index]!;
			if (token === "--") {
				return recursive && force && tokens.slice(index + 1).some(isCriticalRmTarget);
			}
			if (token.startsWith("-") && token !== "-") {
				const option = token.toLowerCase();
				if (option === "--recursive") recursive = true;
				else if (option === "--force") force = true;
				else if (option.startsWith("-") && !option.startsWith("--")) {
					recursive ||= option.includes("r");
					force ||= option.includes("f");
				}
				continue;
			}
			if (recursive && force && isCriticalRmTarget(token)) return true;
		}
		return false;
	});
}

function isCriticalRmTarget(target: string): boolean {
	const criticalRoots = new Set(CRITICAL_RM_RF_ROOTS.map(normalizeAbsolutePath));
	try {
		criticalRoots.add(normalizeAbsolutePath(os.homedir()));
	} catch {
		// Ignore environments without a resolvable home directory.
	}
	if (!target || target.startsWith("-")) return false;
	if (HOME_SHORTHAND_PATTERN.test(target)) {
		try {
			return criticalRoots.has(normalizeAbsolutePath(os.homedir()));
		} catch {
			return false;
		}
	}
	return target.startsWith("/") && criticalRoots.has(normalizeAbsolutePath(target));
}

function normalizeAbsolutePath(target: string): string {
	const normalized = path.posix.normalize(target);
	return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
	const serialized = Object.entries(input)
		.map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
		.join(" ");
	const compact = serialized
		.replace(/[\r\n\t]+/gu, " ")
		.replace(/ +/gu, " ")
		.trim();
	const clipped = compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
	return clipped.length > 0 ? `${toolName} ${clipped}` : toolName;
}

function isTruthy(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export interface StepAutoResumeControllerOptions {
	isEnabled: () => boolean;
	canResume: () => boolean;
	resume: (prompt: string) => void | Promise<void>;
	announce?: (message: string) => void;
	/** Product telemetry projection; receives no provider error text. */
	onTelemetry?: (event: StepAutoResumeTelemetry) => void;
	delaysMs?: readonly number[];
	setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface StepAutoResumeTelemetry {
	outcome: "resumed" | "gave_up";
	trigger: string;
	probeStatus: string;
	probeAttempts: number;
	consecutiveResumes: number;
	giveUpReason: string;
}

/**
 * Bounded, abortable continuation scheduler for Step's autopilot tier.
 * Pi's own retry loop runs first; this controller handles a final settled
 * transport/model failure and resumes with a context-aware instruction.
 */
export class StepAutoResumeController {
	private readonly options: Required<Pick<StepAutoResumeControllerOptions, "isEnabled" | "canResume" | "resume">> &
		Omit<StepAutoResumeControllerOptions, "isEnabled" | "canResume" | "resume">;
	private readonly delaysMs: readonly number[];
	private readonly setTimer: NonNullable<StepAutoResumeControllerOptions["setTimer"]>;
	private readonly clearTimer: NonNullable<StepAutoResumeControllerOptions["clearTimer"]>;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private generation = 0;
	private attempts = 0;
	private lastFailure = "";
	private resumedFailure = "";

	constructor(options: StepAutoResumeControllerOptions) {
		this.options = options;
		this.delaysMs = options.delaysMs ?? DEFAULT_AUTO_RESUME_DELAYS_MS;
		this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
		this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
	}

	handleAgentEnd(event: AgentEndEvent): void {
		const failure = describeAssistantFailure(event.messages);
		if (!failure) {
			this.reset();
			return;
		}
		this.lastFailure = failure;
	}

	handleAgentSettled(): void {
		if (!this.lastFailure || !this.options.isEnabled() || !this.options.canResume()) return;
		const maxAttempts = Math.min(this.delaysMs.length, MAX_AUTO_RESUME_ATTEMPTS);
		if (this.timer !== undefined) return;
		if (this.attempts >= maxAttempts) {
			this.reportTelemetry({
				outcome: "gave_up",
				trigger: "model_error",
				probeStatus: "not_run",
				probeAttempts: 0,
				consecutiveResumes: this.attempts,
				giveUpReason: "resume_cap",
			});
			this.options.announce?.("Autopilot stopped after reaching its retry limit");
			this.reset();
			return;
		}

		const failure = this.lastFailure;
		if (failure === this.resumedFailure && this.attempts > 0) {
			// A deterministic repeated failure is not helped by an unattended loop.
			this.reportTelemetry({
				outcome: "gave_up",
				trigger: "model_error",
				probeStatus: "not_run",
				probeAttempts: 0,
				consecutiveResumes: this.attempts,
				giveUpReason: "same_failure",
			});
			this.options.announce?.("Autopilot stopped because the same error repeated");
			this.reset();
			return;
		}

		const generation = ++this.generation;
		const delayMs = this.delaysMs[this.attempts] ?? 0;
		this.timer = this.setTimer(() => {
			this.timer = undefined;
			if (generation !== this.generation || !this.options.isEnabled() || !this.options.canResume()) return;
			this.attempts += 1;
			this.resumedFailure = failure;
			this.reportTelemetry({
				outcome: "resumed",
				trigger: "model_error",
				probeStatus: "not_run",
				probeAttempts: 0,
				consecutiveResumes: this.attempts,
				giveUpReason: "",
			});
			this.options.announce?.(`Autopilot resuming after a model error (${this.attempts}/${maxAttempts})`);
			// A session can be disposed between the timer firing and the prompt
			// dispatch. Treat a rejected resume as a normal product notification
			// instead of leaking an unhandled promise rejection into the host.
			let pending: void | Promise<void>;
			try {
				// Invoke synchronously so the continuation is observable at the same
				// timer boundary as Pi's native retry callback.
				pending = this.options.resume(AUTO_RESUME_PROMPT);
			} catch (error: unknown) {
				this.options.announce?.(
					`Autopilot could not resume: ${error instanceof Error ? error.message : String(error)}`,
				);
				return;
			}
			void Promise.resolve(pending).catch((error: unknown) => {
				this.options.announce?.(
					`Autopilot could not resume: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		}, delayMs);
		const timer = this.timer as ReturnType<typeof setTimeout> & {
			unref?: () => void;
		};
		timer.unref?.();
	}

	cancel(): void {
		this.generation += 1;
		if (this.timer !== undefined) {
			this.clearTimer(this.timer);
			this.timer = undefined;
		}
		// Cancellation invalidates the failure that caused the timer. Keeping it
		// around would let a later, unrelated `agent_settled` event schedule a
		// stale continuation after a session switch or manual abort.
		this.lastFailure = "";
		this.resumedFailure = "";
	}

	reset(): void {
		this.cancel();
		this.attempts = 0;
		this.lastFailure = "";
		this.resumedFailure = "";
	}

	private reportTelemetry(event: StepAutoResumeTelemetry): void {
		try {
			this.options.onTelemetry?.(event);
		} catch {
			// Telemetry is diagnostic-only and must never affect retry scheduling.
		}
	}
}

export const AUTO_RESUME_PROMPT =
	"The previous turn was interrupted by a transient model or transport error. Re-read the recent transcript and continue from where it stopped. Do not restart from scratch or repeat tool calls whose results are already present. If the work needs a decision from the user, stop and explain what is needed.";

function describeAssistantFailure(messages: AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const errorMessage =
			"errorMessage" in message && typeof message.errorMessage === "string" ? message.errorMessage : "";
		if (message.stopReason !== "error" || errorMessage.trim().length === 0) return undefined;
		return errorMessage.trim();
	}
	return undefined;
}

/** Publish the active preset through the existing footer status channel. */
export function publishStepPermissionStatus(ui: ExtensionUIContext, state: StepPermissionState): void {
	const preset = getStepPermissionPreset(state.preset) ?? STEP_PERMISSION_PRESETS[0]!;
	ui.setStatus("step-permission", `Mode: ${preset.label}${state.autoResume ? " (auto-resume)" : ""}`);
}
