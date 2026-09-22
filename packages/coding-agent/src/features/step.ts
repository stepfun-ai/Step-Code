import process from "node:process";
import { type Api, getSupportedThinkingLevels, type Model } from "@step-harness/providers";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
} from "../core/extensions/types.ts";
import { BUILTIN_SLASH_COMMANDS } from "../core/slash-commands.ts";
import type { FeedbackIdentity } from "../step/feedback/types.ts";
import { STEP_INIT_PROMPT } from "../step/init-prompt.ts";
import { createStepMcpExtension } from "../step/mcp.ts";
import {
	AUTO_RESUME_PROMPT,
	getStepPermissionPreset,
	publishStepPermissionStatus,
	StepAutoResumeController,
	StepPermissionController,
	type StepPermissionControllerOptions,
} from "../step/permissions.ts";
import type { StepSettingsManager } from "../step/settings-manager.ts";
import { recordStepSlashCommand, registerStepPiCommandAdapters } from "../step/slash-commands.ts";
import { type StepTelemetryReporter, trackStepTelemetry } from "../step/telemetry.ts";
import type { TraceHeaderPolicy } from "../step/telemetry-contract.ts";
import { applyStepTraceHeaders } from "../step/trace-headers.ts";
import {
	fetchStepModelEfforts,
	registerStepProvider,
	STEP_PROVIDER_ID,
	stepModelsDetailBaseUrl,
	stepThinkingLevelMap,
} from "./step-provider/index.ts";
import { registerStepStreamRecovery } from "./step-stream-recovery.ts";

export interface StepExtensionOptions {
	/** Initial Step policy, normally populated from CLI/runtime options. */
	permission?: StepPermissionControllerOptions;
	/** Optional Step settings decorator used to restore and persist policy. */
	stepSettings?: () =>
		| (Pick<StepSettingsManager, "getStepSettings" | "setEffectiveStepSettings"> &
				Partial<Pick<StepSettingsManager, "getShellPath" | "getShellCommandPrefix">>)
		| undefined;
	/** Optional process/host reporter for Step lifecycle projections. */
	telemetry?: StepTelemetryReporter;
	/** Current account identity, resolved when `/feedback` is invoked. */
	feedbackIdentity?: () => FeedbackIdentity;
	traceHeaderPolicy?: TraceHeaderPolicy;
}

/**
 * Ensure an active Step model carries its supported reasoning-effort levels, so
 * the `/effort` picker only offers what the endpoint reports. The list endpoint
 * carries `reasoning_effort_support_list` on some profiles (e.g. step_plan); when
 * it does not (e.g. platform), fetch the per-model detail from the domain-root
 * `/v1`. Mutates the model in place — the session's active model is the same
 * object the picker reads. When `applyDefault` is set (fresh activation, not a
 * restore), also default the level to the highest supported effort.
 */
async function enrichStepModelEffort(
	model: Model<Api> | undefined,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	applyDefault: boolean,
): Promise<void> {
	try {
		if (!model || model.provider !== STEP_PROVIDER_ID) return;
		if (!model.thinkingLevelMap) {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (auth.ok && auth.apiKey) {
				const efforts = await fetchStepModelEfforts({
					baseUrl: stepModelsDetailBaseUrl(auth.baseUrl ?? model.baseUrl),
					modelId: model.id,
					apiKey: auth.apiKey,
					signal: AbortSignal.timeout(10_000),
				});
				if (efforts) {
					model.thinkingLevelMap = stepThinkingLevelMap(efforts);
					model.reasoning = true;
				}
			}
		}
		if (applyDefault) {
			const supported = getSupportedThinkingLevels(model).filter((level) => level !== "off");
			const highest = supported[supported.length - 1];
			if (highest) pi.setThinkingLevel(highest);
		}
	} catch {
		// Best-effort; the model keeps its existing thinking-level defaults.
	}
}

/** Product extension layered on pi's native coding-agent runtime. */
export function createStepExtension(options: StepExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		registerStepProvider(pi);
		registerStepStreamRecovery(pi);
		// Populate a Step model's supported reasoning-effort levels (the `/effort`
		// picker) from `{base}/v1/models/{id}` the first time it becomes active.
		// Fire-and-forget; failures leave the model's defaults untouched.
		// (The initial model catalog is refreshed by the launcher before the
		// session's model is resolved, so it is already available here.)
		pi.on("session_start", (event, ctx) => {
			const fresh = event.reason === "startup" || event.reason === "new";
			void enrichStepModelEffort(ctx.model, ctx, pi, fresh);
		});
		pi.on("model_select", (event, ctx) => {
			void enrichStepModelEffort(event.model, ctx, pi, event.source !== "restore");
		});
		// Declarative plugins (including StepPage) contribute MCP servers. The
		// bridge is loaded as part of the Step product extension so ordinary Pi
		// sessions remain unchanged.
		createStepMcpExtension()(pi);
		registerStepPiCommandAdapters(pi, options.telemetry, options.stepSettings, options.feedbackIdentity);
		const builtInSlashCommands = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		// Extension commands are wrapped at registration time below. Inputs that
		// reach Pi's normal prompt path are the remaining (usually unknown) slash
		// commands; record their name without arguments or message content.
		pi.on("input", (event) => {
			const token = event.text.trim().split(/\s+/u)[0] ?? "";
			if (!token.startsWith("/")) return;
			const name = token.slice(1).split(":", 1)[0] ?? "";
			recordStepSlashCommand(options.telemetry, token, builtInSlashCommands.has(name));
		});
		let permissions = new StepPermissionController(resolvePermissionOptions(options));
		let notify: ((message: string, type?: "info" | "warning" | "error") => void) | undefined;
		let autoResumeAllowed = false;
		let nativeRetryPreference: boolean | undefined;
		let nativeRetryOverridden = false;

		/**
		 * Let Pi own provider retries. Step's Autopilot only changes the native
		 * switch and keeps a bounded post-failure continuation for the final error.
		 * The preference is restored when the user leaves Autopilot so a temporary
		 * product mode change does not silently alter the user's Pi setting.
		 */
		const syncNativeRetry = (
			ctx: {
				autoRetryEnabled?: boolean;
				setAutoRetryEnabled?: (enabled: boolean) => void;
			},
			autoResume: boolean,
			resetPreference = false,
		): void => {
			if (ctx.autoRetryEnabled === undefined || !ctx.setAutoRetryEnabled) return;
			if (resetPreference || nativeRetryPreference === undefined) {
				nativeRetryPreference = ctx.autoRetryEnabled;
				nativeRetryOverridden = false;
			}
			if (autoResume) {
				if (!nativeRetryOverridden && ctx.autoRetryEnabled !== true) {
					nativeRetryOverridden = true;
				}
				try {
					ctx.setAutoRetryEnabled(true);
				} catch {
					// Retry is a product convenience. A host that cannot persist settings
					// must still be able to execute the current turn.
				}
			} else if (nativeRetryOverridden) {
				try {
					ctx.setAutoRetryEnabled(nativeRetryPreference);
				} catch {
					// Keep shutdown/mode switching best-effort when settings persistence is
					// unavailable (for example in a read-only embedded host).
				}
				nativeRetryOverridden = false;
			}
		};
		const autoResume = new StepAutoResumeController({
			isEnabled: () => permissions.getState().autoResume,
			canResume: () => autoResumeAllowed,
			resume: async (prompt) => {
				autoResumeAllowed = false;
				try {
					await pi.sendUserMessage(prompt);
				} catch (error: unknown) {
					try {
						notify?.(
							`Autopilot could not resume: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
					} catch {
						// The UI may have been torn down while the retry was dispatched.
					}
				}
			},
			announce: (message) => {
				try {
					notify?.(message, "warning");
				} catch {
					// A session can be replaced while a retry timer is pending. A stale
					// UI callback must not make the retry path fail.
				}
			},
			onTelemetry: (event) => {
				if (!options.telemetry) return;
				trackStepTelemetry(options.telemetry, "autopilot_resume", {
					outcome: event.outcome,
					trigger: event.trigger,
					probe_status: event.probeStatus,
					probe_attempts: event.probeAttempts,
					consecutive_resumes: event.consecutiveResumes,
					give_up_reason: event.giveUpReason,
				});
			},
		});

		pi.on("session_start", (_event, ctx) => {
			notify = ctx.ui.notify;
			// During project-trust probing Pi loads inline extensions while the
			// project scope is hidden. Rehydrate once the final trust decision has
			// been applied so project-level Step policy is not silently ignored.
			const persistedOptions = resolvePermissionOptions(options);
			if (persistedOptions) permissions = new StepPermissionController(persistedOptions);
			const state = permissions.getState();
			// A replacement session gets its own context. The previous session's
			// shutdown handler restores any temporary Autopilot override before this
			// callback runs, so this snapshot is the user's real native preference.
			syncNativeRetry(ctx, state.autoResume, true);
			publishStepPermissionStatus(ctx.ui, state);
		});

		pi.on("session_shutdown", (_event, ctx) => {
			// Timers and UI callbacks are scoped to the old session. Cancel them before
			// Pi tears down its extension runner, and restore the native retry setting
			// if Step temporarily enabled it for Autopilot.
			autoResumeAllowed = false;
			autoResume.reset();
			if (nativeRetryOverridden && nativeRetryPreference !== undefined && ctx.setAutoRetryEnabled) {
				try {
					ctx.setAutoRetryEnabled(nativeRetryPreference);
				} catch {
					// Do not turn a best-effort product setting into a shutdown failure.
				}
			}
			nativeRetryPreference = undefined;
			nativeRetryOverridden = false;
			notify = undefined;
		});

		pi.on("tool_call", async (event, ctx) => {
			return await permissions.handleToolCall(event, ctx);
		});

		pi.on("before_agent_start", (event) => {
			if (event.prompt !== AUTO_RESUME_PROMPT) {
				autoResumeAllowed = false;
				autoResume.reset();
			}
		});

		pi.on("agent_end", (event) => {
			autoResume.handleAgentEnd(event);
		});
		pi.on("agent_settled", (_event, ctx) => {
			autoResumeAllowed = ctx.isIdle() && !ctx.hasPendingMessages();
			autoResume.handleAgentSettled();
		});

		// Keep Step request attribution at the provider boundary. Pi assembles the
		// final headers after the session/model are known, so this remains dynamic
		// across session replacement while the agent loop stays untouched.
		pi.on("before_provider_headers", (event, ctx) => {
			const model = ctx.model;
			if (!model) return;
			// x-step-client marks every request. The session/workspace/provider
			// attribution follows only Step-owned providers (native step + product
			// proxies), keyed by provider id, so it never egresses to a distinct
			// third-party provider. Caveat: overriding STEP_BASE_URL under the
			// "step" id points that provider at another host and attribution follows.
			applyStepTraceHeaders(
				event.headers,
				{
					sessionId: ctx.sessionManager.getSessionId(),
					goalId: process.env.STEP_GOAL_ID,
					attemptId: process.env.STEP_ATTEMPT_ID,
					harnessId: process.env.STEPCODE_ID,
					spanId: process.env.STEP_SPAN_ID,
					workspaceId: process.env.STEP_WORKSPACE_ID ?? ctx.cwd,
					provider: model.provider,
					model: model.id,
				},
				{
					clientType: process.env.STEP_CLIENT,
					requestUrl: model.baseUrl,
					allowedBaseUrls: options.traceHeaderPolicy?.allowedBaseUrls ?? [],
					highSensitivityFields: options.traceHeaderPolicy?.highSensitivityFields,
				},
			);
		});

		pi.registerCommand("init", {
			description: "Create an AGENTS.md project instruction file",
			handler: async (_args, ctx) => {
				recordStepSlashCommand(options.telemetry, "/init", true);
				if (!ctx.isIdle()) {
					ctx.ui.notify("Wait for the current work to finish before initializing AGENTS.md", "warning");
					return;
				}
				// Route initialization through pi's normal user-message path. The model
				// inspects the repository, and pi's native write/approval flow owns the
				// actual file mutation and any existing-file decision.
				await pi.sendUserMessage(STEP_INIT_PROMPT);
			},
		});

		const handlePermissionCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const requested = args.trim().toLowerCase();
			if (requested === "--cycle" || requested === "cycle") {
				const state = permissions.cycle();
				trackPermissionMode(options.telemetry, state.preset, "shortcut");
				// Deliberately not persisted. The shortcut means "stop asking me right
				// now, I am watching", but persisting it wrote the whole policy triple
				// — including `nonInteractiveApproval: "allow"` under Bypass — to
				// config.toml, so one keypress silently granted every later unattended
				// `--print` run in that project permission to write and execute. Use
				// `/permissions <preset>` for a durable choice.
				autoResume.reset();
				syncNativeRetry(ctx, state.autoResume);
				publishStepPermissionStatus(ctx.ui, state);
				ctx.ui.notify(`Permission mode: ${getStepPermissionPreset(state.preset)?.label ?? state.preset}`, "info");
				return;
			}

			let selected = requested;
			if (!selected) {
				const options = permissionsPresetsForSelector();
				selected = (await ctx.ui.select("Permission mode", options))?.trim().toLowerCase() ?? "";
			}
			const state = permissions.setPreset(selected);
			if (!state) {
				ctx.ui.notify("Unknown permission mode. Use ask, read-only, bypass, or autopilot.", "warning");
				return;
			}
			autoResume.reset();
			trackPermissionMode(options.telemetry, state.preset, "command");
			persistPermissionState(options.stepSettings, state);
			syncNativeRetry(ctx, state.autoResume);
			publishStepPermissionStatus(ctx.ui, state);
			ctx.ui.notify(`Permission mode: ${getStepPermissionPreset(state.preset)?.label ?? state.preset}`, "info");
		};

		// Keep only the plural product command. The old singular alias was never a
		// separate approval engine and is intentionally no longer exposed.
		pi.registerCommand("permissions", {
			description: "Choose Step tool approval mode",
			handler: async (args, ctx) => {
				recordStepSlashCommand(options.telemetry, "/permissions", true);
				await handlePermissionCommand(args, ctx);
			},
		});
	};
}

/**
 * Resolve persisted policy below explicit CLI/environment values. Passing a
 * persisted preset as `initialPreset` would otherwise outrank env aliases in
 * Pi's resolver, so only inject it when no policy override is present.
 */
function resolvePermissionOptions(options: StepExtensionOptions): StepPermissionControllerOptions | undefined {
	const explicit: StepPermissionControllerOptions = {
		...options.permission,
		shellContext:
			options.permission?.shellContext ??
			(() => {
				const settings = options.stepSettings?.();
				return {
					shellPath: settings?.getShellPath?.(),
					commandPrefix: settings?.getShellCommandPrefix?.(),
				};
			}),
	};
	const persisted = options.stepSettings?.()?.getStepSettings();
	if (!persisted) return explicit;
	const env = explicit?.env ?? process.env;
	const hasEnvPreset = Boolean(env.STEP_PERMISSION_PRESET?.trim());
	const hasEnvMode = Boolean(env.STEP_APPROVAL_MODE?.trim() || env.STEP_PERMISSION_MODE?.trim());
	const hasEnvNonInteractive = Boolean(
		env.STEP_NON_INTERACTIVE_APPROVAL?.trim() || env.STEP_NONINTERACTIVE_APPROVAL?.trim(),
	);
	const hasEnvAutoResume = Boolean(env.STEP_AUTOPILOT?.trim() || env.STEP_AUTO_RESUME?.trim());
	return {
		...explicit,
		...(explicit?.initialPreset === undefined &&
		explicit?.approvalMode === undefined &&
		explicit?.autoResume === undefined &&
		!hasEnvPreset &&
		!hasEnvMode &&
		!hasEnvAutoResume &&
		persisted.permissionPreset
			? { initialPreset: persisted.permissionPreset }
			: {}),
		...(explicit?.approvalMode === undefined && !hasEnvMode && !hasEnvPreset && persisted.approvalMode
			? { approvalMode: persisted.approvalMode }
			: {}),
		...(explicit?.nonInteractiveApproval === undefined &&
		!hasEnvNonInteractive &&
		!hasEnvPreset &&
		persisted.nonInteractiveApproval
			? { nonInteractiveApproval: persisted.nonInteractiveApproval }
			: {}),
		...(explicit?.autoResume === undefined && !hasEnvAutoResume && !hasEnvPreset && persisted.autoResume !== undefined
			? { autoResume: persisted.autoResume }
			: {}),
	};
}

function persistPermissionState(
	getSettings: StepExtensionOptions["stepSettings"],
	state: ReturnType<StepPermissionController["getState"]>,
): void {
	try {
		getSettings?.()?.setEffectiveStepSettings({
			permissionPreset: state.preset,
			approvalMode: state.mode,
			nonInteractiveApproval: state.nonInteractiveApproval,
			autoResume: state.autoResume,
		});
	} catch {
		// Persisting a preference must not prevent the current mode change.
	}
}

/** Default extension factory used by embedders that do not provide CLI policy. */
export const stepExtension: ExtensionFactory = createStepExtension();

function permissionsPresetsForSelector(): string[] {
	return ["ask", "read-only", "bypass", "autopilot"];
}

function trackPermissionMode(
	reporter: StepTelemetryReporter | undefined,
	mode: string,
	source: "shortcut" | "command",
): void {
	if (!reporter) return;
	trackStepTelemetry(reporter, "permission_mode_toggled", { mode, source });
}

/** Inline descriptor used by the `step` launcher. Product wiring is hidden from
 * pi's startup resource list while its commands/providers remain registered. */
export const stepExtensionInline: InlineExtension = {
	name: "Step",
	factory: stepExtension,
	hidden: true,
};

/** Create a hidden inline extension with a caller-provided initial policy. */
export function createStepExtensionInline(options: StepExtensionOptions = {}): InlineExtension {
	return {
		name: "Step",
		factory: createStepExtension(options),
		hidden: true,
	};
}
