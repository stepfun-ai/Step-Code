import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { applyStepEnvironment, isStepEntrypoint, STEPCODE_CONFIG_DIR } from "./step/environment.ts";
import { STEPCODE_VERSION } from "./step/version.ts";
import { normalizePath } from "./utils/paths.ts";
import { stripBom } from "./utils/text.ts";

// This runs while config's static dependency graph is being evaluated, before
// APP_NAME and CONFIG_DIR_NAME are derived below. It keeps the Step launcher
// compatible with ordinary static imports and bundled entrypoints alike.
//
// The @step-harness/cli entry file is named main.ts, so it is not detected by
// isStepEntrypoint()'s filename heuristic. That app sets STEPCODE_ENTRYPOINT=1
// as its very first side effect (before this module is evaluated), which is an
// explicit, additive opt-in signal. Ordinary `pi` launches never set it.
export const STEP_ENTRYPOINT = isStepEntrypoint() || process.env.STEPCODE_ENTRYPOINT?.trim() === "1";
if (STEP_ENTRYPOINT) applyStepEnvironment();
/**
 * Whether this process was launched through the Step entrypoint. Decided once,
 * independently of the display name so branding cannot enable entrypoint-only
 * commands or change storage defaults.
 */
export const IS_STEP_ENTRYPOINT: boolean = STEP_ENTRYPOINT;

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js and tsx: returns the package root containing package.json
 * - Ignores Bun binary metadata copied into dist/ when the package root is available
 */
export function findNodePackageDir(startDir: string): string {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			const parent = dirname(dir);
			// build:binary places Bun's metadata inside dist/. Node still needs the
			// package root so its dist-relative asset paths do not become dist/dist/.
			if (basename(dir) === "dist" && existsSync(join(parent, "package.json"))) {
				return parent;
			}
			return dir;
		}
		dir = dirname(dir);
	}
	return startDir;
}

export function getPackageDir(): string {
	if (isBunBinary) {
		// Bun binary: process.execPath points to the compiled executable
		return dirname(process.execPath);
	}
	return findNodePackageDir(__dirname);
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/theme/
 * - For tsx (src/): src/theme/
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	// Theme is in theme/ relative to src/ or dist/
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "theme");
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to README.md */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/assets/
 * - For tsx (src/): src/modes/interactive/assets/
 */
export function getInteractiveAssetsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "assets");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "assets");
}

/** Get path to a bundled interactive asset */
export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}

// =============================================================================
// App Config (from package.json piConfig)
// =============================================================================

interface PackageJson {
	name?: string;
	version?: string;
	piConfig?: {
		name?: string;
		configDir?: string;
	};
}

let pkg: PackageJson = {};
try {
	pkg = JSON.parse(stripBom(readFileSync(getPackageJsonPath(), "utf-8"))) as PackageJson;
} catch (e: unknown) {
	const err = e as NodeJS.ErrnoException;
	if (err.code !== "ENOENT") throw e;
}

// Step product overrides for the app display name, project config directory,
// and version identity apply only to the Step entrypoint. STEP_CODING_AGENT_DIR
// and STEP_CODING_AGENT_SESSION_DIR remain shared with ordinary `pi` invocations.
const configuredProductName = STEP_ENTRYPOINT ? process.env.STEPCODE_APP_NAME?.trim() : undefined;
const configuredAppName: string | undefined = configuredProductName || pkg.piConfig?.name;
export const PACKAGE_NAME: string = pkg.name || "@step-harness/coding-agent";
export const APP_NAME: string = configuredAppName || "step";
export const APP_TITLE: string = APP_NAME;
// Rebranded distributions can select their project resource directory without
// changing the package metadata used by the upstream `pi` entrypoint. Step
// StepCode uses `.stepcode`; the launcher also imports files left by older
// releases before Pi's managers read the directory.
const configuredStepConfigDir = STEP_ENTRYPOINT ? process.env.STEPCODE_CONFIG_DIR?.trim() : undefined;
export const CONFIG_DIR_NAME: string =
	configuredStepConfigDir || (STEP_ENTRYPOINT ? STEPCODE_CONFIG_DIR : pkg.piConfig?.configDir || ".pi");
// `step` is a product facade over the upstream Pi package. Keep the native Pi
// version for ordinary `pi` invocations, but expose the Step release identity
// everywhere the Step entrypoint consumes this constant (CLI flags, TUI and
// SDK metadata).
export const VERSION: string = STEP_ENTRYPOINT ? STEPCODE_VERSION.value : pkg.version || "0.0.0";

export const ENV_AGENT_DIR = "STEP_CODING_AGENT_DIR";
export const ENV_SESSION_DIR = "STEP_CODING_AGENT_SESSION_DIR";

export function expandTildePath(path: string): string {
	return normalizePath(path);
}

// =============================================================================
// User Config Paths (<config-dir>/agent/*)
// =============================================================================

/** Get the agent config directory (for example, ~/.pi/agent/ or ~/.stepcode/agent/) */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR]?.trim();
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to prompt templates directory */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
