/**
 * Bootstrap step 5: the single, static extension registration point.
 *
 * Every Step extension the product mounts is listed here in one place — a
 * static array, never a directory scan — so the composition root (main.ts) and
 * ch5's contract agree on exactly what runs. main.ts owns the runtime
 * dependencies (telemetry, settings, identity, permission policy) and passes
 * them in; this module owns the list and its order.
 */
import {
	createStepCapabilitiesExtensionInline,
	createStepCronExtension,
	createStepExtensionInline,
	createStepGoalExtension,
	type InlineExtension,
	type StepExtensionOptions,
	type StepTelemetryReporter,
	type TraceHeaderPolicy,
} from "@step-harness/coding-agent";

export interface StepExtensionFactoryDeps {
	/** Shared telemetry runtime handed to every Step extension. */
	telemetry: StepTelemetryReporter;
	traceHeaderPolicy: TraceHeaderPolicy;
	/** Accessor for the live Step settings manager (policy restore/persist). */
	stepSettings: StepExtensionOptions["stepSettings"];
	/** Account identity resolved lazily when `/feedback` is invoked. */
	feedbackIdentity: StepExtensionOptions["feedbackIdentity"];
	/** Initial Step permission policy parsed from CLI/runtime options. */
	permission: StepExtensionOptions["permission"];
	/** Optional StepCode provider extension, present only when configured. */
	stepCodeProviderExtension: InlineExtension | undefined;
}

/**
 * Build the ordered list of inline extension factories for pi's main().
 *
 * Keep this list in sync with ch5: it is the whole-repo registration point, so
 * adding an extension means adding one entry here — nowhere else.
 */
export function createStepExtensionFactories(deps: StepExtensionFactoryDeps): InlineExtension[] {
	return [
		createStepExtensionInline({
			telemetry: deps.telemetry,
			stepSettings: deps.stepSettings,
			feedbackIdentity: deps.feedbackIdentity,
			permission: deps.permission,
			traceHeaderPolicy: deps.traceHeaderPolicy,
		}),
		createStepCapabilitiesExtensionInline({ telemetry: deps.telemetry }),
		createStepCronExtension({ telemetry: deps.telemetry }),
		createStepGoalExtension({ telemetry: deps.telemetry }),
		...(deps.stepCodeProviderExtension ? [deps.stepCodeProviderExtension] : []),
	];
}
