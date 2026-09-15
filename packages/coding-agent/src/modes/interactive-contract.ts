/**
 * Type-only contract for the interactive terminal UI.
 *
 * The interactive UI (InteractiveMode, the startup selectors and the config
 * selector) lives in the product shell (`@step-harness/cli`), but this product
 * package still needs to *describe* it: `MainOptions.interactiveModeOptions`
 * carries a `Pick<InteractiveModeOptions, …>`, and `prepareMain` receives the
 * startup selectors as an injected {@link StartupUiHooks} bag so the coding
 * agent never imports the shell (which would be a reverse dependency).
 *
 * Every field type referenced here is resident in this package or in pi-ai, so
 * this is a clean type split from the moved sources — not a rewrite. The shell's
 * moved UI re-imports these types from the `.` barrel.
 */

import type { ImageContent } from "@step-harness/providers/compat";
import type { AgentSessionRuntimeDiagnostic } from "./../core/agent-session-services.ts";
import type { ExtensionUIContext } from "./../core/extensions/index.ts";
import type { ResolvedPaths } from "./../core/package-manager.ts";
import type { SessionInfo, SessionListProgress } from "./../core/session-manager.ts";
import type { SettingsManager, TuiMode } from "./../core/settings-manager.ts";
import type { StepLoginHost, StepLoginOutcome } from "./../step/login-flow.ts";

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Project resource directory name for this runtime instance. */
	configDirName?: string;
	/** Credential path used by the active product runtime (for status text). */
	authPath?: string;
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Diagnostics collected before the interactive TUI was initialized. */
	startupDiagnostics?: AgentSessionRuntimeDiagnostic[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Cwd to trust after reload if it gained a .pi directory during this implicitly trusted session. */
	autoTrustOnReloadCwd?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
	/** TUI layout mode. */
	tuiMode?: TuiMode;
	/** Initial interactive theme setting for this invocation. */
	initialThemeSetting?: string;
	/** Fallback theme when no saved setting or explicit theme was supplied. */
	defaultTheme?: string;
	/** Skip optional network, catalog, update, and install telemetry services. */
	disableBackgroundServices?: boolean;
	/** Whether to show the package changelog on startup. Defaults to true. */
	showChangelog?: boolean;
	/** Product presentation variant for the native interactive surface. */
	tuiStyle?: "native" | "step";
	/** Root used by the product session selector when listing all workspaces. */
	sessionRoot?: string;
	/**
	 * Provider to offer during a fresh interactive startup when no credential is
	 * configured. The login itself continues through Pi's native selector/dialog.
	 */
	startupLoginProvider?: string;
	/** Force the startup provider login even when a credential is already stored. */
	forceStartupLogin?: boolean;
	/** Return after the one-shot startup login flow (used by `step login`). */
	exitAfterStartupLogin?: boolean;
	/** Skip optional fd/rg installation for auth-only command surfaces. */
	skipManagedTools?: boolean;
	/** Restrict login/logout selectors to product-owned providers when set. */
	allowedAuthProviders?: readonly string[];
	/** Shared Step onboarding flow used by the Step-only login surfaces. */
	stepLogin?: (host: StepLoginHost) => Promise<StepLoginOutcome>;
	/** Shared Step logout flow used by the Step-only TUI command. */
	stepLogout?: () => Promise<{ removed: boolean; remainingSource?: string | null }>;
	/**
	 * Product startup hook. Returning false stops the interactive loop after the
	 * hook has completed (used by a self-update that has relaunched the binary).
	 */
	onStartup?: (context: InteractiveStartupContext) => Promise<boolean | undefined>;
	/** Best-effort notification after a credential has been persisted. */
	onCredentialAuthenticated?: (details: { providerId: string; uid?: string }) => void;
	/**
	 * Product default model used after a provider login.  Pi's built-in
	 * provider catalog supplies defaults for its known providers; product
	 * providers such as Step can supply the same policy without coupling this
	 * interactive layer to their extension module.
	 */
	defaultModelForProvider?: (providerId: string) => string | undefined;
}

export interface InteractiveStartupContext {
	/** Native Pi-backed extension UI methods. */
	ui: ExtensionUIContext;
	/** Stop the renderer and detach terminal input handlers. */
	stop: () => void;
	/** Dispose the active runtime/session. */
	dispose: () => Promise<void>;
}

/** Product/agent directory context threaded into the startup selectors. */
export interface StartupTuiPathOptions {
	agentDir?: string;
	configDirName?: string;
}

/** Loader used by the session selector to fetch a list of sessions. */
export type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

/** Resolved package paths per write scope, as consumed by the config selector. */
export type ScopedResolvedPaths = Record<"global" | "project", ResolvedPaths>;

/** Options passed to the `config` command TUI selector. */
export interface ConfigSelectorOptions {
	resolvedPaths: ScopedResolvedPaths;
	settingsManager: SettingsManager;
	cwd: string;
	agentDir: string;
	configDirName?: string;
	writeScope: "global" | "project";
	projectModeAvailable: boolean;
}

/**
 * Startup UI selectors injected into `prepareMain`/package-command runtime so
 * this package can drive them without importing the shell that owns them.
 * All five are pure side-effect / pure-decision entry points.
 */
export interface StartupUiHooks {
	/** `--resume` session selector. Returns the chosen path or null if cancelled. */
	selectSession(
		currentSessionsLoader: SessionsLoader,
		allSessionsLoader: SessionsLoader,
		settingsManager: SettingsManager,
		paths?: StartupTuiPathOptions,
	): Promise<string | null>;
	/** First-time setup dialog; persists the result on the given settings manager. */
	showFirstTimeSetup(settingsManager: SettingsManager, paths?: StartupTuiPathOptions): Promise<void>;
	/** `config` command TUI selector. */
	selectConfig(options: ConfigSelectorOptions): Promise<void>;
	/** Generic startup single-select used for missing-cwd and project-trust prompts. */
	showStartupSelector<T>(
		settingsManager: SettingsManager,
		title: string,
		options: Array<{ label: string; value: T }>,
		paths?: StartupTuiPathOptions,
	): Promise<T | undefined>;
	/** Generic startup text input used for project-trust prompts. */
	showStartupInput(
		settingsManager: SettingsManager,
		title: string,
		placeholder?: string,
		paths?: StartupTuiPathOptions,
	): Promise<string | undefined>;
}
