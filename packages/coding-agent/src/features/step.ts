import process from "node:process";
import { type Api, clampThinkingLevel, type Model, modelsAreEqual } from "@step-harness/providers";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	ExtensionUIContext,
	InlineExtension,
} from "../core/extensions/types.ts";
import { BUILTIN_SLASH_COMMANDS } from "../core/slash-commands.ts";
import type { FeedbackIdentity } from "../step/feedback/types.ts";
import { STEP_INIT_PROMPT } from "../step/init-prompt.ts";
import { createStepMcpExtension } from "../step/mcp.ts";
import {
	AUTO_RESUME_PROMPT,
	FULL_ACCESS_RISK_MESSAGE,
	FULL_ACCESS_RISK_OPTIONS,
	FULL_ACCESS_RISK_TITLE,
	getStepPermissionPreset,
	normalizeStepPermissionPresetId,
	parseFullAccessRiskChoice,
	publishStepPermissionStatus,
	StepAutoResumeController,
	StepPermissionController,
	type StepPermissionControllerOptions,
	type StepPermissionState,
} from "../step/permissions.ts";
import { createStepPluginResourcesExtension } from "../step/plugins.ts";
import type { StepSettingsManager } from "../step/settings-manager.ts";
import { recordStepSlashCommand, registerStepPiCommandAdapters } from "../step/slash-commands.ts";
import { type StepTelemetryReporter, trackStepTelemetry } from "../step/telemetry.ts";
import type { TraceHeaderPolicy } from "../step/telemetry-contract.ts";
import { getThenRunCommand } from "../step/then-run.ts";
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
 * object the picker reads. Keep the session's resolved thinking preference;
 * capability discovery may only clamp a level the active model cannot support.
 */
async function enrichStepModelEffort(
	model: Model<Api> | undefined,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
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
		// Discovery may finish after a model switch or a user effort change. Only
		// validate the still-active model, using the latest session preference.
		if (!modelsAreEqual(ctx.model, model)) return;
		const selected = pi.getThinkingLevel();
		const supported = clampThinkingLevel(model, selected);
		if (supported !== selected) pi.setThinkingLevel(supported);
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
		pi.on("session_start", (_event, ctx) => {
			void enrichStepModelEffort(ctx.model, ctx, pi);
		});
		pi.on("model_select", (event, ctx) => {
			void enrichStepModelEffort(event.model, ctx, pi);
		});
		// Declarative plugins (including StepPage) contribute MCP servers. The
		// bridge is loaded as part of the Step product extension so ordinary Pi
		// sessions remain unchanged.
		createStepMcpExtension()(pi);
		// The same plugins also contribute skills and commands, which the resource
		// loader reads from agent/project directories rather than the plugin root.
		createStepPluginResourcesExtension()(pi);
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
		 * Session-scoped Full Access grant. The persisted "don't ask again" choice
		 * lives in Step settings and is consulted alongside this flag; the flag is
		 * cleared on session shutdown so a "this session" grant does not leak into
		 * a replacement session.
		 */
		let fullAccessAcknowledged = false;
		/**
		 * Incremented on every session_start. An async risk-dialog grant only
		 * applies while its generation is current, so a prompt answered after a
		 * trust re-probe or /new replaced the session cannot flip the new
		 * session's policy through a stale callback.
		 */
		let permissionSessionGeneration = 0;

		const isFullAccessAcknowledged = (): boolean =>
			fullAccessAcknowledged || options.stepSettings?.()?.getStepSettings().fullAccessAcknowledged === true;

		const isFullAccessState = (state: StepPermissionState): boolean => state.skipCommandPolicy === true;

		/**
		 * Ask the user to accept the Full Access risk. Resolves true for both
		 * grant options ("always" persists the acknowledgment) and false when the
		 * dialog is dismissed, so callers keep the previous tier.
		 */
		const confirmFullAccessRisk = async (ui: ExtensionUIContext): Promise<boolean> => {
			const generation = permissionSessionGeneration;
			if (typeof ui.select !== "function") return false;
			const selected = await ui.select(`${FULL_ACCESS_RISK_TITLE}\n\n${FULL_ACCESS_RISK_MESSAGE}`, [
				...FULL_ACCESS_RISK_OPTIONS,
			]);
			if (generation !== permissionSessionGeneration) return false;
			const choice = parseFullAccessRiskChoice(selected);
			if (choice === "cancel") return false;
			fullAccessAcknowledged = true;
			if (choice === "always") {
				try {
					options.stepSettings?.()?.setEffectiveStepSettings({
						permissionPreset: "full-access",
						approvalMode: "auto",
						nonInteractiveApproval: "allow",
						autoResume: true,
						fullAccessAcknowledged: true,
					});
				} catch {
					// Persisting the acknowledgment must not block the current grant.
				}
			}
			return true;
		};

		/** Apply a resolved policy state: retry switch, footer, telemetry, persistence. */
		const applyPermissionState = (
			ctx: ExtensionContext,
			state: StepPermissionState,
			apply: { source: "startup" | "shortcut" | "command"; persist: boolean },
		): void => {
			syncNativeRetry(ctx, state.autoResume);
			publishStepPermissionStatus(ctx.ui, state);
			trackPermissionMode(options.telemetry, state.preset, apply.source === "startup" ? "command" : apply.source);
			if (apply.persist) persistPermissionState(options.stepSettings, state);
			ctx.ui.notify(`Permission mode: ${getStepPermissionPreset(state.preset)?.label ?? state.preset}`, "info");
		};

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
			const generation = ++permissionSessionGeneration;
			fullAccessAcknowledged = false;
			notify = ctx.ui.notify;
			// During project-trust probing Pi loads inline extensions while the
			// project scope is hidden. Rehydrate once the final trust decision has
			// been applied so project-level Step policy is not silently ignored.
			const persistedOptions = resolvePermissionOptions(options);
			if (persistedOptions) permissions = new StepPermissionController(persistedOptions);
			let state = permissions.getState();
			// A replacement session gets its own context. The previous session's
			// shutdown handler restores any temporary auto-resume override before this
			// callback runs, so this snapshot is the user's real native preference.
			syncNativeRetry(ctx, state.autoResume, true);
			// A persisted or env-selected Full Access tier still owes the risk
			// acknowledgment. Prompt once; without a grant the session falls back to
			// Approve for Me instead of silently executing dangerous commands.
			if (isFullAccessState(state) && !isFullAccessAcknowledged()) {
				const requestedPermissions = permissions;
				if (ctx.hasUI) {
					void confirmFullAccessRisk(ctx.ui)
						.then((granted) => {
							// A newer session_start (trust re-probe, /new, reload) owns the
							// policy now; its own dialog decides the outcome.
							if (!granted || generation !== permissionSessionGeneration) return;
							permissions = requestedPermissions;
							applyPermissionState(ctx, permissions.getState(), { source: "startup", persist: false });
						})
						.catch(() => {
							// A UI torn down mid-dialog must not surface as an unhandled
							// rejection; the session stays on Approve for Me.
						});
				} else {
					notify?.(
						"Full access needs its risk acknowledgment, which requires an interactive session; using Approve for Me.",
						"warning",
					);
				}
				// Startup fallback changes only the tier, preserving explicit overrides
				// such as unattended denial and the requested auto-resume preference.
				permissions = new StepPermissionController({ ...persistedOptions, initialPreset: "approve-for-me" });
				state = permissions.getState();
			}
			publishStepPermissionStatus(ctx.ui, state);
		});

		pi.on("session_shutdown", (_event, ctx) => {
			permissionSessionGeneration++;
			// Timers and UI callbacks are scoped to the old session. Cancel them before
			// Pi tears down its extension runner, and restore the native retry setting
			// if Step temporarily enabled it for auto-resume.
			autoResumeAllowed = false;
			autoResume.reset();
			// A "this session" Full Access grant must not carry into the next
			// session; only the persisted acknowledgment does.
			fullAccessAcknowledged = false;
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
			if (
				getThenRunCommand(event.toolName, event.input) !== undefined &&
				!pi.getActiveTools().includes("run_command")
			) {
				return {
					block: true,
					reason: "then_run requires run_command, which is not available in this session; retry without then_run",
				};
			}
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
			const generation = permissionSessionGeneration;
			const requested = args.trim().toLowerCase();
			if (requested === "--cycle" || requested === "cycle") {
				// Full Access is gated by the risk acknowledgment; a canceled dialog
				// keeps the current tier instead of moving.
				const nextPreset = permissions.nextPresetId();
				if (nextPreset === "full-access" && !isFullAccessAcknowledged()) {
					const granted = await confirmFullAccessRisk(ctx.ui);
					if (generation !== permissionSessionGeneration) return;
					if (!granted) {
						ctx.ui.notify("Full access was not enabled.", "warning");
						return;
					}
				}
				const state = permissions.cycle();
				// Deliberately not persisted. The shortcut means "stop asking me right
				// now, I am watching", but persisting it wrote the whole policy triple
				// — including `nonInteractiveApproval: "allow"` — to config.toml, so
				// one keypress silently granted every later unattended `--print` run in
				// that project permission to write and execute. Use
				// `/permissions <preset>` for a durable choice.
				autoResume.reset();
				applyPermissionState(ctx, state, { source: "shortcut", persist: false });
				return;
			}

			let selected = requested;
			if (!selected) {
				const options = permissionsPresetsForSelector();
				selected = (await ctx.ui.select("Permission mode", options))?.trim().toLowerCase() ?? "";
				if (!selected || generation !== permissionSessionGeneration) return;
			}
			if (normalizeStepPermissionPresetId(selected) === "full-access" && !isFullAccessAcknowledged()) {
				const granted = await confirmFullAccessRisk(ctx.ui);
				if (generation !== permissionSessionGeneration) return;
				if (!granted) {
					ctx.ui.notify("Full access was not enabled.", "warning");
					return;
				}
			}
			const state = permissions.setPreset(selected);
			if (!state) {
				ctx.ui.notify("Unknown permission mode. Use ask, approve-for-me, or full-access.", "warning");
				return;
			}
			autoResume.reset();
			applyPermissionState(ctx, state, {
				source: "command",
				persist:
					state.preset !== "full-access" ||
					options.stepSettings?.()?.getStepSettings().fullAccessAcknowledged === true,
			});
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
		!hasEnvPreset &&
		!hasEnvMode &&
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
	return ["ask", "approve-for-me", "full-access"];
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
