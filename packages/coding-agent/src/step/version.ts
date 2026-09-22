/**
 * Version identity for the Step product facade.
 *
 * The repository contains the upstream Pi packages as implementation details,
 * so their package version is not the version users see from `step`. Release
 * builders inject the tag through the static build variables below; source and
 * development runs intentionally fall back to the current Step version.
 */

/** Product version used by source/dev runs until a release tag is embedded. */
export const STEPCODE_FALLBACK_VERSION = "0.1.0";

/** Explicit local override, useful for smoke tests and embedders. */
export const STEPCODE_VERSION_OVERRIDE_ENV = "STEPCODE_VERSION_OVERRIDE";
/** Version embedded by release builds. */
export const STEPCODE_BUILD_VERSION_ENV = "STEPCODE_BUILD_VERSION";

// Keep literal process.env reads: Bun's `--env STEPCODE_BUILD_*` compiler
// only substitutes this form.
const INLINED_BUILD_VERSION = process.env.STEPCODE_BUILD_VERSION;

export interface StepCodeVersion {
	readonly value: string;
	readonly source: "override" | "embedded" | "fallback";
}

/**
 * Resolve a Step version from an injected environment without reading files.
 *
 * The static values are deliberately used only for the real process
 * environment. This keeps `resolveStepCodeVersion({})` deterministic in
 * tests and in embedders while still allowing Bun's `--env` compile-time
 * substitution to survive its empty runtime environment.
 */
export function resolveStepCodeVersion(env?: Record<string, string | undefined>): StepCodeVersion {
	const runtimeEnv = env ?? process.env;
	const useEmbeddedValues = env === undefined || runtimeEnv === process.env;
	const override = normalizeVersion(runtimeEnv[STEPCODE_VERSION_OVERRIDE_ENV]);
	const embedded = normalizeVersion(
		runtimeEnv[STEPCODE_BUILD_VERSION_ENV] ?? (useEmbeddedValues ? INLINED_BUILD_VERSION : undefined),
	);
	if (override) return { value: override, source: "override" };
	if (embedded) return { value: embedded, source: "embedded" };
	return { value: STEPCODE_FALLBACK_VERSION, source: "fallback" };
}

export const STEPCODE_VERSION = resolveStepCodeVersion();

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
