import {
	loadStepCodeConfig,
	migrateStepConfig,
	readGlobalStepDefaults,
	readStepGlobalDefaults,
	type StepCodeConfig,
	type StepConfigMigrationReport,
} from "@step-harness/coding-agent";
import { showDeprecationWarnings } from "@step-harness/config";

/**
 * Bootstrap step 2: load + migrate configuration.
 *
 * The product-neutral migration format/loader/runner lives in
 * `@step-harness/config` (imported here directly); the Step-specific projection
 * of legacy files is applied by the coding-agent product package. Runs after
 * stdout capture (step 1) and before telemetry (step 3): migration must finish
 * before telemetry, device identity, or pi's SettingsManager create canonical
 * files.
 */

// Re-export the product-neutral deprecation surface so this bootstrap module has
// a first-class dependency on @step-harness/config (the shared config package),
// per the step-3 assembly contract.
export { showDeprecationWarnings };

export type StepPersistedStartupDefaults = Awaited<ReturnType<typeof readStepGlobalDefaults>>;

export interface StepStartupConfig {
	migration: StepConfigMigrationReport;
	persistedDefaults: StepPersistedStartupDefaults;
	stepCodeConfig: StepCodeConfig | undefined;
}

/**
 * Migrate legacy config, then read persisted defaults and the stepcode config.
 *
 * Two files can carry a persisted default. `config.toml` is the Step CLI's own
 * configuration and is authoritative; `settings.json` is pi's native file and
 * is what the legacy migration writes into. Reading only one of them loses a
 * user: someone who edited `config.toml` would silently keep running the old
 * `settings.json` model, and someone who has only ever been migrated from the
 * pre-pi layout would have no defaults at all. So the TOML value wins per
 * field, and the JSON value fills the gaps.
 */
export async function loadStepStartupConfig(): Promise<StepStartupConfig> {
	const migration = await migrateStepConfig();
	const nativeDefaults = await readStepGlobalDefaults();
	const tomlDefaults = readGlobalStepDefaults();
	const persistedDefaults: StepPersistedStartupDefaults = {
		...nativeDefaults,
		...(tomlDefaults.provider ? { provider: tomlDefaults.provider } : undefined),
		...(tomlDefaults.model ? { model: tomlDefaults.model } : undefined),
		...(nativeDefaults.telemetry || tomlDefaults.telemetry
			? { telemetry: { ...nativeDefaults.telemetry, ...tomlDefaults.telemetry } }
			: undefined),
	};
	const stepCodeConfig = await loadStepCodeConfig();
	return { migration, persistedDefaults, stepCodeConfig };
}
