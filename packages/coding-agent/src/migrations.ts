/**
 * Startup migrations wrapper.
 *
 * The migration mechanics now live in `@step-harness/config`. This module keeps
 * the coding-agent public surface (`runMigrations`, `showDeprecationWarnings`,
 * `migrateAuthToAuthJson`, `migrateSessionsFromAgentRoot`, `MigrationPathOptions`)
 * unchanged while supplying the Step-specific defaults (storage context / agent
 * directory / config directory) and the keybindings migrator by injection.
 */

import {
	migrateAuthToAuthJson as migrateAuthToAuthJsonCore,
	migrateSessionsFromAgentRoot as migrateSessionsFromAgentRootCore,
	runMigrations as runMigrationsCore,
	showDeprecationWarnings,
} from "@step-harness/config";
import { CONFIG_DIR_NAME, getAgentDir } from "./config.ts";
import { migrateKeybindingsConfig } from "./core/keybindings.ts";
import { isStepStorageContext, resolveStepAgentDir } from "./step/environment.ts";

export { showDeprecationWarnings };

export interface MigrationPathOptions {
	agentDir?: string;
	configDirName?: string;
}

/** Resolve the runtime agent directory the same way every migration used to. */
function resolveAgentDir(options: MigrationPathOptions): string {
	return options.agentDir ?? (isStepStorageContext() ? resolveStepAgentDir() : getAgentDir());
}

/**
 * Migrate legacy oauth.json and settings.json apiKeys to auth.json.
 *
 * @returns Array of provider names that were migrated
 */
export function migrateAuthToAuthJson(options: MigrationPathOptions = {}): string[] {
	return migrateAuthToAuthJsonCore(resolveAgentDir(options));
}

/**
 * Migrate sessions from the agent root to proper session directories.
 */
export function migrateSessionsFromAgentRoot(options: MigrationPathOptions = {}): void {
	migrateSessionsFromAgentRootCore(resolveAgentDir(options));
}

/**
 * Run all migrations. Called once on startup.
 *
 * @returns Object with migration results and deprecation warnings
 */
export function runMigrations(
	cwd: string,
	options: MigrationPathOptions = {},
): {
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
} {
	return runMigrationsCore(cwd, {
		agentDir: resolveAgentDir(options),
		configDirName: options.configDirName?.trim() || CONFIG_DIR_NAME,
		migrateKeybindings: migrateKeybindingsConfig,
	});
}
