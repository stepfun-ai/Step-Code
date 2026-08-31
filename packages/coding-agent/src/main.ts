/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { join } from "node:path";
import { createInterface } from "node:readline";
import { type ImageContent, modelsAreEqual } from "@earendil-works/pi-ai";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { type Args, type Mode, normalizeSessionName, parseArgs, printHelp } from "./cli/args.ts";
import {
	type AuthCheckResult,
	type AuthCheckRuntimeSetup,
	checkProviderAuth,
	createAuthCheckModelRuntime,
	getProviderCredential,
} from "./cli/auth-check.ts";
import {
	type AuthCommand,
	AuthCommandError,
	getAuthCommandName,
	getAuthCommandUsage,
	isAuthCommandHelp,
	parseAuthCommand,
	printAuthCommandHelp,
	validateAuthCommandArgs,
} from "./cli/auth-command.ts";
import { resolveCredentialForPrint } from "./cli/credential-print.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { listModels } from "./cli/list-models.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import { selectSession } from "./cli/session-picker.ts";
import {
	type StartupTuiPathOptions,
	shouldRunFirstTimeSetup,
	showFirstTimeSetup,
	showStartupSelector,
} from "./cli/startup-ui.ts";
import {
	APP_NAME,
	CONFIG_DIR_NAME,
	ENV_SESSION_DIR,
	expandTildePath,
	getAgentDir,
	getPackageDir,
	VERSION,
} from "./config.ts";
import {
	type AgentSessionRuntime,
	type AgentSessionRuntimeHost,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "./core/agent-session-runtime.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { AuthStorage, ReadOnlyAuthStorage } from "./core/auth-storage.ts";
import { exportFromFile } from "./core/export-html/index.ts";
import type { InlineExtension, ToolDefinition } from "./core/extensions/types.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.ts";
import type { ModelRequestObserver } from "./core/model-request-observer.ts";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { restoreStdout, takeOverStdout } from "./core/output-guard.ts";
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.ts";
import {
	assertValidSessionId,
	getDefaultSessionDir,
	type SessionInfo,
	SessionManager,
} from "./core/session-manager.ts";
import type { SessionManagerFactory } from "./core/session-manager-factory.ts";
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "./core/settings-diagnostics.ts";
import { SettingsManager, type SettingsManagerCreateOptions } from "./core/settings-manager.ts";
import type { SystemPromptProduct } from "./core/system-prompt.ts";
import { printTimings, resetTimings, time } from "./core/timings.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { builtInExtensions } from "./extensions/index.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import { InteractiveMode, type InteractiveModeOptions, runPrintMode, runRpcMode } from "./modes/index.ts";
import { initTheme, setThemeStorageDir, stopThemeWatcher } from "./modes/interactive/theme/theme.ts";
import { cleanupManagedInstall, handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import {
	continueStepSession,
	createStepSessionManager,
	forkStepSession,
	listAllStepSessions,
	listStepSessions,
	openStepSession,
} from "./step/session.ts";
import { isLocalPath, normalizePath, resolvePath } from "./utils/paths.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

const EXTENSION_LOAD_FAILURE_HINT = `Hint: Start without extensions using "${APP_NAME} -ne".`;

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {
	if (parsed.sdkStdio) {
		// The Step SDK host has its own framed stdin protocol. Treat it as a
		// headless mode so normal piped-prompt handling never consumes the stream.
		return "rpc";
	}
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
		return "print";
	}
	return "interactive";
}

function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc"> {
	return appMode === "json" ? "json" : "text";
}

function isPlainRuntimeMetadataCommand(parsed: Args): boolean {
	return !parsed.print && parsed.mode === undefined && (parsed.help === true || parsed.listModels !== undefined);
}

async function runAuthCommand(
	args: string[],
	authRuntimeSetup?: AuthCheckRuntimeSetup,
	authPath?: string,
	agentDir?: string,
	allowedAuthProviders?: readonly string[],
): Promise<boolean> {
	if (isAuthCommandHelp(args)) {
		printAuthCommandHelp();
		return true;
	}

	let command: AuthCommand | undefined;
	try {
		command = parseAuthCommand(args);
	} catch (error) {
		const message = error instanceof AuthCommandError ? error.message : "Failed to parse auth command";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
	if (!command) return false;

	const parsed = parseArgs(command.args);
	if (parsed.unknownFlags.size > 0) {
		const option = parsed.unknownFlags.keys().next().value;
		console.error(chalk.red(`Unknown option --${option} for "${getAuthCommandName(command.kind)}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getAuthCommandUsage(command.kind)}".`));
		process.exitCode = 1;
		return true;
	}
	try {
		if (parsed.diagnostics.length > 0) {
			throw new AuthCommandError(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
		}
		const requestedAuth = validateAuthCommandArgs(parsed, command.kind);
		assertAllowedAuthProvider(requestedAuth, allowedAuthProviders);
		if (command.kind !== "check") {
			const signal = AbortSignal.timeout(15_000);
			const modelRuntime = await ModelRuntime.create({
				allowModelNetwork: false,
				signal,
				authPath,
				modelsPath: agentDir ? join(resolvePath(agentDir), "models.json") : undefined,
			});
			authRuntimeSetup?.(modelRuntime);
			const credential = await resolveCredentialForPrint(
				parsed,
				modelRuntime,
				command.kind,
				command.minExpiryMs,
				signal,
			);
			process.stdout.write(`${credential}\n`);
			return true;
		}

		let result: AuthCheckResult;
		let credential: string | undefined;
		try {
			const credentials = command.noRefresh
				? authPath
					? new ReadOnlyAuthStorage(authPath)
					: new ReadOnlyAuthStorage()
				: authPath
					? AuthStorage.create(authPath)
					: AuthStorage.create();
			const modelRuntime = await createAuthCheckModelRuntime(credentials, authRuntimeSetup, {
				modelsPath: agentDir ? join(resolvePath(agentDir), "models.json") : undefined,
			});
			result = await checkProviderAuth(parsed, modelRuntime, {
				refresh: !command.noRefresh,
			});
			if (command.credentials && result.status === "ready") {
				credential = await getProviderCredential(result.provider, modelRuntime, credentials, {
					refresh: !command.noRefresh,
				});
				if (!credential) {
					result = {
						status: "not_ready",
						provider: result.provider,
						reason: "credential_not_available",
					};
				}
			}
		} catch {
			result = {
				status: "invalid",
				provider: requestedAuth.provider ?? requestedAuth.model!,
				reason: "invalid_state",
			};
		}
		const output = command.json
			? JSON.stringify({
					...result,
					...(credential ? { credentials: credential } : {}),
				})
			: (credential ?? result.status);
		process.stdout.write(`${output}\n`);
		process.exitCode = result.status === "ready" ? 0 : result.status === "not_ready" ? 1 : 2;
	} catch (error) {
		const message = error instanceof AuthCommandError ? error.message : "Failed to resolve credential";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = command.kind === "check" ? 2 : 1;
	}
	return true;
}

function assertAllowedAuthProvider(
	requested: { provider?: string; model?: string },
	allowedProviders?: readonly string[],
): void {
	if (!allowedProviders || allowedProviders.length === 0) return;
	const allowed = new Set(allowedProviders.map((provider) => provider.trim().toLowerCase()).filter(Boolean));
	if (allowed.size === 0) return;
	const provider = requested.provider?.trim().toLowerCase();
	const modelReference = requested.model?.trim();
	const modelProvider = modelReference?.includes("/")
		? modelReference.slice(0, modelReference.indexOf("/")).trim().toLowerCase()
		: undefined;
	const unsupported = (): never => {
		throw new AuthCommandError(`This Step command only supports authentication for: ${[...allowed].join(", ")}`);
	};
	if (provider && !allowed.has(provider)) unsupported();
	if (modelProvider && !allowed.has(modelProvider)) unsupported();
	if (!provider && !modelProvider && modelReference) {
		const bareModel = modelReference.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/iu, "").toLowerCase();
		const stepModels = new Set(["step-3.7-flash", "step-3.5-flash", "step-3.5-flash-2603", "step-router-v1"]);
		if (!stepModels.has(bareModel)) unsupported();
	}
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, {
		autoResizeImages,
	});
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** Result from resolving a session argument */
type ResolvedSession =
	| { type: "path"; path: string } // Direct file path
	| { type: "local"; path: string } // Found in current project
	| { type: "global"; path: string; cwd: string } // Found in different project
	| { type: "not_found"; arg: string }; // Not found anywhere

/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
async function findLocalSessionByExactId(
	sessionId: string,
	cwd: string,
	sessionDir?: string,
	agentDir?: string,
): Promise<{ type: "local"; path: string } | undefined> {
	const localSessions = agentDir
		? await listStepSessions(cwd, { agentDir, sessionDir })
		: await SessionManager.list(cwd, sessionDir);
	const localMatch = localSessions.find((s) => s.id === sessionId);
	return localMatch ? { type: "local", path: localMatch.path } : undefined;
}

/**
 * List every session for an injected product root. Pi's `listAll(root)` is a
 * direct-directory scan, while its no-argument form discovers one encoded cwd
 * directory at a time. The Step facade preserves that distinction explicitly.
 */
function listAllForRoot(
	root: string | undefined,
	agentDir: string | undefined,
	cwd: string,
	onProgress?: (loaded: number, total: number) => void,
): Promise<SessionInfo[]> {
	if (!agentDir) {
		return root ? SessionManager.listAll(root, onProgress) : SessionManager.listAll(onProgress);
	}
	const defaultRoot = join(resolvePath(agentDir), "sessions");
	const explicitRoot = root && normalizePath(root) !== normalizePath(defaultRoot) ? root : undefined;
	return listAllStepSessions({
		agentDir,
		sessionDir: explicitRoot,
		cwd,
		onProgress,
	});
}

async function resolveSessionPath(
	sessionArg: string,
	cwd: string,
	sessionDir?: string,
	sessionRoot?: string,
	agentDir?: string,
): Promise<ResolvedSession> {
	// If it looks like a file path, resolve it before handing it to the session manager.
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: resolvePath(sessionArg, cwd) };
	}

	// Try to match as session ID in current project first
	const localSessions = agentDir
		? await listStepSessions(cwd, { agentDir, sessionDir })
		: await SessionManager.list(cwd, sessionDir);
	const localMatch =
		localSessions.find((s) => s.id === sessionArg) ?? localSessions.find((s) => s.id.startsWith(sessionArg));

	if (localMatch) {
		return { type: "local", path: localMatch.path };
	}

	// Try global search across all projects
	const allSessions = await listAllForRoot(sessionRoot ?? sessionDir, agentDir, cwd);
	const globalMatch =
		allSessions.find((s) => s.id === sessionArg) ?? allSessions.find((s) => s.id.startsWith(sessionArg));

	if (globalMatch) {
		return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
	}

	// Not found anywhere
	return { type: "not_found", arg: sessionArg };
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

function validateSessionIdFlags(parsed: Args): void {
	if (parsed.sessionId === undefined) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --session-id cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}

	try {
		assertValidSessionId(parsed.sessionId);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function openSessionOrExit(path: string, sessionDir?: string, agentDir?: string): SessionManager {
	try {
		return agentDir ? openStepSession(path, { agentDir, sessionDir }) : SessionManager.open(path, sessionDir);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function forkSessionOrExit(
	sourcePath: string,
	cwd: string,
	sessionDir?: string,
	sessionId?: string,
	agentDir?: string,
): SessionManager {
	try {
		return agentDir
			? forkStepSession(sourcePath, cwd, { agentDir, sessionDir, newSession: { id: sessionId } })
			: SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id: sessionId });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

export async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
	startupTuiPaths?: StartupTuiPathOptions,
	sessionRoot?: string,
): Promise<SessionManager> {
	const agentDir = startupTuiPaths?.agentDir;
	if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
		return SessionManager.inMemory(cwd, parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined);
	}

	if (parsed.fork) {
		if (parsed.sessionId) {
			const existingTarget = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir, agentDir);
			if (existingTarget) {
				console.error(chalk.red(`Session already exists with id '${parsed.sessionId}'`));
				process.exit(1);
			}
		}

		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir, sessionRoot, agentDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir, parsed.sessionId, agentDir);

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir, sessionRoot, agentDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return openSessionOrExit(resolved.path, sessionDir, agentDir);

			case "global": {
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved.path, cwd, sessionDir, undefined, agentDir);
			}

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.resume) {
		try {
			const selectedPath = await selectSession(
				(onProgress) =>
					agentDir
						? listStepSessions(cwd, { agentDir, sessionDir, onProgress })
						: SessionManager.list(cwd, sessionDir, onProgress),
				(onProgress) => listAllForRoot(sessionRoot ?? sessionDir, agentDir, cwd, onProgress),
				settingsManager,
				startupTuiPaths,
			);
			if (!selectedPath) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return openSessionOrExit(selectedPath, sessionDir, agentDir);
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		return agentDir
			? continueStepSession(cwd, { agentDir, sessionDir })
			: SessionManager.continueRecent(cwd, sessionDir);
	}

	if (parsed.sessionId) {
		const existingSession = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir, agentDir);
		if (existingSession) {
			return openSessionOrExit(existingSession.path, sessionDir, agentDir);
		}
		console.error(
			chalk.yellow(
				`Warning: No project session found with id '${parsed.sessionId}'; creating a new session with that id.`,
			),
		);
	}

	return agentDir
		? createStepSessionManager(cwd, { agentDir, sessionDir, newSession: { id: parsed.sessionId } })
		: SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}

function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRuntime: ModelRuntime,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			cliThinking: parsed.thinking,
			modelRuntime,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRuntime.getModel(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set as a non-persistent runtime override
	// (handled by caller before createAgentSession)

	// Tools
	if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}
	if (parsed.excludeTools) {
		options.excludeTools = [...parsed.excludeTools];
	}

	return { options, cliThinkingFromModel, diagnostics };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
	paths?: StartupTuiPathOptions,
): Promise<string | undefined> {
	return showStartupSelector(
		settingsManager,
		formatMissingSessionCwdPrompt(issue),
		[
			{ label: "Continue", value: issue.fallbackCwd },
			{ label: "Cancel", value: undefined },
		],
		paths,
	);
}

export interface MainOptions {
	extensionFactories?: InlineExtension[];
	/** Global agent directory for this product instance. */
	agentDir?: string;
	/** Project resource directory name for this product instance. */
	configDirName?: string;
	/** Optional credential file override for product entrypoints. */
	authPath?: string;
	/** Session construction facade used by replacement flows such as /new and /fork. */
	sessionManagerFactory?: SessionManagerFactory;
	/**
	 * Optional settings-manager decorator/factory. Pi remains the default; a
	 * product can wrap it to add isolated settings without changing Pi's schema.
	 */
	settingsManagerFactory?: (cwd: string, agentDir: string, options?: SettingsManagerCreateOptions) => SettingsManager;
	/** Disable Pi's optional network, catalog, update, and install telemetry services. */
	disableBackgroundServices?: boolean;
	/** Fallback interactive theme when settings and CLI flags do not select one. */
	defaultTheme?: string;
	/** Product model fallback applied after global/project settings. */
	defaultProvider?: string;
	/** Product model id fallback applied after global/project settings. */
	defaultModel?: string;
	/** Register product providers in the short-lived auth command runtime. */
	authRuntimeSetup?: AuthCheckRuntimeSetup;
	/** Restrict the auth command surface to product-owned providers. */
	allowedAuthProviders?: readonly string[];
	/**
	 * Optionally place a product facade in front of pi's runtime host. The facade
	 * must delegate lifecycle operations to the supplied runtime; modes continue
	 * to use the same pi-owned session and event loop.
	 */
	runtimeHostFactory?: (runtime: AgentSessionRuntime) => AgentSessionRuntimeHost;
	/** Product-specific presentation switches for the native interactive mode. */
	interactiveModeOptions?: Pick<
		InteractiveModeOptions,
		| "authPath"
		| "showChangelog"
		| "tuiStyle"
		| "startupLoginProvider"
		| "forceStartupLogin"
		| "exitAfterStartupLogin"
		| "onCredentialAuthenticated"
		| "defaultModelForProvider"
		| "skipManagedTools"
		| "allowedAuthProviders"
		| "onStartup"
		| "offline"
	>;
	/** Run a product-owned framed stdio host after Pi creates the runtime. */
	stdioModeFactory?: (runtimeHost: AgentSessionRuntimeHost) => Promise<void>;
	/** Optional best-effort observer for provider request lifecycle metrics. */
	modelRequestObserver?: ModelRequestObserver;
	/** Optional product identity used by the default system prompt. */
	systemPromptProduct?: SystemPromptProduct;
	/**
	 * Prepare a cwd before Pi creates its cwd-bound settings/resources. Products
	 * use this for idempotent compatibility work when a session is resumed from
	 * another workspace; Pi itself leaves the hook unset.
	 */
	beforeRuntimeCreate?: (context: { cwd: string; agentDir: string }) => Promise<void> | void;
	/**
	 * Optional product tool profile. Definitions are registered as custom tools,
	 * so Pi's native execution, approval, and renderer plumbing remains intact.
	 */
	toolProfile?: (context: {
		cwd: string;
		agentDir: string;
		settingsManager: SettingsManager;
	}) => Array<ToolDefinition<any, any, any>>;
}

export async function main(args: string[], options?: MainOptions) {
	resetTimings();
	const extensionFactories = [...builtInExtensions, ...(options?.extensionFactories ?? [])];
	const configDirName = options?.configDirName?.trim() || CONFIG_DIR_NAME;
	const cwd = process.cwd();
	const agentDir = options?.agentDir ? resolvePath(options.agentDir) : getAgentDir();
	// A computed default agent directory is also used by ordinary Pi. Only an
	// explicitly supplied product path opts into the Step storage facade; this
	// keeps Pi's no-argument SessionManager.listAll/continue semantics intact.
	const productStoragePaths: StartupTuiPathOptions | undefined =
		options?.agentDir !== undefined || options?.configDirName !== undefined ? { agentDir, configDirName } : undefined;
	const authPath = options?.authPath
		? resolvePath(options.authPath, cwd)
		: options?.agentDir
			? join(agentDir, "auth.json")
			: undefined;
	// Keep explicit offline mode separate from the product switch that only
	// disables Pi's optional catalog/update/install services. Step uses the
	// latter by default but must still be able to open its OAuth login flow.
	const explicitOfflineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
	// `disableBackgroundServices` is deliberately narrower than offline mode:
	// it suppresses catalog/update/install work, but provider requests and the
	// interactive OAuth flow must remain available to product entrypoints.
	const offlineMode = explicitOfflineMode;
	if (offlineMode) {
		process.env.PI_OFFLINE = "1";
		process.env.PI_SKIP_VERSION_CHECK = "1";
	}

	if (
		await runAuthCommand(args, options?.authRuntimeSetup, authPath, options?.agentDir, options?.allowedAuthProviders)
	) {
		return;
	}

	if (process.platform === "win32") {
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	}
	cleanupManagedInstall();

	const createSettingsManager =
		options?.settingsManagerFactory ??
		((settingsCwd: string, settingsAgentDir: string, settingsOptions?: SettingsManagerCreateOptions) =>
			SettingsManager.create(settingsCwd, settingsAgentDir, settingsOptions));
	const bootstrapSettingsManager = createSettingsManager(cwd, agentDir, {
		projectTrusted: false,
		configDirName,
	});
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher();

	if (
		await handlePackageCommand(args, {
			extensionFactories,
			agentDir,
			settingsManagerFactory: options?.settingsManagerFactory,
			configDirName,
		})
	) {
		const exitCode = process.exitCode ?? 0;
		if (process.platform === "win32" && exitCode === 0 && args[0] === "update") {
			// We normally prefer process.exit(0) for package commands so bad extensions cannot keep
			// one-shot commands alive. On Windows, Node can assert after fetch() if process.exit(0)
			// runs during teardown; let successful `pi update` drain naturally instead.
			// https://github.com/nodejs/node/issues/56645
			return;
		}
		process.exit(exitCode);
		return;
	}

	if (
		await handleConfigCommand(args, {
			extensionFactories,
			agentDir,
			settingsManagerFactory: options?.settingsManagerFactory,
			configDirName,
		})
	) {
		return;
	}

	const parsed = parseArgs(args);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	const shouldTakeOverStdout = appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	validateForkFlags(parsed);
	validateSessionIdFlags(parsed);

	// Run migrations (pass cwd for project-local migrations)
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd, {
		agentDir,
		configDirName,
	});
	time("runMigrations");

	const startupSettingsManager = createSettingsManager(cwd, agentDir, { configDirName });
	const startupSettingsDiagnostics = collectSettingsDiagnostics(startupSettingsManager);

	// Experimental first-time setup: theme choice and analytics opt-in.
	// Runs before any runtime services are created so the chosen settings apply everywhere.
	if (
		appMode === "interactive" &&
		!parsed.help &&
		parsed.listModels === undefined &&
		shouldRunFirstTimeSetup(join(agentDir, "settings.json"))
	) {
		await showFirstTimeSetup(startupSettingsManager, { agentDir, configDirName });
		time("firstTimeSetup");
	}

	if (appMode === "interactive" && parsed.useTheme !== undefined) {
		startupSettingsManager.applyOverrides({ theme: parsed.useTheme });
	}

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --session and --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// sessionDir lookup during session selection.
	const envSessionDir = process.env[ENV_SESSION_DIR];
	const configuredSessionDir =
		(parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
		(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
		startupSettingsManager.getSessionDir();
	// Pi's static SessionManager methods fall back to the module-global agent
	// directory when their sessionDir argument is omitted. Resolve the default
	// explicitly for persisted sessions so a Step runtime (or an embedded caller
	// with a custom agentDir) can never spill into ~/.pi. Help/list-models and
	// --no-session retain Pi's in-memory behavior and do not create a directory.
	const sessionDir =
		configuredSessionDir ??
		(parsed.noSession || parsed.help || parsed.listModels !== undefined
			? undefined
			: productStoragePaths
				? getDefaultSessionDir(cwd, agentDir)
				: undefined);
	const sessionRoot = configuredSessionDir ?? (productStoragePaths ? join(agentDir, "sessions") : undefined);
	let sessionManager = await createSessionManager(
		parsed,
		cwd,
		sessionDir,
		startupSettingsManager,
		productStoragePaths,
		sessionRoot,
	);
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		if (appMode === "interactive") {
			const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager, {
				agentDir,
				configDirName,
			});
			if (!selectedCwd) {
				process.exit(0);
			}
			sessionManager = agentDir
				? openStepSession(missingSessionCwdIssue.sessionFile!, {
						agentDir,
						sessionDir,
						cwdOverride: selectedCwd,
					})
				: SessionManager.open(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd);
		} else {
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
	}
	if (parsed.name !== undefined) {
		const name = normalizeSessionName(parsed.name);
		if (name === undefined) {
			console.error(chalk.red("Error: --name requires a non-empty value"));
			process.exit(1);
		}
		sessionManager.appendSessionInfo(name);
	}
	time("createSessionManager");

	const trustStore = new ProjectTrustStore(agentDir);
	const sessionCwd = sessionManager.getCwd();
	const autoTrustOnReloadCwd =
		parsed.projectTrustOverride === undefined && !hasTrustRequiringProjectResources(sessionCwd, configDirName)
			? sessionCwd
			: undefined;
	const trustPromptMode: AppMode = parsed.help || parsed.listModels !== undefined ? "print" : appMode;
	const projectTrustByCwd = new Map<string, boolean>();

	const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
	const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
	const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
	const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
		projectTrustContext,
	}) => {
		await options?.beforeRuntimeCreate?.({ cwd, agentDir });
		const isInitialRuntime = sessionStartEvent === undefined;
		const projectTrustDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
		const cachedProjectTrust = projectTrustByCwd.get(cwd);
		const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd, configDirName);
		const shouldResolveProjectTrust =
			parsed.projectTrustOverride === undefined && cachedProjectTrust === undefined && hasTrustRequiringResources;
		const projectTrusted = shouldResolveProjectTrust
			? false
			: (cachedProjectTrust ??
				parsed.projectTrustOverride ??
				(!hasTrustRequiringResources || trustStore.get(cwd) === true));
		const runtimeSettingsManager = createSettingsManager(cwd, agentDir, {
			projectTrusted,
			configDirName,
		});
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			configDirName,
			authPath,
			settingsManager: runtimeSettingsManager,
			modelRuntimeSignal: AbortSignal.timeout(15_000),
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderReloadOptions: shouldResolveProjectTrust
				? {
						resolveProjectTrust: async ({ extensionsResult }) => {
							const trusted = await resolveProjectTrusted({
								cwd,
								trustStore,
								configDirName,
								trustOverride: parsed.projectTrustOverride,
								defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
								extensionsResult,
								projectTrustContext:
									projectTrustContext ??
									createProjectTrustContext({
										cwd,
										mode: isInitialRuntime ? trustPromptMode : appMode,
										settingsManager: startupSettingsManager,
										hasUI: isInitialRuntime && trustPromptMode === "interactive",
										paths: { agentDir, configDirName },
									}),
								onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
							});
							projectTrustByCwd.set(cwd, trusted);
							return trusted;
						},
					}
				: undefined,
			resourceLoaderOptions: {
				additionalExtensionPaths: resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				noExtensions: parsed.noExtensions,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				noContextFiles: parsed.noContextFiles,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories,
			},
		});
		const { settingsManager, modelRuntime, resourceLoader } = services;
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			...projectTrustDiagnostics,
			...services.diagnostics,
			...collectSettingsDiagnostics(settingsManager),
			...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				type: "error" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
		];

		const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
		const scopedModels =
			modelPatterns && modelPatterns.length > 0
				? await resolveModelScope(modelPatterns, modelRuntime, {
						signal: AbortSignal.timeout(15_000),
					})
				: [];
		const {
			options: sessionOptions,
			cliThinkingFromModel,
			diagnostics: sessionOptionDiagnostics,
		} = buildSessionOptions(
			parsed,
			scopedModels,
			sessionManager.buildSessionContext().messages.length > 0,
			modelRuntime,
			settingsManager,
		);
		diagnostics.push(...sessionOptionDiagnostics);

		const profileTools = options?.toolProfile?.({ cwd, agentDir, settingsManager });
		if (profileTools && profileTools.length > 0) {
			sessionOptions.customTools = [...(sessionOptions.customTools ?? []), ...profileTools];
			// The profile replaces Pi's default built-ins with its model-facing
			// aliases. Explicit --tools/--no-tools flags retain their normal meaning.
			if (!sessionOptions.tools && !sessionOptions.noTools) {
				sessionOptions.noTools = "builtin";
			}
		}

		if (parsed.apiKey) {
			if (!sessionOptions.model) {
				diagnostics.push({
					type: "error",
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				await modelRuntime.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
			}
		}

		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: sessionOptions.model,
			defaultProvider: options?.defaultProvider,
			defaultModelId: options?.defaultModel,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			excludeTools: sessionOptions.excludeTools,
			noTools: sessionOptions.noTools,
			customTools: sessionOptions.customTools,
			modelRequestObserver: options?.modelRequestObserver,
			systemPromptProduct: options?.systemPromptProduct,
		});
		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}

		return {
			...created,
			services,
			diagnostics,
		};
	};
	time("createRuntime");
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
		sessionManagerFactory: options?.sessionManagerFactory,
	});
	time("createAgentSessionRuntime");
	const runtimeHost = options?.runtimeHostFactory?.(runtime) ?? runtime;
	const { services, session, modelFallbackMessage } = runtime;
	const { settingsManager, modelRuntime, resourceLoader } = services;
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

	if (parsed.help) {
		reportDiagnostics(startupSettingsDiagnostics);
		const extensionFlags = resourceLoader
			.getExtensions()
			.extensions.flatMap((extension) => Array.from(extension.flags.values()));
		printHelp(extensionFlags);
		process.exit(0);
	}

	if (parsed.listModels !== undefined) {
		reportDiagnostics(startupSettingsDiagnostics);
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRuntime, searchPattern, AbortSignal.timeout(15_000));
		process.exit(0);
	}

	// Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
	let stdinContent: string | undefined;
	if (appMode !== "rpc") {
		stdinContent = await readPipedStdin();
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
	}
	time("readPipedStdin");

	const { initialMessage, initialImages } = await prepareInitialMessage(
		parsed,
		settingsManager.getImageAutoResize(),
		stdinContent,
	);
	time("prepareInitialMessage");
	setThemeStorageDir(agentDir);
	initTheme(settingsManager.getTheme() ?? options?.defaultTheme, appMode === "interactive");
	time("initTheme");

	// Show deprecation warnings in interactive mode
	if (appMode === "interactive" && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}

	time("resolveModelScope");
	const startupDiagnostics = deduplicateDiagnostics([...startupSettingsDiagnostics, ...runtime.diagnostics]);
	const hasRuntimeErrors = runtime.diagnostics.some((diagnostic) => diagnostic.type === "error");
	if (appMode !== "interactive" || hasRuntimeErrors) {
		reportDiagnostics(startupDiagnostics);
	}
	if (hasRuntimeErrors) {
		if (runtime.diagnostics.some((diagnostic) => diagnostic.message.includes("Failed to load extension"))) {
			console.error(chalk.yellow(EXTENSION_LOAD_FAILURE_HINT));
		}
		process.exit(1);
	}
	time("createAgentSession");

	if (appMode !== "interactive" && !session.model) {
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		process.exit(1);
	}

	if (parsed.sdkStdio) {
		if (!options?.stdioModeFactory) {
			console.error(chalk.red("Error: --sdk-stdio is only available from the step entrypoint"));
			process.exit(1);
		}
		await options.stdioModeFactory(runtimeHost);
		return;
	}

	const startupBenchmark = isTruthyEnvFlag(process.env.PI_STARTUP_BENCHMARK);
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red("Error: PI_STARTUP_BENCHMARK only supports interactive mode"));
		process.exit(1);
	}

	// RPC refreshes catalogs here in the background; interactive mode starts its refresh after TUI initialization.
	if (!offlineMode && !options?.disableBackgroundServices && appMode === "rpc") {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		void modelRuntime
			.refresh({ signal: controller.signal })
			.catch(() => {})
			.finally(() => clearTimeout(timeout));
	}

	if (appMode === "rpc") {
		printTimings();
		await runRpcMode(runtimeHost);
	} else if (appMode === "interactive") {
		const interactiveMode = new InteractiveMode(runtimeHost, {
			configDirName,
			authPath,
			migratedProviders,
			startupDiagnostics,
			modelFallbackMessage,
			autoTrustOnReloadCwd,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
			tuiMode: parsed.tuiMode,
			initialThemeSetting: parsed.useTheme,
			defaultTheme: options?.defaultTheme,
			disableBackgroundServices: options?.disableBackgroundServices,
			...options?.interactiveModeOptions,
			sessionRoot,
			offline: explicitOfflineMode || options?.interactiveModeOptions?.offline === true,
		});
		if (startupBenchmark) {
			await interactiveMode.init();
			time("interactiveMode.init");
			// Give the TUI's stdin handler a brief chance to consume terminal query replies
			// (Kitty keyboard protocol, device attributes, cell size) before restoring the terminal.
			await new Promise((resolve) => setTimeout(resolve, 150));
			interactiveMode.stop();
			stopThemeWatcher();
			printTimings();
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			if (process.stderr.writableLength > 0) {
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			return;
		}

		printTimings();
		await interactiveMode.run();
	} else {
		printTimings();
		const exitCode = await runPrintMode(runtimeHost, {
			mode: toPrintOutputMode(appMode),
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		return;
	}
}
