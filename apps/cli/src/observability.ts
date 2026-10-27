/**
 * The CLI's observability provider.
 *
 * Usage telemetry only: daily device activity and upstream trace ids. It is
 * off unless a collector is configured (`STEPCODE_TELEMETRY_ENDPOINT`, or the
 * build-time `STEPCODE_BUILD_TELEMETRY_ENDPOINT` on release builds), so a
 * build without one sends and spools nothing.
 */
import { createStepUsageObservabilityProvider } from "@step-harness/coding-agent";

export const observability = createStepUsageObservabilityProvider({ client: "cli" });
