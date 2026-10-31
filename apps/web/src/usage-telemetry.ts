/**
 * Usage telemetry for the Web host (and the desktop app, which runs this host).
 *
 * One reporter per host process, shared by every session it serves, so the
 * daily-activity dedup and the delivery batches span sessions. Off unless a
 * collector is configured; see `createStepUsageObservabilityProvider`.
 */

import {
	createModelRequestTraceCapture,
	createStepUsageObservabilityProvider,
	type ModelRequestObserver,
	type ModelRequestTraceCapture,
	readGlobalStepDefaults,
	type StepTelemetryReporter,
} from "@step-harness/coding-agent";

export interface WebUsageTelemetry {
	readonly reporter: StepTelemetryReporter;
	readonly modelRequestObserver: ModelRequestObserver | undefined;
	/**
	 * Response callbacks for a one-off model call made outside the session's agent
	 * loop (session titles); they feed both daily activity and trace records.
	 */
	traceCapture(sessionId: string): ModelRequestTraceCapture | undefined;
	/** Re-read the account uid after a sign-in. */
	refreshIdentity(): void;
	/** Deliver what is buffered; bounded by the runtime's shutdown timeout. */
	shutdown(): Promise<void>;
}

let instance: WebUsageTelemetry | undefined;

export function webUsageTelemetry(): WebUsageTelemetry {
	if (instance) return instance;
	const provider = createStepUsageObservabilityProvider({ client: "web" });
	const reporter = provider.createReporter({ config: readGlobalStepDefaults().telemetry });
	const modelRequestObserver = provider.createModelRequestObserver(reporter);
	instance = {
		reporter,
		modelRequestObserver,
		traceCapture: (sessionId) => createModelRequestTraceCapture(modelRequestObserver, sessionId),
		refreshIdentity: () => provider.refreshIdentity(reporter),
		shutdown: () => reporter.shutdown?.() ?? Promise.resolve(),
	};
	return instance;
}
