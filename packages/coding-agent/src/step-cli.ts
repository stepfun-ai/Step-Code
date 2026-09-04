#!/usr/bin/env node

import "./step-bootstrap.ts";

import { parseArgs } from "./cli/args.ts";
import { readStoredCredential } from "./core/auth-storage.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { createStepExtensionInline } from "./extensions/step.ts";
import { createStepCapabilitiesExtensionInline } from "./extensions/step-capabilities.ts";
import { createStepCronExtension } from "./extensions/step-cron.ts";
import { createStepProviderConfig, STEP_PROVIDER_ID } from "./extensions/step-provider/index.ts";
import { type MainOptions, main } from "./main.ts";
import {
	getLegacyStepAuthPath,
	getStepAuthPath,
	logoutStepCredentials,
	migrateLegacyStepCredential,
} from "./step/auth.ts";
import {
	isStepConfigCommand,
	normalizeStepSessionSelectorArgs,
	runStepConfigCommand,
	translateStepCommandArgs,
} from "./step/command-compat.ts";
import { migrateStepConfig, readStepGlobalDefaults } from "./step/config-migration.ts";
import {
	getStepDefaultTheme,
	isStepServicesDisabled,
	STEP_DEFAULT_MODEL,
	STEP_DEFAULT_PROVIDER,
	withStepDefaults,
} from "./step/defaults.ts";
import { readOrCreateStepDeviceId, resolveStepStorageRoot } from "./step/device-id.ts";
import { resolveStepAgentDir, resolveStepConfigDir } from "./step/environment.ts";
import { runFeedbackCommand } from "./step/feedback/command.ts";
import { readFeedbackUsername } from "./step/feedback/context.ts";
import { maybeUpdateStep } from "./step/local-update.ts";
import { needsStepLoginBeforeInteractive, runStepLogin, syncStepLoginProfileEndpoint } from "./step/login-flow.ts";
import { createStepSessionManagerFactory } from "./step/session.ts";
import { createStepSettingsManager, type StepSettingsManager } from "./step/settings-manager.ts";
import {
	flushStderrDevLog,
	installProcessStderrDevLogCapture,
	setStderrDevLogStorageRootDirectory,
} from "./step/stderr-dev-log.ts";
import { StepStdioHost } from "./step/stdio-host.ts";
import {
	applyStepCodeConfigDefaults,
	createStepCodeProviderInlineExtension,
	decorateStepCodeSettingsManager,
	hasConfiguredStepCodeCredential,
	loadStepCodeConfig,
} from "./step/stepcode-config.ts";
import { buildStepSystemPromptAppendix } from "./step/system-prompt.ts";
import { createStepModelRequestObserver } from "./step/telemetry.ts";
import {
	createStepSystemMetricsCollector,
	createStepTelemetryRuntime,
	installStepTelemetryCrashHandlers,
	trackStepTelemetryError,
} from "./step/telemetry-runtime.ts";
import { createStepToolProfile } from "./step/tool-profile.ts";
import { resolveStepTraceHeaderBaseUrls } from "./step/trace-headers.ts";
import { STEP_CLI_VERSION } from "./step/version.ts";
import { createStepCli } from "./step-cli-runtime.ts";

export {
	STEP_DEFAULT_MODEL,
	STEP_DEFAULT_PROVIDER,
	withStepDefaults,
} from "./step/defaults.ts";

/**
 * Step's product entrypoint. The process still runs pi's main implementation;
 * these defaults only isolate Step's persisted state from a user's pi install.
 */
process.title = "step";
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "step";
process.emitWarning = (() => {}) as typeof process.emitWarning;
setStderrDevLogStorageRootDirectory(resolveStepStorageRoot(process.env));
installProcessStderrDevLogCapture();

// main() redirects process.stdout for headless modes so diagnostics cannot
// corrupt machine-readable output. Capture the original byte writer for the
// length-prefixed SDK protocol before that redirection happens.
const rawStdoutWrite = process.stdout.write.bind(process.stdout) as (chunk: Buffer) => boolean;
const sdkStdioRequested = process.argv.includes("--sdk-stdio");

// Migrate old config files before telemetry, device identity, or Pi's
// SettingsManager can create the canonical files.
// The source is retained; warnings are surfaced without blocking startup.
const stepConfigMigration = await migrateStepConfig();
for (const warning of stepConfigMigration.warnings) {
	process.stderr.write(`[step migration] ${warning}\n`);
}
const stepPersistedDefaults = await readStepGlobalDefaults();
const stepCodeConfig = await loadStepCodeConfig();
const stepCodeProviderExtension = stepCodeConfig ? createStepCodeProviderInlineExtension(stepCodeConfig) : undefined;
// Parse only the product policy flags here so the inline extension can receive
// explicit CLI values before Pi builds its resource loader. `main()` parses the
// same argv again for normal diagnostics and all other session options.
const stepPermissionArgs = parseArgs(normalizeStepSessionSelectorArgs(process.argv.slice(2)));

// Keep the model-request observer at the Step composition root. Pi owns the
// stream and retry loop; this reporter only receives the redacted dimensions
// needed by the legacy Step analytics query system. The runtime is disabled in
// test processes and can be opted out through the same Step environment flags.
const telemetryRuntime = createStepTelemetryRuntime({
	context: { version: STEP_CLI_VERSION.value },
	config: stepPersistedDefaults.telemetry,
});
const telemetryCrashHandlers = telemetryRuntime.enabled
	? installStepTelemetryCrashHandlers(telemetryRuntime)
	: undefined;
const systemMetrics = telemetryRuntime.enabled ? createStepSystemMetricsCollector(telemetryRuntime) : undefined;
systemMetrics?.start();
const modelRequestObserver = createStepModelRequestObserver(telemetryRuntime, {
	observerBaseUrls: resolveStepTraceHeaderBaseUrls(),
});
const telemetryStartedAt = Date.now();
let telemetryExitRecorded = false;
/**
 * Pi uses process.exit() for short-lived commands such as --version and --help.
 * Node emits the synchronous `exit` event for those paths but does not unwind
 * this module's async finally block. Record the terminal lifecycle event here
 * so short commands have the same telemetry contract as a normal session.
 *
 * This listener is prepended because the telemetry runtime installs its own
 * synchronous spool listener during construction. The record must be added to
 * the buffer before that listener snapshots it.
 */
const telemetryProcessExitHandler = (code: number): void => {
	if (telemetryExitRecorded) return;
	telemetryExitRecorded = true;
	const effectiveCode = Number.isInteger(code) ? code : (process.exitCode ?? 0);
	const exitReason = effectiveCode === 0 ? "normal" : effectiveCode === 130 ? "interrupt" : "error";
	telemetryRuntime.track("cli_exited", {
		duration_ms: Date.now() - telemetryStartedAt,
		exit_reason: exitReason,
	});
};
process.prependListener("exit", telemetryProcessExitHandler);
telemetryRuntime.track("cli_started", {
	entrypoint: readTelemetryEntrypoint(process.argv.slice(2)),
	os: process.platform,
	node_version: readTelemetryNodeVersion(),
});
const telemetryIdentityReady = initializeTelemetryIdentity();

// Keep the product entrypoint's transport setup identical to pi's native CLI.
// This runs before provider registration or any model request can occur.
configureHttpDispatcher();

let currentStepSettingsManager: StepSettingsManager | undefined;
const hasExplicitStepCredential =
	process.argv.slice(2).some((arg) => arg === "--api-key" || arg.startsWith("--api-key=")) ||
	Boolean(process.env.STEP_API_KEY?.trim());
const readCurrentFeedbackIdentity = () => {
	const uid = hasExplicitStepCredential
		? undefined
		: readCredentialUid(readStoredCredential(STEP_PROVIDER_ID, getStepAuthPath()));
	const username = readFeedbackUsername(process.env);
	return {
		...(uid ? { uid } : {}),
		...(username ? { username } : {}),
	};
};
const stepMainOptions: MainOptions = {
	agentDir: resolveStepAgentDir(),
	configDirName: resolveStepConfigDir(),
	sessionManagerFactory: createStepSessionManagerFactory(resolveStepAgentDir()),
	settingsManagerFactory: (cwd, agentDir, options) => {
		const stepManager = createStepSettingsManager(cwd, agentDir, options);
		const manager = stepCodeConfig ? decorateStepCodeSettingsManager(stepManager, stepCodeConfig) : stepManager;
		currentStepSettingsManager = manager;
		return manager;
	},
	authPath: getStepAuthPath(),
	extensionFactories: [
		createStepExtensionInline({
			telemetry: telemetryRuntime,
			stepSettings: () => currentStepSettingsManager,
			feedbackIdentity: readCurrentFeedbackIdentity,
			permission: {
				approvalMode: stepPermissionArgs.approvalMode,
				nonInteractiveApproval: stepPermissionArgs.nonInteractiveApproval,
				toolOverrides: stepPermissionArgs.toolOverride ?? stepPermissionArgs.toolOverrides,
			},
		}),
		createStepCapabilitiesExtensionInline({ telemetry: telemetryRuntime }),
		createStepCronExtension({ telemetry: telemetryRuntime }),
		...(stepCodeProviderExtension ? [stepCodeProviderExtension] : []),
	],
	authRuntimeSetup: (modelRuntime) => {
		modelRuntime.registerProvider(STEP_PROVIDER_ID, createStepProviderConfig());
		for (const provider of stepCodeConfig?.providers ?? []) {
			modelRuntime.registerProvider(provider.id, provider.config);
		}
	},
	allowedAuthProviders: [STEP_PROVIDER_ID, ...(stepCodeConfig?.providers.map((provider) => provider.id) ?? [])],
	disableBackgroundServices: isStepServicesDisabled(),
	defaultTheme: getStepDefaultTheme(),
	defaultProvider: stepCodeConfig?.defaultProvider ?? stepConfigMigration.defaultProvider ?? STEP_DEFAULT_PROVIDER,
	defaultModel: stepCodeConfig?.defaultModel ?? stepConfigMigration.defaultModel ?? STEP_DEFAULT_MODEL,
	beforeRuntimeCreate: async ({ cwd, agentDir }) => {
		// Session selectors may move the runtime to a workspace different from
		// process.cwd(). Give that workspace the same one-time legacy projection
		// before Pi loads its project-scoped settings and resources.
		const report = await migrateStepConfig({ cwd, agentDir });
		for (const warning of report.warnings) {
			process.stderr.write(`[step migration] ${warning}\n`);
		}
	},
	runtimeHostFactory: createStepCli,
	stdioModeFactory: sdkStdioRequested
		? async (runtimeHost) => {
				const host = new StepStdioHost({
					runtimeHost,
					writeFrame: rawStdoutWrite,
					onExitRequested: (code) => process.exit(code),
				});
				await host.run();
			}
		: undefined,
	interactiveModeOptions: {
		showChangelog: false,
		tuiStyle: "step" as const,
		defaultModelForProvider: (providerId) => (providerId === STEP_PROVIDER_ID ? STEP_DEFAULT_MODEL : undefined),
		allowedAuthProviders: [STEP_PROVIDER_ID],
		stepLogin: (host) =>
			runStepLogin({ authPath: getStepAuthPath(), createHost: () => host, themeName: getStepDefaultTheme() }),
		stepLogout: async () => {
			const report = await logoutStepCredentials({
				nativePath: getStepAuthPath(),
				legacyPath: getLegacyStepAuthPath(),
			});
			syncStepLoginProfileEndpoint(getStepAuthPath());
			return {
				removed: report.removedNative || report.removedLegacy,
				remainingSource: report.remainingSource ? "the environment (STEP_API_KEY)" : null,
			};
		},
		onCredentialAuthenticated: ({ uid }) => {
			if (uid) telemetryRuntime.setContext({ uid });
		},
		onStartup: async ({ ui, stop, dispose }) => {
			// Auth-only startup uses the same InteractiveMode for its OAuth dialog,
			// but must never be interrupted by a binary update prompt.
			if (process.argv[2] === "login" || process.argv[2] === "logout") return true;
			const outcome = await maybeUpdateStep({
				version: STEP_CLI_VERSION,
				storageRootDir: resolveStepStorageRoot(),
				updateCheckEnabled: stepPermissionArgs.updateCheck,
				ui,
				argv: process.argv.slice(2),
				cwd: process.cwd(),
				beforeRelaunch: async () => {
					stop();
					await dispose();
				},
			});
			return outcome !== "restarted";
		},
	},
	modelRequestObserver,
	systemPromptProduct: {
		name: "Step",
		role: "Step, an interactive terminal coding agent developed by StepFun",
		introduction:
			"You are step-cli, an interactive terminal coding agent developed by StepFun. You help with software engineering tasks in the current workspace: reading and changing code, running commands, and answering questions about the codebase. Optimize for correctness first, concision second, speed third.",
		includeDocumentation: false,
		promptAppendix: buildStepSystemPromptAppendix,
	},
	toolProfile: ({ cwd, agentDir, settingsManager }) =>
		createStepToolProfile(cwd, {
			agentDir,
			read: { autoResizeImages: settingsManager.getImageAutoResize() },
			bash: {
				commandPrefix: settingsManager.getShellCommandPrefix(),
				shellPath: settingsManager.getShellPath(),
			},
		}),
};

const topLevelStepCommand = process.argv[2];
const isTopLevelLogin = topLevelStepCommand === "login";
const isTopLevelLogout = topLevelStepCommand === "logout";
const isTopLevelFeedback = topLevelStepCommand === "feedback";
const topLevelAuthHelp = process.argv.slice(3).some((arg) => arg === "--help" || arg === "-h");

let telemetryExitReason: "normal" | "error" = "normal";
try {
	await telemetryIdentityReady;
	if (!isTopLevelLogout && !(isTopLevelLogin && topLevelAuthHelp)) {
		// Legacy credentials are projected by migrateStepConfig() before this
		// point. Normalize only an old product-shaped file that is already inside
		// the canonical Step CLI path; normal launches never fall back to
		// reading retired files after migration.
		await migrateLegacyStepCredential({
			nativePath: getStepAuthPath(),
			// The config migration above handles the common case, but keep the
			// direct credential migration pointed at the real legacy locations so a
			// login file created after the migration marker is still imported.
			legacyPath: getLegacyStepAuthPath(),
			explicitCredential: hasExplicitStepCredential,
		});
		const storedUid = hasExplicitStepCredential
			? undefined
			: readCredentialUid(readStoredCredential(STEP_PROVIDER_ID, getStepAuthPath()));
		if (storedUid) {
			telemetryRuntime.setContext({ uid: storedUid });
		}
	}
	if (isTopLevelLogout) {
		if (topLevelAuthHelp) {
			process.stdout.write("Usage: step logout\nRemove the stored Step credential.\n");
		} else {
			const report = await logoutStepCredentials({
				nativePath: getStepAuthPath(),
				legacyPath: getLegacyStepAuthPath(),
			});
			if (report.removedNative || report.removedLegacy) {
				process.stdout.write("Signed out of Step.\n");
				process.stdout.write(`Removed: ${report.nativePath}\n`);
			} else {
				process.stdout.write(`No stored Step credential at ${report.nativePath}\n`);
			}
			if (report.remainingSource) {
				process.stderr.write("Note: STEP_API_KEY is still set, so requests will keep working.\n");
			} else {
				process.stdout.write("Run `step login` to sign in again.\n");
			}
		}
	} else if (isTopLevelLogin) {
		if (topLevelAuthHelp) {
			process.stdout.write("Usage: step login\nSign in with the Step account and store a credential.\n");
		} else if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
			process.stderr.write(
				"step login needs an interactive terminal. Set STEP_API_KEY instead, or run it from a terminal.\n",
			);
			process.exitCode = 1;
		} else {
			const outcome = await runStepLogin({ authPath: getStepAuthPath(), themeName: getStepDefaultTheme() });
			if (outcome.kind === "completed") {
				syncStepLoginProfileEndpoint(getStepAuthPath());
				process.stdout.write(`Signed in${outcome.profile ? ` with ${outcome.profile.title}` : ""}.\n`);
				if (outcome.credentialsPath) process.stdout.write(`Credential written: ${outcome.credentialsPath}\n`);
			} else {
				process.stderr.write("Sign-in cancelled. No credential was written.\n");
				process.exitCode = 1;
			}
		}
	} else if (isTopLevelFeedback) {
		const feedbackSettingsManager =
			currentStepSettingsManager ?? createStepSettingsManager(process.cwd(), resolveStepAgentDir());
		const feedbackIdentity = readCurrentFeedbackIdentity();
		const exitCode = await runFeedbackCommand(process.argv.slice(3), {
			storageRootDir: resolveStepStorageRoot(process.env),
			...(feedbackIdentity.uid ? { uid: feedbackIdentity.uid } : {}),
			...(feedbackIdentity.username ? { username: feedbackIdentity.username } : {}),
			telemetry: telemetryRuntime,
			settings: feedbackSettingsManager,
			env: process.env,
		});
		if (exitCode !== 0) process.exitCode = exitCode;
	} else {
		const rawStepArgs = process.argv.slice(2);
		const normalizedStepArgs = normalizeStepSessionSelectorArgs(rawStepArgs);
		const stepCodeArgs = applyStepCodeConfigDefaults(normalizedStepArgs, stepCodeConfig);
		if (isStepConfigCommand(stepCodeArgs)) {
			await runStepConfigCommand(stepCodeArgs);
		} else {
			const compatibility = translateStepCommandArgs(stepCodeArgs);
			syncStepLoginProfileEndpoint(getStepAuthPath());
			let shouldLaunchMain = true;
			const parsedInteractiveArgs = parseArgs(compatibility?.args ?? stepCodeArgs);
			const interactiveStartup =
				process.stdin.isTTY === true &&
				process.stdout.isTTY === true &&
				parsedInteractiveArgs.messages.length === 0 &&
				parsedInteractiveArgs.fileArgs.length === 0 &&
				parsedInteractiveArgs.print !== true &&
				parsedInteractiveArgs.mode !== "json" &&
				parsedInteractiveArgs.mode !== "rpc";
			if (
				!hasConfiguredStepCodeCredential(stepCodeConfig) &&
				needsStepLoginBeforeInteractive({ authPath: getStepAuthPath(), interactive: interactiveStartup })
			) {
				const outcome = await runStepLogin({ authPath: getStepAuthPath(), themeName: getStepDefaultTheme() });
				if (outcome.kind === "exit") {
					shouldLaunchMain = false;
				} else {
					syncStepLoginProfileEndpoint(getStepAuthPath());
				}
			}
			if (shouldLaunchMain) {
				await main(
					withStepDefaults(
						compatibility?.args ?? stepCodeArgs,
						process.env,
						{
							provider: stepPersistedDefaults.provider ?? stepConfigMigration.defaultProvider,
							model: stepPersistedDefaults.model ?? stepConfigMigration.defaultModel,
						},
						{ deferSettingsSelection: true },
					),
					stepMainOptions,
				);
			}
		}
	}
} catch (error: unknown) {
	telemetryExitReason = "error";
	trackStepTelemetryError(telemetryRuntime, error, "cli_entry", false);
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`step error: ${message}\n`);
	process.exitCode = 1;
} finally {
	systemMetrics?.sample();
	systemMetrics?.stop();
	if (!telemetryExitRecorded) {
		telemetryExitRecorded = true;
		telemetryRuntime.track("cli_exited", {
			duration_ms: Date.now() - telemetryStartedAt,
			exit_reason: telemetryExitReason,
		});
	}
	process.off("exit", telemetryProcessExitHandler);
	telemetryCrashHandlers?.dispose();
	try {
		await telemetryRuntime.shutdown();
	} finally {
		await flushStderrDevLog();
	}
}

function readTelemetryEntrypoint(argv: readonly string[]): string {
	const first = argv[0];
	return first && !first.startsWith("-") ? first : "root";
}

function readTelemetryNodeVersion(): string {
	const [major, minor] = process.versions.node.split(".");
	return `${major}.${minor}`;
}

async function initializeTelemetryIdentity(): Promise<void> {
	if (!telemetryRuntime.enabled) return;
	try {
		const result = await readOrCreateStepDeviceId(resolveStepStorageRoot());
		if (result.deviceId) telemetryRuntime.setContext({ deviceId: result.deviceId });
		if (result.created) {
			telemetryRuntime.track("first_launch", {
				channel: process.env.STEP_CLI_BUILD_CHANNEL?.trim() || "dev",
			});
		}
	} catch {
		// A read-only or unavailable home must not prevent Step from starting.
	}
}

function readCredentialUid(credential: unknown): string | undefined {
	if (!credential || typeof credential !== "object" || Array.isArray(credential)) return undefined;
	const uid = (credential as Record<string, unknown>).uid;
	return typeof uid === "string" && uid.trim() ? uid.trim() : undefined;
}
