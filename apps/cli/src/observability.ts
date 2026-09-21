import {
	createStepModelRequestObserver,
	createStepSystemMetricsCollector,
	createStepTelemetryRuntime,
	installStepTelemetryCrashHandlers,
	resolveStepTraceHeaderBaseUrls,
	type StepObservabilityProvider,
	type StepTelemetryReporter,
} from "@step-harness/coding-agent";

const MAIN_TRACE_FIELDS = [
	"session-id",
	"goal-id",
	"attempt-id",
	"harness-id",
	"span-id",
	"workspace-id",
	"provider-id",
	"model",
] as const;

const MAIN_TRACE_ORIGINS = {
	dev: "https://test-openapi-stepcliobserserver.c.stepfun-inc.net",
	release: "https://api.stepfun.com/stepcliobserserver",
} as const;

function traceOrigins(): string[] {
	const channel = process.env.STEP_CLI_BUILD_CHANNEL?.trim() === "release" ? "release" : "dev";
	return [...resolveStepTraceHeaderBaseUrls(), MAIN_TRACE_ORIGINS[channel]];
}

/** Main-only provider: the public branch supplies the no-op counterpart. */
export const observability: StepObservabilityProvider = {
	createReporter(config) {
		return createStepTelemetryRuntime({
			context: config?.version ? { version: config.version } : undefined,
			config: config?.config as NonNullable<Parameters<typeof createStepTelemetryRuntime>[0]>["config"],
		});
	},
	createModelRequestObserver(reporter: StepTelemetryReporter) {
		return createStepModelRequestObserver(reporter, { observerBaseUrls: traceOrigins() });
	},
	createSystemMetrics(reporter) {
		return createStepSystemMetricsCollector(reporter);
	},
	installCrashHandlers(reporter) {
		return installStepTelemetryCrashHandlers(reporter);
	},
	traceHeaderPolicy() {
		return { allowedBaseUrls: traceOrigins(), highSensitivityFields: MAIN_TRACE_FIELDS };
	},
};
