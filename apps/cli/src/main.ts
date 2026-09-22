#!/usr/bin/env node

// @step-harness/cli — process entry.
//
// Merges the former coding-agent startup segment with the
// argv → mode → dispatch → exit-code flow. The Step entry signal is set as the
// very first side effect (before the coding-agent barrel is evaluated) so
// config.ts resolves the Step storage namespace regardless of launcher name.
import "#bootstrap/environment";
import { join } from "node:path";

import {
	applyStepCodeConfigDefaults,
	buildStepSystemPromptAppendix,
	configureHttpDispatcher,
	createStepCode,
	createStepCodeProviderInlineExtension,
	createStepProviderConfig,
	createStepSessionManagerFactory,
	createStepSettingsManager,
	createStepToolProfile,
	decorateStepCodeSettingsManager,
	describeStepMcpImportOutcome,
	ensureStepGlobalConfig,
	flushStderrDevLog,
	getLegacyStepAuthPath,
	getStepAuthPath,
	getStepDefaultTheme,
	getStepLoginStatus,
	hasConfiguredStepCodeCredential,
	installProcessStderrDevLogCapture,
	isStepConfigCommand,
	isStepInteractiveLoginStartup,
	isStepServicesDisabled,
	loginMcpServer,
	logoutMcpServer,
	logoutStepCredentials,
	type MainOptions,
	type MainPreparation,
	maybeUpdateStep,
	migrateLegacyStepCredential,
	needsStepLoginBeforeInteractive,
	normalizeStepSessionSelectorArgs,
	parseStepUpdateCommand,
	prepareMain,
	readFeedbackUsername,
	readGlobalStepConfig,
	readOrCreateStepDeviceId,
	readStoredCredential,
	resolveStepAgentDir,
	resolveStepConfigDir,
	resolveStepConfigRoot,
	resolveStepStorageRoot,
	restoreStdout,
	runFeedbackCommand,
	runStepConfigCommand,
	runStepLogin,
	runStepMcpImportPrompt,
	runStepThemePrompt,
	runStepUpdateCommand,
	STEP_DEFAULT_MODEL,
	STEP_DEFAULT_PROVIDER,
	STEP_PROVIDER_ID,
	STEPCODE_VERSION,
	type StepSettingsManager,
	setStderrDevLogStorageRootDirectory,
	stopThemeWatcher,
	syncStepLoginProfileEndpoint,
	trackStepTelemetry,
	translateStepCommandArgs,
	updateGlobalMcpConfig,
	withStepDefaults,
} from "@step-harness/coding-agent";
import { parseArgs, toPrintOutputMode } from "#args/index";
import { loadStepStartupConfig } from "#bootstrap/config";
import { createStepExtensionFactories } from "#bootstrap/extensions";
import { captureRawStdout, sdkStdioRequested } from "#bootstrap/stdout-capture";
import { InteractiveMode, runPrintMode, runRpcMode } from "#modes/index";
import { createSdkStdioMode } from "#modes/sdk-stdio";
import { selectConfig, selectSession, showFirstTimeSetup, showStartupInput, showStartupSelector } from "#ui/index";
import { observability } from "./observability.ts";

/**
 * Step's product entrypoint. The process still runs pi's main implementation;
 * these defaults only isolate Step's persisted state from a user's pi install.
 */
process.title = "step";
process.env.AI_AGENT = "step";
process.emitWarning = (() => {}) as typeof process.emitWarning;
ensureStepGlobalConfig(process.env);
setStderrDevLogStorageRootDirectory(resolveStepStorageRoot(process.env));
installProcessStderrDevLogCapture();

// main() redirects process.stdout for headless modes so diagnostics cannot
// corrupt machine-readable output. Capture the original byte writer for the
// length-prefixed SDK protocol before that redirection happens.
const rawStdoutWrite = captureRawStdout();
const sdkStdio = sdkStdioRequested();

// Read persisted defaults before telemetry, device identity, or pi's
// SettingsManager exist (bootstrap step 2). Telemetry in particular is
// constructed below, so a user's saved `telemetry.enabled = false` has to be
// visible here or reporting silently turns itself back on at every launch.
const { persistedDefaults: stepPersistedDefaults, stepCodeConfig } = await loadStepStartupConfig();
const stepCodeProviderExtension = stepCodeConfig ? createStepCodeProviderInlineExtension(stepCodeConfig) : undefined;
// Parse only the product policy flags here so the inline extension can receive
// explicit CLI values before Pi builds its resource loader. `main()` parses the
// same argv again for normal diagnostics and all other session options.
const stepPermissionArgs = parseArgs(normalizeStepSessionSelectorArgs(process.argv.slice(2)));

// Keep the model-request observer at the Step composition root. Pi owns the
// stream and retry loop; this reporter only receives the redacted dimensions
// needed by the legacy Step analytics query system. The runtime is disabled in
// test processes and can be opted out through the same Step environment flags.
const telemetryReporter = observability.createReporter({
	version: STEPCODE_VERSION.value,
	config: stepPersistedDefaults.telemetry,
});
const telemetryCrashHandlers = observability.installCrashHandlers?.(telemetryReporter);
const systemMetrics = observability.createSystemMetrics?.(telemetryReporter);
systemMetrics?.start?.();
const modelRequestObserver = observability.createModelRequestObserver(telemetryReporter);
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
	trackStepTelemetry(telemetryReporter, "cli_exited", {
		duration_ms: Date.now() - telemetryStartedAt,
		exit_reason: exitReason,
	});
};
process.prependListener("exit", telemetryProcessExitHandler);
trackStepTelemetry(telemetryReporter, "cli_started", {
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
	modelsPath: join(resolveStepConfigRoot(), "models.json"),
	configDirName: resolveStepConfigDir(),
	sessionManagerFactory: createStepSessionManagerFactory(resolveStepAgentDir()),
	settingsManagerFactory: (cwd, agentDir, options) => {
		const stepManager = createStepSettingsManager(cwd, agentDir, options);
		const manager = stepCodeConfig ? decorateStepCodeSettingsManager(stepManager, stepCodeConfig) : stepManager;
		currentStepSettingsManager = manager;
		return manager;
	},
	authPath: getStepAuthPath(),
	extensionFactories: createStepExtensionFactories({
		telemetry: telemetryReporter,
		stepSettings: () => currentStepSettingsManager,
		feedbackIdentity: readCurrentFeedbackIdentity,
		permission: {
			approvalMode: stepPermissionArgs.approvalMode,
			nonInteractiveApproval: stepPermissionArgs.nonInteractiveApproval,
			toolOverrides: stepPermissionArgs.toolOverride ?? stepPermissionArgs.toolOverrides,
		},
		traceHeaderPolicy: observability.traceHeaderPolicy(),
		stepCodeProviderExtension,
	}),
	authRuntimeSetup: (modelRuntime) => {
		modelRuntime.registerProvider(STEP_PROVIDER_ID, createStepProviderConfig());
		for (const provider of stepCodeConfig?.providers ?? []) {
			modelRuntime.registerProvider(provider.id, provider.config);
		}
	},
	allowedAuthProviders: [STEP_PROVIDER_ID, ...(stepCodeConfig?.providers.map((provider) => provider.id) ?? [])],
	disableBackgroundServices: isStepServicesDisabled(),
	defaultTheme: getStepDefaultTheme(),
	defaultProvider: stepCodeConfig?.defaultProvider ?? stepPersistedDefaults.provider ?? STEP_DEFAULT_PROVIDER,
	defaultModel: stepCodeConfig?.defaultModel ?? stepPersistedDefaults.model ?? STEP_DEFAULT_MODEL,
	runtimeHostFactory: createStepCode,
	stdioModeFactory: sdkStdio ? createSdkStdioMode({ writeFrame: rawStdoutWrite }) : undefined,
	interactiveModeOptions: {
		showChangelog: false,
		tuiStyle: "step" as const,
		defaultModelForProvider: (providerId) => (providerId === STEP_PROVIDER_ID ? STEP_DEFAULT_MODEL : undefined),
		allowedAuthProviders: [STEP_PROVIDER_ID],
		stepLogin: (host) =>
			runStepLogin({
				authPath: getStepAuthPath(),
				createHost: () => host,
				themeName: getStepDefaultTheme(),
			}),
		stepMcpImport: async () =>
			describeStepMcpImportOutcome(await runStepMcpImportPrompt({ themeName: getStepDefaultTheme() })),
		stepThemePrompt: () => runStepThemePrompt({ themeName: getStepDefaultTheme() }),
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
			if (uid) telemetryReporter.setContext?.({ uid });
		},
		onStartup: async ({ ui, stop, dispose }) => {
			// Auth-only startup uses the same InteractiveMode for its OAuth dialog,
			// but must never be interrupted by a binary update prompt.
			if (process.argv[2] === "login" || process.argv[2] === "logout") return true;
			const outcome = await maybeUpdateStep({
				version: STEPCODE_VERSION,
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
	...(modelRequestObserver ? { modelRequestObserver } : {}),
	systemPromptProduct: {
		name: "StepCode",
		role: "an interactive terminal coding agent developed by StepFun",
		introduction:
			"You are StepCode, an interactive terminal coding agent developed by StepFun. You help with software engineering tasks in the current workspace: reading and changing code, running commands, and answering questions about the codebase. Optimize for correctness first, concision second, speed third.",
		includeDocumentation: false,
		promptAppendix: buildStepSystemPromptAppendix,
	},
	toolProfile: ({ cwd, agentDir, settingsManager }) =>
		createStepToolProfile(cwd, {
			agentDir,
			searchWeb: {
				apiKey: stepPermissionArgs.apiKey,
				authPath: getStepAuthPath(),
			},
			read: { autoResizeImages: settingsManager.getImageAutoResize() },
			bash: {
				commandPrefix: settingsManager.getShellCommandPrefix(),
				shellPath: settingsManager.getShellPath(),
			},
		}),
	// Startup UI selectors injected into prepareMain (dependency inversion). The
	// selectors live in this shell's #ui; coding-agent calls them through this
	// bag so it never imports @step-harness/cli (which would be a reverse dep).
	uiHooks: {
		selectSession,
		showFirstTimeSetup,
		selectConfig,
		showStartupSelector,
		showStartupInput,
	},
};

const topLevelStepCommand = process.argv[2];
const isTopLevelMcp = topLevelStepCommand === "mcp";
const isTopLevelLogin = topLevelStepCommand === "login";
const isTopLevelLoginStatus = isTopLevelLogin && process.argv[3] === "status";
const isTopLevelLogout = topLevelStepCommand === "logout";
const isTopLevelFeedback = topLevelStepCommand === "feedback";
const topLevelAuthHelp = process.argv.slice(3).some((arg) => arg === "--help" || arg === "-h");

let telemetryExitReason: "normal" | "error" = "normal";
// One-shot / package commands that finish inside prepareMain historically
// hard-exited (process.exit) so a loaded extension's leaked libuv handle
// (unref-less timer, open socket, keep-alive agent) could not keep the process
// alive. The soft-return refactor let the telemetry finally run instead, which
// dropped that guarantee. We re-arm it and force-exit AFTER that finally (so
// shutdown/devlog still flush). Left false for long-running dispatch modes
// (interactive/rpc/print) and for completed paths that must drain naturally
// (sdk-stdio's framed host; the win32 `update` teardown, nodejs/node#56645).
let forceOneShotExit = false;
try {
	await telemetryIdentityReady;
	if (!isTopLevelLogout && !(isTopLevelLogin && topLevelAuthHelp)) {
		// Normalize only an old product-shaped credential file that is already
		// inside the canonical StepCode path. This is the credential store, not
		// settings: Step reads no configuration from a legacy layout.
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
			telemetryReporter.setContext?.({ uid: storedUid });
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
	} else if (isTopLevelMcp) {
		const args = process.argv.slice(3);
		const subcommand = args[0] ?? "list";
		const json = args.includes("--json");
		const config = readGlobalStepConfig(process.env);
		const servers = config.mcp_servers ?? {};
		if (subcommand === "list" || subcommand === "get") {
			const name = subcommand === "get" ? args[1] : undefined;
			const selected = name ? (servers[name] ? { [name]: servers[name] } : {}) : servers;
			if (json) process.stdout.write(`${JSON.stringify(selected)}\n`);
			else
				for (const [serverName, declaration] of Object.entries(selected))
					process.stdout.write(`${serverName}: ${declaration.command ?? declaration.url ?? "invalid"}\n`);
			if (name && !servers[name]) process.exitCode = 1;
		} else if (subcommand === "remove") {
			const name = args[1];
			if (!name || !servers[name]) {
				process.stderr.write("Usage: step mcp remove <name>\n");
				process.exitCode = 1;
			} else {
				updateGlobalMcpConfig(process.env, (current) => {
					const next = { ...current };
					delete next[name];
					return next;
				});
				process.stdout.write(`Removed MCP server '${name}'. Restart Step to apply.\n`);
			}
		} else if (subcommand === "add") {
			const name = args[1];
			const separator = args.indexOf("--");
			// Everything after `--` is the server's own argv. Scanning past it
			// would let a server flag named `--url` or `--env` rewrite the entry
			// Step is about to store.
			const flags = separator >= 0 ? args.slice(0, separator) : args;
			const urlIndex = flags.indexOf("--url");
			const url = urlIndex >= 0 ? flags[urlIndex + 1] : undefined;
			const bearerIndex = flags.indexOf("--bearer-token-env-var");
			const bearerTokenEnvVar = bearerIndex >= 0 ? flags[bearerIndex + 1] : undefined;
			const envValues: Record<string, string> = {};
			for (let index = 2; index < flags.length; index += 1) {
				if (flags[index] !== "--env") continue;
				const pair = flags[index + 1];
				const separatorIndex = pair?.indexOf("=") ?? -1;
				if (separatorIndex > 0 && pair) envValues[pair.slice(0, separatorIndex)] = pair.slice(separatorIndex + 1);
			}
			const command = separator >= 0 ? args[separator + 1] : undefined;
			const commandArgs = separator >= 0 ? args.slice(separator + 2) : [];
			// `--env` sets literal process environment variables, so it belongs to
			// stdio servers only. Silently reinterpreting it as an HTTP header
			// name would store values the transport never sends.
			const envOnUrl = Boolean(url) && Object.keys(envValues).length > 0;
			if (
				!name ||
				servers[name] ||
				(!url && !command) ||
				(url && command) ||
				(bearerTokenEnvVar && !url) ||
				envOnUrl
			) {
				process.stderr.write(
					"Usage: step mcp add <name> --url <url> [--bearer-token-env-var VAR] | [--env KEY=VALUE]... -- <command> [args...]\n",
				);
				process.exitCode = 1;
			} else {
				updateGlobalMcpConfig(process.env, (current) => ({
					...current,
					[name]: url
						? {
								url,
								...(bearerTokenEnvVar ? { bearer_token_env_var: bearerTokenEnvVar } : {}),
							}
						: {
								command,
								args: commandArgs,
								...(Object.keys(envValues).length ? { env: envValues } : {}),
							},
				}));
				process.stdout.write(`Added MCP server '${name}'. Restart Step to apply.\n`);
			}
		} else if (subcommand === "login" || subcommand === "logout") {
			const name = args[1];
			const server = name ? servers[name] : undefined;
			if (!name || !server) {
				process.stderr.write("Usage: step mcp login|logout <http-server-name>\n");
				process.exitCode = 1;
			} else if (!server.url) {
				process.stderr.write(
					`"${name}" doesn't support OAuth login — it's only available for HTTP and SSE servers.\n`,
				);
				process.exitCode = 1;
			} else if (subcommand === "login") {
				try {
					await loginMcpServer(name, server.url, server.oauth, process.env);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (message.includes("403") && name.toLowerCase().includes("figma")) {
						throw new Error(
							"Step does not support figma mcp. You can use https://github.com/GLips/Figma-Context-MCP in StepCode as an alternative to the official Figma MCP.",
						);
					}
					throw error;
				}
			} else {
				process.stdout.write(
					logoutMcpServer(name, server.url, process.env)
						? `Logged out of MCP server '${name}'.\n`
						: `No stored credentials for MCP server '${name}'.\n`,
				);
			}
		} else {
			process.stderr.write("Usage: step mcp list|get|add|remove|login|logout\n");
			process.exitCode = 1;
		}
	} else if (isTopLevelLogin) {
		if (isTopLevelLoginStatus) {
			const statusArgs = process.argv.slice(4);
			const json = statusArgs.includes("--json");
			const unknown = statusArgs.find((arg) => arg !== "--json" && arg !== "--help" && arg !== "-h");
			if (unknown) {
				process.stderr.write(`Unknown option "${unknown}" for "login status".\n`);
				process.exitCode = 1;
			} else if (statusArgs.includes("--help") || statusArgs.includes("-h")) {
				process.stdout.write("Usage: step login status [--json]\nShow the current Step credential status.\n");
			} else {
				const status = await getStepLoginStatus({
					authPath: getStepAuthPath(),
					env: process.env,
				});
				if (json) {
					process.stdout.write(`${JSON.stringify(status)}\n`);
				} else if (status.validity === "missing") {
					process.stdout.write("Not signed in. Run `step login`.\n");
				} else {
					process.stdout.write(`Signed in${status.account ? ` as ${status.account}` : ""}.\n`);
					const loginMethodLabel =
						status.loginMethod === "api_key"
							? "apiKey"
							: status.loginMethod === "step_plan_oversea"
								? "Step Plan Oversea"
								: "Step Plan";
					process.stdout.write(`Login method: ${loginMethodLabel}.\n`);
					const validity =
						status.validity === "valid"
							? "check passed"
							: status.validity === "invalid"
								? "credential is invalid or expired"
								: "could not check credential validity (network error)";
					process.stdout.write(`Validity: ${validity}.\n`);
					if (status.validity === "invalid") process.exitCode = 1;
				}
			}
		} else if (topLevelAuthHelp) {
			process.stdout.write("Usage: step login\nSign in with the Step account and store a credential.\n");
		} else if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
			process.stderr.write(
				"step login needs an interactive terminal. Set STEP_API_KEY instead, or run it from a terminal.\n",
			);
			process.exitCode = 1;
		} else {
			const outcome = await runStepLogin({
				authPath: getStepAuthPath(),
				themeName: getStepDefaultTheme(),
			});
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
			telemetry: telemetryReporter,
			settings: feedbackSettingsManager,
			env: process.env,
		});
		if (exitCode !== 0) process.exitCode = exitCode;
	} else {
		const rawStepArgs = process.argv.slice(2);
		const updateCommand = parseStepUpdateCommand(rawStepArgs);
		if (updateCommand && "error" in updateCommand) {
			process.stderr.write(`${updateCommand.error}\n`);
			process.exitCode = 1;
		} else if (updateCommand) {
			process.exitCode = await runStepUpdateCommand({
				version: updateCommand.version,
			});
		} else {
			const normalizedStepArgs = normalizeStepSessionSelectorArgs(rawStepArgs);
			if (isStepConfigCommand(normalizedStepArgs)) {
				// Config inspection/init runs before session-default injection: these
				// commands are not sessions, so applyStepCodeConfigDefaults must not
				// splice --provider/--model into their argv — the config handler would
				// otherwise reject the injected flags as unknown options.
				await runStepConfigCommand(normalizedStepArgs);
			} else {
				const stepCodeArgs = applyStepCodeConfigDefaults(normalizedStepArgs, stepCodeConfig);
				const compatibility = translateStepCommandArgs(stepCodeArgs);
				syncStepLoginProfileEndpoint(getStepAuthPath());
				let shouldLaunchMain = true;
				const parsedInteractiveArgs = parseArgs(compatibility?.args ?? stepCodeArgs);
				const interactiveStartup = isStepInteractiveLoginStartup({
					stdinIsTTY: process.stdin.isTTY,
					stdoutIsTTY: process.stdout.isTTY,
					args: parsedInteractiveArgs,
				});
				if (
					!hasConfiguredStepCodeCredential(stepCodeConfig) &&
					needsStepLoginBeforeInteractive({
						authPath: getStepAuthPath(),
						interactive: interactiveStartup,
					})
				) {
					const outcome = await runStepLogin({
						authPath: getStepAuthPath(),
						themeName: getStepDefaultTheme(),
					});
					if (outcome.kind === "exit") {
						shouldLaunchMain = false;
					} else {
						syncStepLoginProfileEndpoint(getStepAuthPath());
					}
				}
				if (shouldLaunchMain) {
					const finalArgs = withStepDefaults(
						compatibility?.args ?? stepCodeArgs,
						process.env,
						{
							provider: stepPersistedDefaults.provider,
							model: stepPersistedDefaults.model,
						},
						{ deferSettingsSelection: true },
					);
					// The shell bypasses pi's main() and owns the run-mode dispatch
					// itself: prepareMain runs argv → assembly → mode resolution (and
					// finishes short commands / the framed sdk-stdio host in place),
					// then this switch runs the selected session mode. Keeping the
					// switch here — inside the telemetry try/finally — means no
					// process.exit() from a short command can skip the cli_exited
					// bookkeeping and shutdown flush below.
					const prep = await prepareMain(finalArgs, stepMainOptions);
					if (prep.kind === "completed") {
						if (prep.exitCode) process.exitCode = prep.exitCode;
						// prepareMain finished a one-shot command in place. Guarantee
						// termination after the telemetry finally below unless it asked
						// to drain naturally (sdk-stdio's framed host / win32 `update`).
						if (!prep.drainNaturally) forceOneShotExit = true;
					} else {
						await dispatchStepAppMode(prep);
					}
				}
			}
		}
	}
} catch (error: unknown) {
	// prepareMain took over stdout for a headless mode; a throw before the print
	// branch restored it would otherwise leave process.stdout redirected. Restore
	// it (idempotent) before reporting so the error surface is never swallowed by
	// the takeover, and no redirection leaks past this entry.
	restoreStdout();
	telemetryExitReason = "error";
	trackStepTelemetry(telemetryReporter, "crash", {
		error_type: error instanceof Error ? error.name : "Error",
		source: "cli_entry",
	});
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`step error: ${message}\n`);
	process.exitCode = 1;
} finally {
	systemMetrics?.sample?.();
	systemMetrics?.stop?.();
	if (!telemetryExitRecorded) {
		telemetryExitRecorded = true;
		trackStepTelemetry(telemetryReporter, "cli_exited", {
			duration_ms: Date.now() - telemetryStartedAt,
			exit_reason: telemetryExitReason,
		});
	}
	process.off("exit", telemetryProcessExitHandler);
	telemetryCrashHandlers?.dispose();
	try {
		await telemetryReporter.shutdown?.();
	} finally {
		await flushStderrDevLog();
	}
}

if (forceOneShotExit) {
	// The telemetry finally has flushed. Hard-exit now so a libuv handle leaked
	// by a loaded extension cannot keep this one-shot command's process alive
	// (restores the pre-refactor package-command termination guarantee).
	process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
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
	if (telemetryReporter.enabled === false) return;
	try {
		const result = await readOrCreateStepDeviceId(resolveStepStorageRoot());
		if (result.deviceId) telemetryReporter.setContext?.({ deviceId: result.deviceId });
		if (result.created) {
			trackStepTelemetry(telemetryReporter, "first_launch", {
				channel: process.env.STEPCODE_BUILD_CHANNEL?.trim() || "dev",
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

/**
 * Run the session mode pi's prepareMain resolved. This is the shell's own copy
 * of the dispatch switch pi's main() used to hold, kept here so the process
 * entry — not coding-agent — owns argv → mode → dispatch → exit-code.
 *
 * Uses prep.appMode verbatim (never re-resolves it, so a piped-stdin launch that
 * prepareMain already flipped to "print" can never fall back into the TTY UI).
 * stopThemeWatcher / restoreStdout are coding-agent's exported functions:
 * they act on coding-agent module-global state (theme watcher,
 * the stdout takeover prepareMain installed), so they must not be reimplemented.
 */
async function dispatchStepAppMode(prep: Extract<MainPreparation, { kind: "dispatch" }>): Promise<void> {
	switch (prep.appMode) {
		case "rpc": {
			await runRpcMode(prep.runtimeHost);
			break;
		}
		case "interactive": {
			const interactiveMode = new InteractiveMode(prep.runtimeHost, {
				configDirName: prep.configDirName,
				authPath: prep.authPath,
				migratedProviders: prep.migratedProviders,
				startupDiagnostics: prep.startupDiagnostics,
				modelFallbackMessage: prep.modelFallbackMessage,
				autoTrustOnReloadCwd: prep.autoTrustOnReloadCwd,
				initialMessage: prep.initialMessage,
				initialImages: prep.initialImages,
				initialMessages: prep.parsed.messages,
				verbose: prep.parsed.verbose,
				tuiMode: prep.parsed.tuiMode,
				initialThemeSetting: prep.parsed.useTheme,
				defaultTheme: stepMainOptions.defaultTheme,
				disableBackgroundServices: stepMainOptions.disableBackgroundServices,
				...stepMainOptions.interactiveModeOptions,
				sessionRoot: prep.sessionRoot,
			});
			await interactiveMode.run();
			break;
		}
		default: {
			// print / json headless channels.
			const exitCode = await runPrintMode(prep.runtimeHost, {
				mode: toPrintOutputMode(prep.appMode),
				messages: prep.parsed.messages,
				initialMessage: prep.initialMessage,
				initialImages: prep.initialImages,
			});
			stopThemeWatcher();
			restoreStdout();
			if (exitCode) process.exitCode = exitCode;
			break;
		}
	}
}
