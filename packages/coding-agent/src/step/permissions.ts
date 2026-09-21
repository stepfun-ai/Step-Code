/**
 * Step's permission presets layered on top of pi's native tool-call hook.
 *
 * The agent loop and tool executor remain pi-owned. This module only decides
 * whether a prepared call is allowed, needs a UI confirmation, or is blocked,
 * and schedules the optional autopilot continuation after a failed run.
 */

import type { AgentMessage } from "@step-harness/agent-core";
import type {
	AgentEndEvent,
	ExtensionContext,
	ExtensionUIContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "../core/extensions/types.ts";
import { getShellConfig } from "../utils/shell.ts";

import { analyzeCommandPolicy, type CommandPolicyAnalysis } from "./command-policy.ts";

export { containsDangerousLifecycleCommand, isDangerousCommand } from "./command-policy.ts";

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
		description: "Run ordinary tools without approval; dangerous commands still ask",
		mode: "auto",
		nonInteractiveApproval: "allow",
		autoResume: false,
	},
	{
		id: "autopilot",
		label: "Autopilot",
		description: "Bypass ordinary approvals and resume transient model failures",
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

/** Backoff shared with the previous Step gateway host (5s, 15s, 45s, 2m, 5m). */
const DEFAULT_AUTO_RESUME_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000] as const;
/** Unattended continuations are deliberately capped even when the ladder is extended. */
export const MAX_AUTO_RESUME_ATTEMPTS = 3;

export interface StepPermissionState {
	preset: StepPermissionPresetId;
	mode: StepPermissionMode;
	nonInteractiveApproval: StepNonInteractiveApproval;
	autoResume: boolean;
	/**
	 * True when nothing selected this policy: no CLI flag, no `STEP_*` env var,
	 * no persisted or trusted-project preset. Only the interactive default is
	 * permissive, so a run without a UI must not inherit it.
	 */
	defaulted?: boolean;
	/** Per-tool policy overrides supplied by the StepCode or an embedding host. */
	toolOverrides?: Readonly<Record<string, StepToolPermissionMode>>;
}

export interface StepToolDecision {
	action: "allow" | "confirm" | "deny";
	hazardous: boolean;
	/** Analysis uncertainty requires a human decision without claiming a dangerous rule matched. */
	analysisIncomplete?: true;
	reason: string;
}

export interface StepPermissionControllerOptions {
	/** Shell settings used by the command tool; resolved at the same product boundary. */
	shellContext?: () => ShellExecutionContext;
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

interface ShellExecutionContext {
	shellPath?: string;
	commandPrefix?: string;
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
	return resolveStepPermissionPresetWithProvenance(options).preset;
}

interface ResolvedStepPermissionPreset {
	preset: StepPermissionPresetId;
	/** True only for the final fallback, where nothing selected a policy. */
	defaulted: boolean;
}

function resolveStepPermissionPresetWithProvenance(
	options: StepPermissionControllerOptions = {},
): ResolvedStepPermissionPreset {
	if (options.initialPreset && getStepPermissionPreset(options.initialPreset)) {
		return { preset: options.initialPreset, defaulted: false };
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
		if (explicitMode === "auto") {
			return {
				preset: autoResume && nonInteractive !== "deny" ? "autopilot" : "bypass",
				defaulted: false,
			};
		}
		return {
			preset: explicitMode === "strict" ? "read-only" : "ask",
			defaulted: false,
		};
	}
	const explicitPreset = env.STEP_PERMISSION_PRESET?.trim().toLowerCase();
	const normalizedExplicitPreset = normalizeStepPermissionPresetId(explicitPreset);
	if (normalizedExplicitPreset) return { preset: normalizedExplicitPreset, defaulted: false };

	const mode = env.STEP_PERMISSION_MODE?.trim().toLowerCase();
	if (mode === "strict" || mode === "read-only" || mode === "readonly") {
		return { preset: "read-only", defaulted: false };
	}
	if (mode === "auto" || mode === "bypass" || mode === "bypasspermissions") {
		return {
			preset: isTruthy(env.STEP_AUTOPILOT) ? "autopilot" : "bypass",
			defaulted: false,
		};
	}
	if (mode === "confirm" || mode === "ask") return { preset: "ask", defaulted: false };
	if (isTruthy(env.STEP_AUTOPILOT)) return { preset: "autopilot", defaulted: false };
	// Default to bypass: tools run without approval prompts. Explicit CLI flags,
	// STEP_* env vars, and any persisted preset are all resolved above this line,
	// so they continue to override the default. Dangerous commands (see
	// decideStepToolCall / isDangerousCommand) still require confirmation even
	// under bypass, and a run with no UI refuses the defaulted policy outright
	// (see StepPermissionController.handleToolCall).
	return { preset: "bypass", defaulted: true };
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
	const presetResolution = resolveStepPermissionPresetWithProvenance(options);
	const preset = stepPermissionStateForPreset(presetResolution.preset);
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
	// Only a grant counts as configuring the policy. An explicit `deny` asks for
	// less access, so it must not move the policy out of the defaulted bucket and
	// re-enable the permissive default.
	if (presetResolution.defaulted && mode === undefined && rawNonInteractive !== "allow") {
		resolved.defaulted = true;
	}
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
	shellContext?: ShellExecutionContext,
): StepToolDecision {
	const normalizedName = toolName.trim().toLowerCase();
	const command = extractCommand(input);
	let analysis: CommandPolicyAnalysis | undefined;
	if (command !== undefined) {
		try {
			const shell = normalizedName === "powershell" ? "powershell" : getShellConfig(shellContext?.shellPath).shell;
			const name = shell.split(/[\\/]/u).at(-1)?.toLowerCase();
			const prefix =
				normalizedName === "powershell" || (normalizedName === "run_command" && input.run_in_background === true)
					? undefined
					: shellContext?.commandPrefix;
			const script = prefix ? `${prefix}\n${command}` : command;
			analysis = analyzeCommandPolicy(script, name === "bash" || name === "bash.exe" ? "bash" : "unsupported");
		} catch {
			analysis = { kind: "unresolved", reason: "shell-configuration" };
		}
	}
	const commandRule = analysis?.kind === "matched" ? analysis.ruleId : undefined;
	const override = findToolOverride(normalizedName, overrides);

	if (override === "deny") {
		return {
			action: "deny",
			hazardous: commandRule !== undefined,
			reason: `Policy override for ${toolName}: deny`,
		};
	}

	if (commandRule) {
		return {
			action: state.mode === "strict" ? "deny" : "confirm",
			hazardous: true,
			reason: `Dangerous command requires confirmation (${commandRule}): ${summarizeToolInput(toolName, input)}`,
		};
	}

	if (analysis?.kind === "unresolved") {
		return {
			action: state.mode === "strict" ? "deny" : "confirm",
			hazardous: false,
			analysisIncomplete: true,
			reason: `Shell command could not be fully analyzed (${analysis.reason}); explicit approval is required.`,
		};
	}

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

/** Why a tool call cannot fall back to unattended approval. */
interface UnattendedCause {
	/** The policy explicitly refuses unattended approvals. */
	refused: boolean;
	/** Nothing selected a policy, so only the permissive default applies. */
	unconfigured: boolean;
}

/** Mutable policy state used by the Step extension instance for one session. */
export class StepPermissionController {
	private state: StepPermissionState;
	private toolOverrides: Record<string, StepToolPermissionMode>;
	private readonly shellContext: () => ShellExecutionContext;

	constructor(options: StepPermissionControllerOptions = {}) {
		this.shellContext = options.shellContext ?? (() => ({}));
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

	/**
	 * Decide a call the way `handleToolCall` will decide it.
	 *
	 * `hasUI` has to be supplied by the caller, because the effective policy
	 * differs without a terminal (see unattendedCause). A caller that omits it
	 * asks for the interactive policy.
	 */
	decide(toolName: string, input: Record<string, unknown>, hasUI = true): StepToolDecision {
		const cause = this.unattendedCause(hasUI);
		return decideStepToolCall(toolName, input, this.effectiveState(cause), this.toolOverrides, this.shellContext());
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

	/**
	 * Why a call may not run unattended. Two cases qualify:
	 *
	 *   - nothing selected the policy at all, so the call would inherit the
	 *     interactive Bypass default with nobody watching;
	 *   - the caller explicitly refused unattended approvals.
	 *
	 * Feedback issue-287bfff1a5fe7668.
	 */
	private unattendedCause(hasUI: boolean): UnattendedCause {
		if (hasUI) return { refused: false, unconfigured: false };
		return {
			refused: this.state.nonInteractiveApproval === "deny",
			unconfigured: this.state.defaulted === true,
		};
	}

	/**
	 * The policy one call is actually decided under.
	 *
	 * An unattended cause needs the mode downgraded rather than just the no-UI
	 * fallback consulted, because `auto` decides every call as `allow` and
	 * returns before the fallback is reached. Without this,
	 * `--non-interactive-approval deny` silently does nothing. Only `auto` needs
	 * it: `confirm` and `strict` already route through the fallback with their
	 * own reasons, and demoting `strict` would weaken read-only mode.
	 */
	private effectiveState(cause: UnattendedCause): StepPermissionState {
		if (this.state.mode !== "auto" || !(cause.refused || cause.unconfigured)) return this.state;
		return { ...this.state, mode: "confirm", nonInteractiveApproval: "deny" };
	}

	/** Apply the policy through Pi's before-tool-call result contract. */
	async handleToolCall(event: ToolCallEvent, context: ExtensionContext): Promise<ToolCallEventResult | undefined> {
		const input = event.input;
		const cause = this.unattendedCause(context.hasUI);
		const state = this.effectiveState(cause);
		const decision = decideStepToolCall(event.toolName, input, state, this.toolOverrides, this.shellContext());
		if (decision.action === "allow") return undefined;

		if (decision.action === "deny") {
			return { block: true, terminate: true, reason: decision.reason };
		}

		if (!context.hasUI) {
			// Match the old Step policy: an explicit non-interactive `allow` can
			// approve an ordinary confirmation once, while hazardous commands always
			// fail closed. The default remains deny.
			if (!decision.hazardous && !decision.analysisIncomplete && state.nonInteractiveApproval === "allow")
				return undefined;
			return {
				block: true,
				terminate: true,
				reason: formatUnattendedBlockReason(decision, cause),
			};
		}

		const approved = await context.ui.confirm(
			`${decision.hazardous ? "Dangerous" : "Approve"} ${event.toolName} [${event.toolCallId.slice(-8)}]`,
			`Call: ${event.toolCallId}\n${decision.reason}\n\n${summarizeToolInput(event.toolName, input)}\n\nBatch calls may ask separately\nbefore approved tools begin running.`,
			{ signal: context.signal, overlay: true },
		);
		if (approved) return undefined;
		return { block: true, reason: `Tool call denied: ${event.toolName}` };
	}
}

/**
 * Explain a block that happened without a UI, and say how to permit it.
 *
 * The three cases need different advice. A hazardous command is never permitted
 * unattended, so pointing at `--approval-mode auto` there would be wrong: it
 * still confirms. Otherwise the caller either configured no policy at all or
 * configured one that refuses unattended approvals, and each has its own
 * shortest way out.
 */
function formatUnattendedBlockReason(decision: StepToolDecision, cause: UnattendedCause): string {
	if (decision.analysisIncomplete) {
		return (
			decision.reason +
			" No interactive approval is available. Use a supported literal command or review it in an interactive session."
		);
	}
	if (decision.hazardous) {
		return (
			`${decision.reason} (no interactive approval is available). Dangerous commands always require ` +
			"interactive confirmation; no flag or preset overrides that. Run it in an interactive session."
		);
	}
	// A policy that refuses unattended approvals is a deliberate setting, so say
	// that rather than "nothing is configured" — the caller already knows what
	// they chose and needs the way back, not a description of an empty config.
	if (cause.refused) {
		return (
			`${decision.reason} (no interactive approval is available, and this run's policy denies unattended ` +
			`approvals). Permit them with --non-interactive-approval allow or --approval-mode auto.`
		);
	}
	if (cause.unconfigured) {
		return (
			`${decision.reason} (no interactive approval is available and no permission preset is configured). ` +
			`Permit unattended writes with --non-interactive-approval allow or --approval-mode auto.`
		);
	}
	return `${decision.reason} (no interactive approval is available).`;
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
		if (typeof value === "string") return value;
	}
	return undefined;
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
