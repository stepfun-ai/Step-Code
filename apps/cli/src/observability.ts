/**
 * Real observability provider for internal Step builds.
 *
 * `main.ts` composes telemetry through the `StepObservabilityProvider` seam and
 * never imports the runtime directly, so this file is the single place that
 * decides whether a build reports. Public builds keep the noop provider; this
 * one wires the HTTP reporter that posts to the Step collector.
 *
 * Nothing here decides *where* events go: `createStepTelemetryRuntime` resolves
 * the endpoint from the build channel and the environment (see
 * `observer-endpoints.ts`). A source checkout still only writes its local
 * spool unless `STEPCODE_TELEMETRY_ENDPOINT` is set.
 */

import {
	createStepModelRequestObserver,
	createStepSystemMetricsCollector,
	createStepTelemetryRuntime,
	installStepTelemetryCrashHandlers,
	resolveStepTraceHeaderBaseUrls,
	type StepObservabilityProvider,
	type StepTelemetryReporter,
	type StepTelemetryRuntime,
	type StepTelemetryRuntimeOptions,
} from "@step-harness/coding-agent";

/** The runtime is the only reporter this provider creates, so narrow to it. */
function asRuntime(reporter: StepTelemetryReporter): StepTelemetryRuntime | undefined {
	return "flush" in reporter && "endpoint" in reporter ? (reporter as StepTelemetryRuntime) : undefined;
}

/**
 * Narrow the seam's `unknown` config to the persisted telemetry policy.
 *
 * `StepObservabilityConfig.config` is deliberately untyped so the public
 * contract does not name a runtime shape. The value main.ts passes is
 * `StepGlobalDefaults["telemetry"]`, so read the three fields back defensively
 * rather than asserting — a malformed config.toml must not disable the gates.
 */
function readTelemetryPolicy(value: unknown): StepTelemetryRuntimeOptions["config"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	return {
		...(typeof source.enabled === "boolean" ? { enabled: source.enabled } : {}),
		...(typeof source.spool === "boolean" ? { spool: source.spool } : {}),
		...(typeof source.endpoint === "string" ? { endpoint: source.endpoint } : {}),
	};
}

export const observability: StepObservabilityProvider = {
	createReporter(config) {
		return createStepTelemetryRuntime({
			...(config?.version ? { context: { version: config.version } } : {}),
			config: readTelemetryPolicy(config?.config),
		});
	},
	createModelRequestObserver(reporter) {
		// The base URLs only decide the `routed_via_cloud_trace` flag; the request
		// address itself is never emitted.
		return createStepModelRequestObserver(reporter, { observerBaseUrls: resolveStepTraceHeaderBaseUrls() });
	},
	createSystemMetrics(reporter) {
		return asRuntime(reporter)?.enabled ? createStepSystemMetricsCollector(reporter) : undefined;
	},
	installCrashHandlers(reporter) {
		return asRuntime(reporter)?.enabled ? installStepTelemetryCrashHandlers(reporter) : undefined;
	},
	traceHeaderPolicy() {
		// Attribution headers stay fail-closed: the allowlist is whatever the
		// operator configured through the cloud-trace environment variables, and
		// no high-sensitivity field is permitted without an explicit policy.
		// Widening this would start sending session/workspace ids to a model
		// endpoint, which is a separate decision from product analytics.
		return { allowedBaseUrls: resolveStepTraceHeaderBaseUrls(), highSensitivityFields: [] };
	},
};
