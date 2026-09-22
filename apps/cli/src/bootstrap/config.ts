import {
	loadStepCodeConfig,
	readGlobalStepDefaults,
	type StepCodeConfig,
	type StepGlobalDefaults,
} from "@step-harness/coding-agent";
import { showDeprecationWarnings } from "@step-harness/config";

/**
 * Bootstrap step 2: load configuration.
 *
 * Step's only configuration file is `config.toml`; `models.json` and `auth.json`
 * remain JSON but hold model definitions and credentials, not settings. Runs
 * after stdout capture (step 1) and before telemetry (step 3), because the
 * persisted telemetry defaults have to be visible before telemetry is built.
 */

// Re-export the product-neutral deprecation surface so this bootstrap module has
// a first-class dependency on @step-harness/config (the shared config package),
// per the step-3 assembly contract.
export { showDeprecationWarnings };

export interface StepStartupConfig {
	persistedDefaults: StepGlobalDefaults;
	stepCodeConfig: StepCodeConfig | undefined;
}

/**
 * Read persisted defaults and the stepcode config.
 *
 * A stale Step endpoint left in models.json by an older release needs no pass
 * here: the Step provider's `normalizeModels` hook restores the dialect and the
 * canonical endpoint for built-in ids on every launch, so the request path is
 * already protected without rewriting the user's file.
 */
export async function loadStepStartupConfig(): Promise<StepStartupConfig> {
	const persistedDefaults = readGlobalStepDefaults();
	const stepCodeConfig = await loadStepCodeConfig();
	return { persistedDefaults, stepCodeConfig };
}
