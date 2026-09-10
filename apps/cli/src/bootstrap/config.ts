import {
	loadStepCodeConfig,
	migrateStepConfig,
	readStepGlobalDefaults,
	type StepCodeConfig,
	type StepConfigMigrationReport,
} from "@earendil-works/pi-coding-agent";
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

/** Migrate legacy config, then read persisted defaults and the stepcode config. */
export async function loadStepStartupConfig(): Promise<StepStartupConfig> {
	const migration = await migrateStepConfig();
	const persistedDefaults = await readStepGlobalDefaults();
	const stepCodeConfig = await loadStepCodeConfig();
	return { migration, persistedDefaults, stepCodeConfig };
}
