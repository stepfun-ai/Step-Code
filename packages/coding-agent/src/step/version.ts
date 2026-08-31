/**
 * Version identity for the Step product facade.
 *
 * The repository contains the upstream Pi packages as implementation details,
 * so their package version is not the version users see from `step`. Release
 * builders inject the tag through the static build variables below; source and
 * development runs intentionally fall back to the current Step version.
 */

/** Product version used by source/dev runs until a release tag is embedded. */
export const STEP_HARNESS_FALLBACK_VERSION = "0.3.1";

/** Explicit local override, useful for smoke tests and embedders. */
export const STEP_HARNESS_VERSION_OVERRIDE_ENV = "STEP_HARNESS_VERSION_OVERRIDE";
/** Version embedded by release builds. */
export const STEP_HARNESS_BUILD_VERSION_ENV = "STEP_HARNESS_BUILD_VERSION";
/** Legacy spelling accepted by older Step release scripts. */
export const STEP_CLI_VERSION_OVERRIDE_ENV = "STEP_CLI_VERSION_OVERRIDE";
/** Legacy build variable accepted when running an older release script. */
export const STEP_CLI_BUILD_VERSION_ENV = "STEP_CLI_BUILD_VERSION";

// Keep literal process.env reads: Bun's `--env STEP_HARNESS_BUILD_*` compiler
// only substitutes this form. The legacy variable remains a compatibility
// input for existing Step release jobs and locally scripted builds.
const INLINED_BUILD_VERSION = process.env.STEP_HARNESS_BUILD_VERSION;
const INLINED_LEGACY_BUILD_VERSION = process.env.STEP_CLI_BUILD_VERSION;

export interface StepHarnessVersion {
	readonly value: string;
	readonly source: "override" | "embedded" | "fallback";
}

/**
 * Resolve a Step version from an injected environment without reading files.
 *
 * The static values are deliberately used only for the real process
 * environment. This keeps `resolveStepHarnessVersion({})` deterministic in
 * tests and in embedders while still allowing Bun's `--env` compile-time
 * substitution to survive its empty runtime environment.
 */
export function resolveStepHarnessVersion(env?: Record<string, string | undefined>): StepHarnessVersion {
	const runtimeEnv = env ?? process.env;
	const useEmbeddedValues = env === undefined || runtimeEnv === process.env;
	const override = normalizeVersion(
		runtimeEnv[STEP_HARNESS_VERSION_OVERRIDE_ENV] ?? runtimeEnv[STEP_CLI_VERSION_OVERRIDE_ENV],
	);
	const embedded = normalizeVersion(
		runtimeEnv[STEP_HARNESS_BUILD_VERSION_ENV] ??
			runtimeEnv[STEP_CLI_BUILD_VERSION_ENV] ??
			(useEmbeddedValues ? INLINED_BUILD_VERSION : undefined) ??
			(useEmbeddedValues ? INLINED_LEGACY_BUILD_VERSION : undefined),
	);
	if (override) return { value: override, source: "override" };
	if (embedded) return { value: embedded, source: "embedded" };
	return { value: STEP_HARNESS_FALLBACK_VERSION, source: "fallback" };
}

export const STEP_HARNESS_VERSION = resolveStepHarnessVersion();

/** Strip the tag prefix so all public surfaces use one canonical value. */
function normalizeVersion(value: string | undefined): string | undefined {
	let normalized = value?.trim();
	if (!normalized) return undefined;
	// CI providers expose either a tag name or a full ref. Accept the legacy
	// product prefixes during migration, then keep one canonical semver value on
	// CLI, TUI, SDK metadata and telemetry envelopes.
	normalized = normalized.replace(/^refs\/tags\//iu, "");
	normalized = normalized.replace(/^(?:step|pi)-v/iu, "");
	normalized = normalized.replace(/^v(?=\d)/iu, "");
	return normalized || undefined;
}
