import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { STEP_DEFAULT_MODEL, STEP_DEFAULT_PROVIDER, STEP_DEFAULT_THEME } from "./defaults.ts";

/** Canonical project directory for StepCode state and resources. */
export const STEPCODE_CONFIG_DIR = ".stepcode";

/** Directory used by releases before the product rename. */
export const LEGACY_RENAMED_CONFIG_DIR = ".step-harness";

/**
 * Optional path overrides for hosts that embed the Step facade instead of
 * launching the `step` executable.  The executable uses the environment
 * derived defaults; embedded callers can still make the same paths explicit
 * without reaching into Pi's implementation.
 */
export interface StepEnvironmentOptions {
	configDir?: string;
	agentDir?: string;
	/** Set to `null` to clear an inherited session override. */
	sessionDir?: string | null;
}

/** Resolve a home directory from an injected environment when one is supplied. */
export function resolveStepHomeDir(env: Record<string, string | undefined> = process.env): string {
	return env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
}

/** Resolve the canonical project directory. */
export function resolveStepConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.STEPCODE_CONFIG_DIR?.trim() || STEPCODE_CONFIG_DIR;
}

/** Resolve the product's global agent directory. */
export function resolveStepAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.STEP_CODING_AGENT_DIR?.trim() || join(resolveStepHomeDir(env), resolveStepConfigDir(env), "agent");
}

/**
 * Resolve the directory that holds `config.toml`, `auth.json` and
 * `models.json`. These sit next to the agent directory, not inside it.
 *
 * Resolve the agent directory to an absolute path before taking its parent.
 * Appending `".."` is textual, so a relative `STEP_CODING_AGENT_DIR` would
 * place credentials beside the process's working directory instead, and the
 * resolved location would move again if the process later changed directory.
 */
export function resolveStepConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.STEP_CODING_AGENT_DIR?.trim();
	if (!override) return join(resolveStepHomeDir(env), resolveStepConfigDir(env));
	const agentDir = resolve(override);
	const parent = dirname(agentDir);
	// A filesystem root has no sibling directory to hold these files. Keep them
	// inside the agent directory rather than writing credentials outside the
	// namespace the host asked for.
	return parent === agentDir ? agentDir : parent;
}

/** Resolve the product's session directory. */
export function resolveStepSessionDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.STEP_CODING_AGENT_SESSION_DIR?.trim() || join(resolveStepAgentDir(env), "sessions");
}

/** Return an explicitly configured session root, if one was supplied. */
export function getStepSessionDirOverride(env: Record<string, string | undefined> = process.env): string | undefined {
	return env.STEP_CODING_AGENT_SESSION_DIR?.trim();
}

/**
 * Identify a Step launcher before the rest of coding-agent/config.ts is
 * evaluated. This is needed because ESM evaluates static dependencies before
 * the entry module body, so the Step entry module cannot set these variables itself in
 * time for config constants.
 */
export function isStepEntrypoint(argv: readonly string[] = process.argv): boolean {
	const candidates = [argv[1], argv[0], process.execPath];
	if (
		candidates.some((candidate) => {
			const entry = basename(candidate ?? "").toLowerCase();
			return /^(?:step|stepcode|step-bin)(?:\.(?:[cm]?js|ts|exe))?$/u.test(entry);
		})
	)
		return true;
	// Development launches commonly use `tsx` with the Step entry script, where the script
	// path is argv[2] rather than argv[1]. Only accept an explicit Step script
	// filename so a normal pi prompt containing the word "step" cannot opt into
	// the product's storage namespace by accident.
	const script = argv[2] ?? "";
	return /(?:^|[\\/])(?:step|stepcode)\.(?:[cm]?js|ts)$/iu.test(script);
}

/**
 * Return whether a caller has explicitly selected the Step storage namespace.
 *
 * The executable path is the strongest signal, but Step's SDK/embedder APIs do
 * not necessarily run under a binary named `step`.  In that case an explicit
 * Step agent-directory override (or the value written by applyStepEnvironment)
 * is enough to opt native helpers into the same namespace.  We intentionally do
 * not treat a bare STEPCODE_APP_NAME/CONFIG_DIR override as a signal: ordinary
 * Pi callers may inherit those presentation variables from a parent shell.
 */
export function isStepStorageContext(env: Record<string, string | undefined> = process.env): boolean {
	return (
		isStepEntrypoint() || env.AI_AGENT?.trim().toLowerCase() === "step" || Boolean(env.STEP_CODING_AGENT_DIR?.trim())
	);
}

/** Apply Step's product defaults. Safe to call more than once. */
export function applyStepEnvironment(env: NodeJS.ProcessEnv = process.env, options: StepEnvironmentOptions = {}): void {
	if (!env.STEPCODE_APP_NAME?.trim()) env.STEPCODE_APP_NAME = "step";
	const configDir = options.configDir?.trim() || env.STEPCODE_CONFIG_DIR?.trim() || STEPCODE_CONFIG_DIR;
	// Keep the canonical StepCode variable populated. Blank values must not
	// leak through to config.ts, where they would otherwise expose Pi's `.pi`
	// package fallback.
	env.STEPCODE_CONFIG_DIR = configDir;
	if (!env.STEPCODE_DEFAULT_THEME?.trim()) env.STEPCODE_DEFAULT_THEME = STEP_DEFAULT_THEME;
	const agentDir =
		options.agentDir?.trim() ||
		env.STEP_CODING_AGENT_DIR?.trim() ||
		join(resolveStepHomeDir(env), configDir, "agent");
	env.STEP_CODING_AGENT_DIR = agentDir;
	// Keep an explicit session override available. When neither is supplied, leave it
	// unset so the
	// caller can use Pi's native `agentDir/sessions/<cwd>` default. The
	// explicit value remains process-local.
	const sessionDir =
		options.sessionDir === null ? "" : options.sessionDir?.trim() || env.STEP_CODING_AGENT_SESSION_DIR?.trim() || "";
	if (sessionDir) {
		env.STEP_CODING_AGENT_SESSION_DIR = sessionDir;
	} else {
		delete env.STEP_CODING_AGENT_SESSION_DIR;
	}
	if (!env.STEPCODE_DEFAULT_PROVIDER?.trim()) {
		env.STEPCODE_DEFAULT_PROVIDER = env.STEP_PROVIDER?.trim() || STEP_DEFAULT_PROVIDER;
	}
	if (!env.STEPCODE_DEFAULT_MODEL?.trim()) {
		env.STEPCODE_DEFAULT_MODEL = env.STEP_MODEL?.trim() || STEP_DEFAULT_MODEL;
	}
	// Downstream attribution marker sent as `x-step-client`. Keep it overridable
	// so an embedding host can identify itself, but default shipped StepCode
	// requests to `stepcode`.
	if (!env.STEP_CLIENT?.trim()) env.STEP_CLIENT = "stepcode";
	// Step should not contact Pi's release/install services unless explicitly
	// opted in by setting STEPCODE_DISABLE_PI_SERVICES to a false value.
	if (!env.STEPCODE_DISABLE_PI_SERVICES?.trim()) env.STEPCODE_DISABLE_PI_SERVICES = "1";
	env.AI_AGENT = "step";
}
