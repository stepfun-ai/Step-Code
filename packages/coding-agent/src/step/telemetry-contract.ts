import type { ModelRequestObserver } from "../core/model-request-observer.ts";
import type {
	StepTelemetryPrimitive as RegistryTelemetryPrimitive,
	StepTelemetryEventPayloads,
	StepTelemetryKnownEventName,
} from "./telemetry-events.ts";

/** Event understood by the Step telemetry contract for model calls. */
export type StepModelRequestEventName = Extract<StepTelemetryKnownEventName, "model_request_completed">;

/** All events that are part of the reviewed Step telemetry contract. */
export type StepTelemetryEventName = StepTelemetryKnownEventName;

export type StepTelemetryPrimitive = RegistryTelemetryPrimitive;
export type StepTelemetryProperties = Readonly<Record<string, StepTelemetryPrimitive>>;

/**
 * Known-event payloads are partial at the producer boundary. This keeps
 * adapters useful while a request is being assembled, while still rejecting a
 * misspelled field on a known event.
 */
export type StepTelemetryPropertiesFor<K extends StepTelemetryEventName> = Readonly<
	Partial<StepTelemetryEventPayloads[K]>
>;

export type { StepTelemetryKnownEventName } from "./telemetry-events.ts";

/** Ambient identity updates stamped onto subsequent telemetry envelopes. */
export interface StepTelemetryContextPatch {
	readonly sessionId?: string;
	readonly channel?: string;
	readonly version?: string;
	readonly platform?: string;
	readonly deviceId?: string;
	readonly uid?: string;
	readonly username?: string;
	readonly commit?: string;
}

/** Per-record context override. Session identity is snapshotted at track time. */
export interface StepTelemetryTrackOptions {
	readonly sessionId?: string;
	readonly context?: Pick<StepTelemetryContextPatch, "sessionId">;
}

export interface StepPermissionDecisionTelemetry {
	readonly toolName: string;
	readonly mode?: string;
	readonly action?: string;
	readonly risk?: string;
	readonly hazardous?: boolean;
}

export interface StepPermissionApprovalTelemetry {
	readonly toolName: string;
	readonly decision: string;
	readonly risk?: string;
}

/** Small injection seam for a host's existing telemetry client. */
export interface StepTelemetryReporter {
	readonly enabled?: boolean;
	track(
		event: StepTelemetryEventName,
		properties: StepTelemetryProperties,
		options?: StepTelemetryTrackOptions,
	): void | Promise<void>;
	setContext?(patch: StepTelemetryContextPatch): void;
	flush?(): Promise<void>;
	shutdown?(): Promise<void>;
}

/** Statically typed producer helper for the reviewed event registry. */
export function trackStepTelemetry<K extends StepTelemetryEventName>(
	reporter: StepTelemetryReporter,
	event: K,
	properties: StepTelemetryPropertiesFor<K>,
	options?: StepTelemetryTrackOptions,
): void {
	try {
		void Promise.resolve(reporter.track(event, properties as StepTelemetryProperties, options)).catch(
			() => undefined,
		);
	} catch {
		// Telemetry must never affect the caller's work.
	}
}

/** Trace headers are configured by the host; the public default is empty. */
export interface TraceHeaderPolicy {
	readonly allowedBaseUrls: readonly string[];
	readonly highSensitivityFields: readonly string[];
}

export interface StepObservabilityConfig {
	readonly version?: string;
	readonly config?: unknown;
}

export interface ObservabilitySystemMetrics {
	start?(): void;
	sample?(): void;
	stop?(): void;
}

export interface ObservabilityCrashHandlers {
	dispose(): void;
}

/** Composition seam for environment-specific observability implementations. */
export interface StepObservabilityProvider {
	createReporter(config?: StepObservabilityConfig): StepTelemetryReporter;
	createModelRequestObserver(reporter: StepTelemetryReporter): ModelRequestObserver | undefined;
	createSystemMetrics?(reporter: StepTelemetryReporter): ObservabilitySystemMetrics | undefined;
	installCrashHandlers?(reporter: StepTelemetryReporter): ObservabilityCrashHandlers | undefined;
	traceHeaderPolicy(): TraceHeaderPolicy;
}

/** Public builds intentionally do not send telemetry or trace identity. */
export const NOOP_OBSERVABILITY_PROVIDER: StepObservabilityProvider = {
	createReporter: () => ({ enabled: false, track: () => undefined, setContext: () => undefined }),
	createModelRequestObserver: () => undefined,
	traceHeaderPolicy: () => ({ allowedBaseUrls: [], highSensitivityFields: [] }),
};

/** Classify only URL classes that are safe to expose in the public contract. */
export function classifyStepEndpoint(
	baseUrl: string,
	_env: Record<string, string | undefined> = process.env,
): "platform" | "custom" | "local" {
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return "custom";
	}
	if (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "::1" ||
		hostname === "[::1]" ||
		hostname.endsWith(".localhost")
	) {
		return "local";
	}
	for (const name of ["STEP_BASE_URL", "STEP_MODELS_PROXY_BASE_URL", "STEPFUN_MESSAGES_ENDPOINT"] as const) {
		for (const candidate of (_env[name] ?? "").split(",")) {
			try {
				if (new URL(candidate.trim()).hostname.toLowerCase() === hostname) return "platform";
			} catch {
				// Ignore malformed overrides.
			}
		}
	}
	if (hostname === "api.stepfun.com") return "platform";
	return "custom";
}
