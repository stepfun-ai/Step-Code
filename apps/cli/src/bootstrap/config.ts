import { join } from "node:path";
import {
	canonicalStepBaseUrl,
	loadStepCodeConfig,
	normalizeStepModelsFile,
	readGlobalStepDefaults,
	resolveStepAgentDir,
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
	/** Warnings from the models.json endpoint repair, surfaced without blocking. */
	warnings: string[];
}

/** Read persisted defaults and the stepcode config, repairing a stale endpoint. */
export async function loadStepStartupConfig(): Promise<StepStartupConfig> {
	const warnings: string[] = [];
	// An older release could persist a Step endpoint that no longer answers.
	// Repair it before the model runtime reads the catalog; the pass writes
	// nothing when the file is already canonical.
	await normalizeStepModelsFile(join(resolveStepAgentDir(), "models.json"), warnings, canonicalStepBaseUrl());
	const persistedDefaults = readGlobalStepDefaults();
	const stepCodeConfig = await loadStepCodeConfig();
	return { persistedDefaults, stepCodeConfig, warnings };
}
