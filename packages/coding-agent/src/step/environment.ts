import { homedir } from "node:os";
import { basename, join } from "node:path";
import { STEP_DEFAULT_MODEL, STEP_DEFAULT_PROVIDER } from "./defaults.ts";

/** Product-owned project directory for Step Harness state and resources. */
export const STEP_HARNESS_CONFIG_DIR = ".step-harness";

/** Previous Step CLI project directory, retained only as a migration source. */
export const LEGACY_STEP_CONFIG_DIR = ".step-cli";

interface AppliedStepEnvironment {
	configDir: string;
	agentDir: string;
	sessionDir?: string;
}

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

// `applyStepEnvironment` is intentionally idempotent, but callers sometimes
// update one of the old STEP_CLI_* aliases between calls. Remember the values
// we populated so a later explicit change to either spelling can be detected
// without allowing a stale alias to override a newly supplied STEP_HARNESS_*.
const appliedEnvironments = new WeakMap<NodeJS.ProcessEnv, AppliedStepEnvironment>();

function chooseAliasedValue(
	canonical: string | undefined,
	legacy: string | undefined,
	fallback: string,
	previous: string | undefined,
): string {
	const canonicalValue = canonical?.trim();
	const legacyValue = legacy?.trim();
	if (previous !== undefined) {
		const canonicalChanged = canonicalValue !== previous;
		const legacyChanged = legacyValue !== previous;
		if (canonicalChanged && !legacyChanged) return canonicalValue || fallback;
		if (legacyChanged && !canonicalChanged) return legacyValue || fallback;
	}
	return canonicalValue || legacyValue || fallback;
}

/** Resolve the project directory while accepting the pre-rename override. */
export function resolveStepConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.STEP_HARNESS_CONFIG_DIR?.trim() || env.STEP_CLI_CONFIG_DIR?.trim() || STEP_HARNESS_CONFIG_DIR;
}

/** Resolve the product's global agent directory. */
export function resolveStepAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.STEP_HARNESS_CODING_AGENT_DIR?.trim() ||
		env.STEP_CODING_AGENT_DIR?.trim() ||
		join(resolveStepHomeDir(env), resolveStepConfigDir(env), "agent")
	);
}

/** Resolve the product's session directory. */
export function resolveStepSessionDir(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.STEP_HARNESS_CODING_AGENT_SESSION_DIR?.trim() ||
		env.STEP_CODING_AGENT_SESSION_DIR?.trim() ||
		join(resolveStepAgentDir(env), "sessions")
	);
}

/** Return an explicitly configured session root, if one was supplied. */
export function getStepSessionDirOverride(env: Record<string, string | undefined> = process.env): string | undefined {
	return env.STEP_HARNESS_CODING_AGENT_SESSION_DIR?.trim() || env.STEP_CODING_AGENT_SESSION_DIR?.trim();
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
			return /^(?:step|step-cli|step-bin|step-harness)(?:\.(?:[cm]?js|ts|exe))?$/u.test(entry);
		})
	)
		return true;
	// Development launches commonly use `tsx` with the Step entry script, where the script
	// path is argv[2] rather than argv[1]. Only accept an explicit Step script
	// filename so a normal pi prompt containing the word "step" cannot opt into
	// the product's storage namespace by accident.
	const script = argv[2] ?? "";
	return /(?:^|[\\/])step(?:-cli)?\.(?:[cm]?js|ts)$/iu.test(script);
}

/**
 * Return whether a caller has explicitly selected the Step storage namespace.
 *
 * The executable path is the strongest signal, but Step's SDK/embedder APIs do
 * not necessarily run under a binary named `step`.  In that case an explicit
 * Step agent-directory override (or the value written by applyStepEnvironment)
 * is enough to opt native helpers into the same namespace.  We intentionally do
 * not treat a bare STEP_CLI_APP_NAME/CONFIG_DIR override as a signal: ordinary
 * Pi callers may inherit those presentation variables from a parent shell.
 */
export function isStepStorageContext(env: Record<string, string | undefined> = process.env): boolean {
	return (
		isStepEntrypoint() ||
		env.AI_AGENT?.trim().toLowerCase() === "step" ||
		Boolean(env.STEP_HARNESS_CODING_AGENT_DIR?.trim() || env.STEP_CODING_AGENT_DIR?.trim())
	);
}

/** Apply Step's product defaults. Safe to call more than once. */
export function applyStepEnvironment(env: NodeJS.ProcessEnv = process.env, options: StepEnvironmentOptions = {}): void {
	if (!env.STEP_CLI_APP_NAME?.trim()) env.STEP_CLI_APP_NAME = "step";
	const previous = appliedEnvironments.get(env);
	const configDir =
		options.configDir?.trim() ||
		chooseAliasedValue(
			env.STEP_HARNESS_CONFIG_DIR,
			env.STEP_CLI_CONFIG_DIR,
			STEP_HARNESS_CONFIG_DIR,
			previous?.configDir,
		);
	// Keep both spellings available to older callers, but let the renamed
	// STEP_HARNESS_* variables win when both are present. Blank values must not
	// leak through to config.ts, where they would otherwise expose Pi's `.pi`
	// package fallback.
	env.STEP_CLI_CONFIG_DIR = configDir;
	env.STEP_HARNESS_CONFIG_DIR = configDir;
	if (!env.STEP_CLI_DEFAULT_THEME?.trim()) env.STEP_CLI_DEFAULT_THEME = "step";
	const agentDir =
		options.agentDir?.trim() ||
		chooseAliasedValue(
			env.STEP_HARNESS_CODING_AGENT_DIR,
			env.STEP_CODING_AGENT_DIR,
			join(resolveStepHomeDir(env), configDir, "agent"),
			previous?.agentDir,
		);
	env.STEP_CODING_AGENT_DIR = agentDir;
	env.STEP_HARNESS_CODING_AGENT_DIR = agentDir;
	// A few Pi infrastructure surfaces (notably pi-tui's fallback log path)
	// still read the historical PI_CODING_AGENT_DIR variable directly instead
	// of going through coding-agent/config.ts. Mirror the resolved Step root for
	// those surfaces so an embedded Step host cannot silently create ~/.pi
	// state. This is scoped to the Step environment object; ordinary Pi launches
	// never call this function and retain their native default.
	env.PI_CODING_AGENT_DIR = agentDir;
	// Keep an explicit session override available through both the renamed and
	// legacy spellings. When neither is supplied, leave both unset so the
	// caller can use Pi's native `agentDir/sessions/<cwd>` default. The
	// previous value lets us distinguish a later explicit alias change from the
	// mirrored value that this function wrote on an earlier call.
	const sessionDir =
		options.sessionDir === null
			? ""
			: options.sessionDir?.trim() ||
				chooseAliasedValue(
					env.STEP_HARNESS_CODING_AGENT_SESSION_DIR,
					env.STEP_CODING_AGENT_SESSION_DIR,
					"",
					previous?.sessionDir,
				);
	if (sessionDir) {
		env.STEP_CODING_AGENT_SESSION_DIR = sessionDir;
		env.STEP_HARNESS_CODING_AGENT_SESSION_DIR = sessionDir;
	} else {
		delete env.STEP_CODING_AGENT_SESSION_DIR;
		delete env.STEP_HARNESS_CODING_AGENT_SESSION_DIR;
	}
	if (!env.STEP_CLI_DEFAULT_PROVIDER?.trim()) {
		env.STEP_CLI_DEFAULT_PROVIDER = env.STEP_PROVIDER?.trim() || STEP_DEFAULT_PROVIDER;
	}
	if (!env.STEP_CLI_DEFAULT_MODEL?.trim()) {
		env.STEP_CLI_DEFAULT_MODEL = env.STEP_MODEL?.trim() || STEP_DEFAULT_MODEL;
	}
	// Step should not contact Pi's release/install services unless explicitly
	// opted in by setting STEP_CLI_DISABLE_PI_SERVICES to a false value.
	if (!env.STEP_CLI_DISABLE_PI_SERVICES?.trim()) env.STEP_CLI_DISABLE_PI_SERVICES = "1";
	env.PI_CODING_AGENT = "true";
	env.AI_AGENT = "step";
	appliedEnvironments.set(env, { configDir, agentDir, sessionDir });
}
