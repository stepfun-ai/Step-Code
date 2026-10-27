/**
 * Usage-telemetry configuration, one document per build.
 *
 * The build step (`scripts/load-usage-telemetry-config.mjs`) parses
 * `config/usage-telemetry.yaml`, validates it, and embeds the compact JSON as
 * `STEPCODE_BUILD_USAGE_TELEMETRY`. Nothing here names a collector or a gateway:
 * a build without the embedded value reports nothing.
 *
 * Precedence, highest first:
 *   1. the dedicated environment variables documented in
 *      `docs/step-integration.md` (`STEPCODE_TELEMETRY_ENDPOINT`, ...);
 *   2. a runtime config (`STEPCODE_USAGE_TELEMETRY` JSON, or a JSON file named by
 *      `STEPCODE_USAGE_TELEMETRY_CONFIG`), for operating an installed build;
 *   3. the build config embedded above.
 */

import { readFileSync } from "node:fs";

/** Known fields. Unknown keys are kept so a newer build can read a newer file. */
export interface StepUsageTelemetryConfig {
	readonly enabled?: boolean;
	readonly endpoint?: string;
	readonly internalProviderHosts?: readonly string[];
	readonly [key: string]: unknown;
}

const BUILD_ENV = "STEPCODE_BUILD_USAGE_TELEMETRY";
const RUNTIME_ENV = "STEPCODE_USAGE_TELEMETRY";
const RUNTIME_FILE_ENV = "STEPCODE_USAGE_TELEMETRY_CONFIG";

// Inlined by `bun build --env=STEPCODE_BUILD_*` and by the bundle's esbuild
// `define`, so a released binary carries the config without it appearing in
// source. A build without the value stops here.
const INLINED_BUILD_CONFIG = process.env.STEPCODE_BUILD_USAGE_TELEMETRY;

/** Parse and validate a config document; an unusable value is ignored field by field. */
export function parseStepUsageTelemetryConfig(value: unknown): StepUsageTelemetryConfig | undefined {
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	const config: Record<string, unknown> = { ...source };
	if (typeof source.enabled !== "boolean") delete config.enabled;
	const endpoint = typeof source.endpoint === "string" ? normalizeEndpoint(source.endpoint) : undefined;
	if (endpoint) config.endpoint = endpoint;
	else delete config.endpoint;
	const hosts = readHostList(source.internalProviderHosts);
	if (hosts.length > 0) config.internalProviderHosts = hosts;
	else delete config.internalProviderHosts;
	return config;
}

/** The config embedded by the build; absent in a public build. */
export function readBuildStepUsageTelemetryConfig(
	env: NodeJS.ProcessEnv = process.env,
): StepUsageTelemetryConfig | undefined {
	const explicit = env[BUILD_ENV];
	if (explicit !== undefined && explicit !== "") return parseStepUsageTelemetryConfig(explicit);
	return env === process.env ? parseStepUsageTelemetryConfig(INLINED_BUILD_CONFIG) : undefined;
}

/** An operator-supplied override for an installed build (JSON inline or a JSON file). */
export function readRuntimeStepUsageTelemetryConfig(
	env: NodeJS.ProcessEnv = process.env,
): StepUsageTelemetryConfig | undefined {
	const inline = env[RUNTIME_ENV]?.trim();
	if (inline) return parseStepUsageTelemetryConfig(inline);
	const path = env[RUNTIME_FILE_ENV]?.trim();
	if (!path) return undefined;
	try {
		return parseStepUsageTelemetryConfig(readFileSync(path, "utf8"));
	} catch {
		// An unreadable override falls back to the build config rather than
		// disabling a build that was shipped with a valid one.
		return undefined;
	}
}

/** Runtime fields win over build fields; each field is taken independently. */
export function readStepUsageTelemetryConfig(
	env: NodeJS.ProcessEnv = process.env,
): StepUsageTelemetryConfig | undefined {
	const build = readBuildStepUsageTelemetryConfig(env);
	const runtime = readRuntimeStepUsageTelemetryConfig(env);
	if (!build && !runtime) return undefined;
	return { ...(build ?? {}), ...(runtime ?? {}) };
}

function normalizeEndpoint(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	try {
		const url = new URL(trimmed);
		return url.protocol === "http:" || url.protocol === "https:" ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

function readHostList(value: unknown): string[] {
	const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const hosts: string[] = [];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const host = entry.trim().toLowerCase();
		if (host && /^[a-z0-9.-]+$/u.test(host) && !hosts.includes(host)) hosts.push(host);
	}
	return hosts;
}
