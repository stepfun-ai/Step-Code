/**
 * The CLI's observability provider.
 *
 * Usage telemetry only: daily device activity and upstream trace ids. The
 * provider narrows the Step telemetry runtime to those two events; every other
 * `track()` call from product code is dropped. Reporting is off unless a
 * collector is configured (`config/usage-telemetry.yaml` embedded by the build,
 * `STEPCODE_TELEMETRY_ENDPOINT`, or a runtime usage config), so a source
 * checkout without one spools nothing.
 *
 * Trace header policy stays as before: attribution headers are fail-closed and
 * only follow the operator's cloud-trace environment.
 */

import {
	createStepUsageObservabilityProvider,
	resolveStepTraceHeaderBaseUrls,
	type StepUsageObservabilityProvider,
} from "@step-harness/coding-agent";

// Same rule as the entrypoint's feedback identity: an explicit key is not the
// stored account, so records must not carry the stored uid.
const explicitCredential =
	process.argv.slice(2).some((arg) => arg === "--api-key" || arg.startsWith("--api-key=")) ||
	Boolean(process.env.STEP_API_KEY?.trim());

const usage = createStepUsageObservabilityProvider({ client: "cli", explicitCredential });

export const observability: StepUsageObservabilityProvider = {
	...usage,
	installCrashHandlers() {
		// Usage telemetry does not report crashes, but a registered listener is
		// what keeps an unhandled rejection from terminating the CLI; the former
		// crash reporter provided it, so keep that process behavior.
		const onUnhandledRejection = (): void => {};
		process.on("unhandledRejection", onUnhandledRejection);
		return {
			dispose() {
				process.off("unhandledRejection", onUnhandledRejection);
			},
		};
	},
	traceHeaderPolicy() {
		return { allowedBaseUrls: resolveStepTraceHeaderBaseUrls(), highSensitivityFields: [] };
	},
};
