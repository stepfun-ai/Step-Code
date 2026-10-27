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

const usage = createStepUsageObservabilityProvider({ client: "cli" });

export const observability: StepUsageObservabilityProvider = {
	...usage,
	traceHeaderPolicy() {
		return { allowedBaseUrls: resolveStepTraceHeaderBaseUrls(), highSensitivityFields: [] };
	},
};
