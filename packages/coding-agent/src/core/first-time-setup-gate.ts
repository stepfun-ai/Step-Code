import { existsSync } from "fs";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, getSettingsPath, PACKAGE_NAME } from "../config.ts";
import { areExperimentalFeaturesEnabled } from "./experimental.ts";

const OFFICIAL_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const OFFICIAL_APP_NAME = "pi";
const OFFICIAL_CONFIG_DIR_NAME = ".pi";

function isOfficialDistribution(): boolean {
	return (
		PACKAGE_NAME === OFFICIAL_PACKAGE_NAME &&
		APP_NAME === OFFICIAL_APP_NAME &&
		CONFIG_DIR_NAME === OFFICIAL_CONFIG_DIR_NAME
	);
}

/**
 * First-time setup runs when all of these hold:
 * - this is the official Pi distribution (not a fork/rebrand)
 * - experimental features are enabled (PI_EXPERIMENTAL=1)
 * - the default agent directory is used (no custom agent dir override)
 * - setup was not completed before (settings.json does not exist)
 *
 * This is a UI-free predicate: the interactive first-time-setup dialog it gates
 * lives in the product shell, but the trigger semantics stay here so
 * `prepareMain` can decide without importing the shell. The distribution
 * constants are imported from `../config.ts` (rather than read as module-local
 * consts) so tests can fake a forked distribution by mocking that module.
 */
export function shouldRunFirstTimeSetup(settingsPath: string = getSettingsPath()): boolean {
	if (!isOfficialDistribution()) {
		return false;
	}
	if (!areExperimentalFeaturesEnabled()) {
		return false;
	}
	if (process.env[ENV_AGENT_DIR]) {
		return false;
	}
	return !existsSync(settingsPath);
}
