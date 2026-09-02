/**
 * Version identity for the Step product facade.
 *
 * The repository contains the upstream Pi packages as implementation details,
 * so their package version is not the version users see from `step`. Release
 * builders inject the tag through the static build variables below; source and
 * development runs intentionally fall back to the current Step version.
 */

/** Product version used by source/dev runs until a release tag is embedded. */
export const STEP_CLI_FALLBACK_VERSION = "0.3.1";

/** Explicit local override, useful for smoke tests and embedders. */
export const STEP_CLI_VERSION_OVERRIDE_ENV = "STEP_CLI_VERSION_OVERRIDE";
/** Version embedded by release builds. */
export const STEP_CLI_BUILD_VERSION_ENV = "STEP_CLI_BUILD_VERSION";

/**
 * Legacy names accepted while users move from the pre-rename Step Harness
 * namespace. The canonical Step CLI names always take precedence when both
 * names are present.
 */
export const STEP_HARNESS_FALLBACK_VERSION = STEP_CLI_FALLBACK_VERSION;
export const STEP_HARNESS_VERSION_OVERRIDE_ENV = "STEP_HARNESS_VERSION_OVERRIDE";
export const STEP_HARNESS_BUILD_VERSION_ENV = "STEP_HARNESS_BUILD_VERSION";

// Keep literal process.env reads: Bun's `--env STEP_CLI_BUILD_*` compiler
// substitutes this form at build time. The legacy read is retained for older
// release scripts that still inject STEP_HARNESS_BUILD_VERSION.
const INLINED_BUILD_VERSION = process.env.STEP_CLI_BUILD_VERSION;
const INLINED_LEGACY_BUILD_VERSION = process.env.STEP_HARNESS_BUILD_VERSION;

export interface StepCliVersion {
	readonly value: string;
	readonly source: "override" | "embedded" | "fallback";
}

/** Compatibility type for callers compiled against the pre-rename surface. */
export type StepHarnessVersion = StepCliVersion;

/**
 * Resolve a Step version from an injected environment without reading files.
 *
 * The static values are deliberately used only for the real process
 * environment. This keeps `resolveStepCliVersion({})` deterministic in tests
 * and in embedders while still allowing Bun's `--env` compile-time
 * substitution to survive its empty runtime environment.
 */
export function resolveStepCliVersion(env?: Record<string, string | undefined>): StepCliVersion {
	const runtimeEnv = env ?? process.env;
	const useEmbeddedValues = env === undefined || runtimeEnv === process.env;
	const override = normalizeStepCliVersionValue(
		firstNonBlank(runtimeEnv[STEP_CLI_VERSION_OVERRIDE_ENV], runtimeEnv[STEP_HARNESS_VERSION_OVERRIDE_ENV]),
	);
	const embedded = normalizeStepCliVersionValue(
		firstNonBlank(
			runtimeEnv[STEP_CLI_BUILD_VERSION_ENV],
			runtimeEnv[STEP_HARNESS_BUILD_VERSION_ENV],
			useEmbeddedValues ? INLINED_BUILD_VERSION : undefined,
			useEmbeddedValues ? INLINED_LEGACY_BUILD_VERSION : undefined,
		),
	);
	if (override) return { value: override, source: "override" };
	if (embedded) return { value: embedded, source: "embedded" };
	return { value: STEP_CLI_FALLBACK_VERSION, source: "fallback" };
}

/** Compatibility resolver retaining the old function name. */
export function resolveStepHarnessVersion(env?: Record<string, string | undefined>): StepHarnessVersion {
	return resolveStepCliVersion(env);
}

export const STEP_CLI_VERSION = resolveStepCliVersion();
/** Compatibility value retaining the old export name. */
export const STEP_HARNESS_VERSION = STEP_CLI_VERSION;

/** Resolve a runtime version alias without considering embedded build values. */
export function readStepRuntimeVersion(env: Record<string, string | undefined>): string | undefined {
	return normalizeStepCliVersionValue(firstNonBlank(env.STEP_CLI_VERSION, env.STEP_HARNESS_VERSION));
}

/** Normalize a caller-provided version to the same value used by the resolver. */
export function normalizeStepCliVersionValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	let normalized = value.trim();
	if (!normalized) return undefined;
	// CI providers expose either a tag name or a full ref. Accept the legacy
	// product prefixes during migration, then keep one canonical semver value on
	// CLI, TUI, SDK metadata and telemetry envelopes.
	normalized = normalized.replace(/^refs\/tags\//iu, "");
	normalized = normalized.replace(/^(?:step|pi)-v/iu, "");
	normalized = normalized.replace(/^v(?=\d)/iu, "");
	return normalized || undefined;
}

/** Compatibility normalizer retaining the old function name. */
export function normalizeStepHarnessVersionValue(value: unknown): string | undefined {
	return normalizeStepCliVersionValue(value);
}

function firstNonBlank(...values: readonly (string | undefined)[]): string | undefined {
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}
