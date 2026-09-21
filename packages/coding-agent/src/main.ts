/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { join } from "node:path";
import { createInterface } from "node:readline";
import { setCapabilityOverrides } from "@step-harness/pi-tui";
import { type ImageContent, modelsAreEqual } from "@step-harness/providers";
import { STEP_PROVIDER_ID } from "@step-harness/providers/step-provider";
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
import {
	APP_NAME,
	CONFIG_DIR_NAME,
	ENV_SESSION_DIR,
	expandTildePath,
	getAgentDir,
	getPackageDir,
	STEP_ENTRYPOINT,
	VERSION,
} from "./config.ts";
import type { AgentSession } from "./core/agent-session.ts";
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
import { type AppMode, ProjectTrustDeclinedError, resolveProjectTrusted } from "./core/project-trust.ts";
import type { ResourceLoader } from "./core/resource-loader.ts";
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
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { builtInExtensions } from "./features/index.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import { runPrintMode, runRpcMode } from "./modes/index.ts";
import type { InteractiveModeOptions, StartupTuiPathOptions, StartupUiHooks } from "./modes/interactive-contract.ts";
import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import {
	continueStepSession,
	createStepSessionManager,
	forkStepSession,
	listAllStepSessions,
	listStepSessions,
	openStepSession,
} from "./step/session.ts";
import {
	detectTerminalBackgroundFromEnv,
	initTheme,
	resolveThemeSetting,
	setThemeStorageDir,
	stopThemeWatcher,
} from "./theme/theme.ts";
import { isLocalPath, normalizePath, resolvePath } from "./utils/paths.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

const EXTENSION_LOAD_FAILURE_HINT = `Hint: Start without extensions using "${APP_NAME} -ne".`;

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
export async function readPipedStdin(): Promise<string | undefined> {
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
			// Preserve the piped content verbatim (leading/trailing whitespace and
			// newlines are meaningful to the model); trim only to decide whether the
			// pipe was effectively empty and should be treated as absent.
			resolve(data.trim().length > 0 ? data : undefined);
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

export function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {
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

export function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc"> {
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
	selectSession?: StartupUiHooks["selectSession"],
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
			if (!selectSession) {
				throw new Error("The interactive session selector (uiHooks.selectSession) is required to --resume.");
			}
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
	showStartupSelector: StartupUiHooks["showStartupSelector"],
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
	/** Optional model catalog path for product entrypoints. */
	modelsPath?: string;
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
		| "stepLogin"
		| "stepLogout"
		| "stepMcpImport"
		| "stepThemePrompt"
		| "onStartup"
	>;
	/** Run a product-owned framed stdio host after Pi creates the runtime. */
	stdioModeFactory?: (runtimeHost: AgentSessionRuntimeHost) => Promise<void>;
	/**
	 * Startup UI selectors injected by the product shell (dependency inversion).
	 * The interactive selectors live in @step-harness/cli; `prepareMain` calls
	 * them through this bag so this package never imports the shell. Absent when
	 * coding-agent's own `main()` runs a non-interactive command.
	 */
	uiHooks?: StartupUiHooks;
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

/**
 * Outcome of the argv → assembly → mode-resolution pipeline that pi's `main()`
 * runs before it dispatches into a run mode.
 *
 * `prepareMain()` performs every step of the former `main()` body up to (but not
 * including) the final `switch (appMode)`: it parses argv, runs the short-lived
 * metadata/auth/package/config commands, builds the runtime, resolves the final
 * `appMode` (including the piped-stdin → print flip), and applies the same
 * module-global side effects (stdout takeover, theme watcher).
 *
 *  - `kind: "completed"` — a short-command path already produced all output and
 *    the process should stop. `exitCode` encodes pi's historical exit contract:
 *    a command that always called `process.exit(n)` reports that `n` (including
 *    an explicit `0` for `--version` / `--help` / `--export` / `--list-models`),
 *    while the soft-return commands that only set `process.exitCode` (auth,
 *    config, sdk-stdio, the Windows `update` drain) omit `exitCode` entirely.
 *    `main()` hard-exits when `exitCode` is defined; a product shell treats a
 *    zero/undefined `exitCode` as "return, do not exit" so telemetry/finally
 *    blocks always run, then force-exits the finished one-shot command (so a
 *    leaked extension handle cannot keep it alive) unless `drainNaturally` is
 *    set — sdk-stdio's framed host and the win32 `update` teardown must drain
 *    naturally. `--sdk-stdio` reports this kind *after* its framed host has run,
 *    so its byte-exact framing is never routed through the switch.
 *  - `kind: "dispatch"` — everything needed to run a full session mode. The
 *    `appMode` field is the final value (already flipped for piped stdin); the
 *    dispatcher must use it verbatim and never re-resolve it.
 */
export type MainPreparation =
	| { kind: "completed"; exitCode?: number; drainNaturally?: boolean }
	| {
			kind: "dispatch";
			appMode: AppMode;
			runtimeHost: AgentSessionRuntimeHost;
			session: AgentSession;
			modelFallbackMessage: string | undefined;
			settingsManager: SettingsManager;
			resourceLoader: ResourceLoader;
			modelRuntime: ModelRuntime;
			migratedProviders: string[];
			startupDiagnostics: AgentSessionRuntimeDiagnostic[];
			autoTrustOnReloadCwd: string | undefined;
			initialMessage: string | undefined;
			initialImages: ImageContent[] | undefined;
			sessionRoot: string | undefined;
			parsed: Args;
			// Computed here (not raw options) so the dispatcher and an embedding
			// shell build InteractiveMode from the same resolved values pi uses.
			configDirName: string;
			authPath: string | undefined;
	  };

/**
 * Run everything pi's `main()` does before the run-mode `switch`, returning a
 * {@link MainPreparation}. Product shells (apps/cli) call this directly and then
 * own their own dispatch switch, bypassing `main()` so their process-lifecycle
 * bookkeeping (telemetry finally blocks) is never skipped by a `process.exit()`.
 */
export async function prepareMain(args: string[], options?: MainOptions): Promise<MainPreparation> {
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

	if (
		await runAuthCommand(args, options?.authRuntimeSetup, authPath, options?.agentDir, options?.allowedAuthProviders)
	) {
		// runAuthCommand set process.exitCode (0 ready / 1 not_ready / 2 invalid);
		// carry that side effect through the completed result unchanged.
		return { kind: "completed" };
	}

	if (process.platform === "win32") {
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	}

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
			uiHooks: options?.uiHooks,
		})
	) {
		// process.exitCode is typed `number | string | undefined`; handlePackageCommand
		// only ever sets a numeric code, so normalize to a number for the result.
		const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
		if (process.platform === "win32" && exitCode === 0 && args[0] === "update") {
			// Package commands are force-exited by the product shell after its telemetry
			// finally so a bad extension cannot keep a one-shot command alive with a
			// leaked libuv handle. On Windows, Node can assert after fetch() if
			// process.exit(0) runs during teardown, so flag a successful `pi update`
			// to drain naturally instead of being hard-exited.
			// https://github.com/nodejs/node/issues/56645
			return { kind: "completed", drainNaturally: true };
		}
		return { kind: "completed", exitCode };
	}

	if (
		await handleConfigCommand(args, {
			extensionFactories,
			agentDir,
			settingsManagerFactory: options?.settingsManagerFactory,
			configDirName,
			uiHooks: options?.uiHooks,
		})
	) {
		return { kind: "completed" };
	}

	const parsed = parseArgs(args);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			return { kind: "completed", exitCode: 1 };
		}
	}

	if (parsed.version) {
		console.log(VERSION);
		return { kind: "completed", exitCode: 0 };
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			const terminalTheme = detectTerminalBackgroundFromEnv().theme;
			const themeName =
				resolveThemeSetting(
					parsed.useTheme ?? bootstrapSettingsManager.getThemeSetting() ?? options?.defaultTheme,
					terminalTheme,
				) ?? terminalTheme;
			setThemeStorageDir(agentDir);
			result = await exportFromFile(parsed.export, { outputPath, themeName });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			return { kind: "completed", exitCode: 1 };
		}
		console.log(`Exported to: ${result}`);
		return { kind: "completed", exitCode: 0 };
	}

	let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	// A bare --resume opens the interactive session selector (createSessionManager checks
	// parsed.resume before parsed.continue). Without a terminal it can never receive a
	// selection and would hang until killed, so reject it before the picker opens.
	// --resume <path|id> sets parsed.session instead, so non-interactive resume-by-id still works.
	if (parsed.resume && appMode !== "interactive") {
		console.error(
			chalk.red(
				"Error: --resume opens an interactive session selector and needs a terminal. Pass --resume <path|id> to resume a specific session, or --continue to resume the most recent one.",
			),
		);
		return { kind: "completed", exitCode: 1 };
	}
	const shouldTakeOverStdout = appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		return { kind: "completed", exitCode: 1 };
	}

	validateForkFlags(parsed);
	validateSessionIdFlags(parsed);

	// Run migrations (pass cwd for project-local migrations)
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd, {
		agentDir,
		configDirName,
	});

	const startupSettingsManager = createSettingsManager(cwd, agentDir, { configDirName });
	const startupSettingsDiagnostics = collectSettingsDiagnostics(startupSettingsManager);

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
		options?.uiHooks?.selectSession,
	);
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		if (appMode === "interactive") {
			if (!options?.uiHooks?.showStartupSelector) {
				throw new Error(
					"The startup selector (uiHooks.showStartupSelector) is required to resolve a missing session cwd.",
				);
			}
			const selectedCwd = await promptForMissingSessionCwd(
				missingSessionCwdIssue,
				startupSettingsManager,
				options.uiHooks.showStartupSelector,
				{
					agentDir,
					configDirName,
				},
			);
			if (!selectedCwd) {
				return { kind: "completed", exitCode: 0 };
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
			return { kind: "completed", exitCode: 1 };
		}
	}
	if (parsed.name !== undefined) {
		const name = normalizeSessionName(parsed.name);
		if (name === undefined) {
			console.error(chalk.red("Error: --name requires a non-empty value"));
			return { kind: "completed", exitCode: 1 };
		}
		sessionManager.appendSessionInfo(name);
	}

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
		// Asked for every directory, not only those shipping project config. The
		// config is one of two things trust covers; the other is the file contents
		// the agent is about to read, and a hostile file is a prompt-injection
		// vector whether or not the directory also ships a settings.json.
		const shouldResolveProjectTrust = parsed.projectTrustOverride === undefined && cachedProjectTrust === undefined;
		const projectTrusted = shouldResolveProjectTrust
			? false
			: (cachedProjectTrust ?? parsed.projectTrustOverride ?? trustStore.get(cwd) === true);
		const runtimeSettingsManager = createSettingsManager(cwd, agentDir, {
			projectTrusted,
			configDirName,
		});
		if (parsed.contextProjection !== undefined) {
			runtimeSettingsManager.applyOverrides({ compaction: { contextProjection: parsed.contextProjection } });
		}
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelCatalogPath: options?.modelsPath,
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
								// A session reads the directory's files into the model, so the
								// question applies even where there is no project config.
								alwaysAsk: true,
								extensionsResult,
								projectTrustContext:
									projectTrustContext ??
									createProjectTrustContext({
										cwd,
										mode: isInitialRuntime ? trustPromptMode : appMode,
										settingsManager: startupSettingsManager,
										hasUI: isInitialRuntime && trustPromptMode === "interactive",
										paths: { agentDir, configDirName },
										ui: options?.uiHooks
											? {
													showStartupSelector: options.uiHooks.showStartupSelector,
													showStartupInput: options.uiHooks.showStartupInput,
												}
											: undefined,
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
		// The Step catalog is discovered from `{base}/v1/models` and has no built-in
		// baseline. When a Step credential is configured, refresh it from the network
		// before resolving the initial model, so startup finds the account's models
		// instead of reporting "no models available". Best-effort and bounded.
		if (STEP_ENTRYPOINT && modelRuntime.getProviderAuthStatus(STEP_PROVIDER_ID).configured) {
			await modelRuntime
				.refresh({
					allowNetwork: true,
					force: true,
					providers: [STEP_PROVIDER_ID],
					signal: AbortSignal.timeout(15_000),
				})
				.catch(() => {});
		}
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
	let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
	try {
		runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: sessionManager.getCwd(),
			agentDir,
			sessionManager,
			sessionManagerFactory: options?.sessionManagerFactory,
		});
	} catch (error) {
		// Declining trust is a decision, not a failure: leave without a stack
		// trace and without the alternate screen ever being entered.
		if (error instanceof ProjectTrustDeclinedError) return { kind: "completed" };
		throw error;
	}
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
		return { kind: "completed", exitCode: 0 };
	}

	if (parsed.listModels !== undefined) {
		reportDiagnostics(startupSettingsDiagnostics);
		// The one-shot model listing is otherwise cache-only. On the Step
		// entrypoint, when a Step credential is configured, refresh the Step
		// catalog from the network first so it lists the account's real usable
		// models (discovered from `{base}/v1/models`) instead of the built-in
		// baseline. Skipped when logged out so listing stays offline. Best-effort
		// and bounded; on failure the cached/baseline list is shown.
		if (STEP_ENTRYPOINT && modelRuntime.getProviderAuthStatus(STEP_PROVIDER_ID).configured) {
			await modelRuntime
				.refresh({
					allowNetwork: true,
					force: true,
					providers: [STEP_PROVIDER_ID],
					signal: AbortSignal.timeout(15_000),
				})
				.catch(() => {});
		}
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRuntime, searchPattern, AbortSignal.timeout(15_000));
		return { kind: "completed", exitCode: 0 };
	}

	// Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC
	let stdinContent: string | undefined;
	if (appMode !== "rpc") {
		stdinContent = await readPipedStdin();
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
	}

	const { initialMessage, initialImages } = await prepareInitialMessage(
		parsed,
		settingsManager.getImageAutoResize(),
		stdinContent,
	);
	setThemeStorageDir(agentDir);
	initTheme(settingsManager.getTheme() ?? options?.defaultTheme, appMode === "interactive");

	// Show deprecation warnings in interactive mode
	if (appMode === "interactive" && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}
	const startupDiagnostics = deduplicateDiagnostics([...startupSettingsDiagnostics, ...runtime.diagnostics]);
	const hasRuntimeErrors = runtime.diagnostics.some((diagnostic) => diagnostic.type === "error");
	if (appMode !== "interactive" || hasRuntimeErrors) {
		reportDiagnostics(startupDiagnostics);
	}
	if (hasRuntimeErrors) {
		if (runtime.diagnostics.some((diagnostic) => diagnostic.message.includes("Failed to load extension"))) {
			console.error(chalk.yellow(EXTENSION_LOAD_FAILURE_HINT));
		}
		return { kind: "completed", exitCode: 1 };
	}

	if (appMode !== "interactive" && !session.model) {
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		return { kind: "completed", exitCode: 1 };
	}

	if (parsed.sdkStdio) {
		if (!options?.stdioModeFactory) {
			console.error(chalk.red("Error: --sdk-stdio is only available from the step entrypoint"));
			return { kind: "completed", exitCode: 1 };
		}
		// The framed stdio host runs entirely inside the preparation step so its
		// byte-exact length-prefixed protocol is never routed through the dispatch
		// switch (which would risk interleaving diagnostics with frames).
		await options.stdioModeFactory(runtimeHost);
		// The shell must not force-exit this path: the framed host owns its own
		// lifetime and its final length-prefixed frames on stdout must drain naturally.
		return { kind: "completed", drainNaturally: true };
	}

	// RPC refreshes catalogs here in the background; interactive mode starts its refresh after TUI initialization.
	if (!options?.disableBackgroundServices && appMode === "rpc") {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		void modelRuntime
			.refresh({ signal: controller.signal })
			.catch(() => {})
			.finally(() => clearTimeout(timeout));
	}

	return {
		kind: "dispatch",
		appMode,
		runtimeHost,
		session,
		modelFallbackMessage,
		settingsManager,
		resourceLoader,
		modelRuntime,
		migratedProviders,
		startupDiagnostics,
		autoTrustOnReloadCwd,
		initialMessage,
		initialImages,
		sessionRoot,
		parsed,
		configDirName,
		authPath,
	};
}

/**
 * Run the full session mode selected during {@link prepareMain}. This holds the
 * exact `switch (appMode)` pi's `main()` has always run; it is a private helper
 * so `main()` stays a thin `prepare → dispatch` wrapper while product shells run
 * their own dispatch against the returned {@link MainPreparation}.
 */
async function dispatchAppMode(
	prep: Extract<MainPreparation, { kind: "dispatch" }>,
	_options?: MainOptions,
): Promise<void> {
	const { appMode, runtimeHost } = prep;
	if (appMode === "rpc") {
		await runRpcMode(runtimeHost);
	} else if (appMode === "interactive") {
		// The interactive TUI moved to @step-harness/cli (S4-0). coding-agent's own
		// main() no longer dispatches it; product shells construct InteractiveMode
		// from the returned MainPreparation and run their own dispatch switch.
		throw new Error("interactive mode moved to @step-harness/cli; coding-agent main() no longer dispatches the TUI");
	} else {
		const exitCode = await runPrintMode(runtimeHost, {
			mode: toPrintOutputMode(appMode),
			messages: prep.parsed.messages,
			initialMessage: prep.initialMessage,
			initialImages: prep.initialImages,
		});
		stopThemeWatcher();
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
	}
}

/**
 * Entry point kept for embedders and tests: prepare, then dispatch. Short
 * commands that finish inside {@link prepareMain} return here without a session
 * mode. `main()` reproduces pi's historical exit contract for direct callers:
 * any `completed` result with a defined `exitCode` (including an explicit `0`
 * for the short commands that always ran `process.exit(0)`) is applied with
 * `process.exit`, while the soft-return commands (auth/config/sdk-stdio, which
 * only set `process.exitCode`) omit `exitCode` and return without exiting. A
 * product shell instead reads `exitCode` off the result and never hard-exits, so
 * its process-lifecycle bookkeeping is preserved.
 */
export async function main(args: string[], options?: MainOptions): Promise<void> {
	const prep = await prepareMain(args, options);
	if (prep.kind === "completed") {
		if (prep.exitCode !== undefined) {
			process.exit(prep.exitCode);
		}
		return;
	}
	await dispatchAppMode(prep, options);
}
