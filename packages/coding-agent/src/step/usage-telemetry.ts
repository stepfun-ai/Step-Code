/**
 * Step usage telemetry: the two product signals this build reports.
 *
 * - `device_daily_active`: one record per device, UTC+8 day, and user type
 *   (internal gateway, Step endpoint, or third-party provider), written when a
 *   model request gets an HTTP response. Re-sent at most once per process per
 *   day and type; the collector keeps the first record.
 * - `session_trace_recorded`: every upstream gateway trace id (`x-trace-id`),
 *   linked to the session that issued the request.
 *
 * Delivery reuses the Step telemetry runtime unchanged. This module only
 * decides what is reported: it narrows the runtime to these two events (other
 * producers in the codebase keep calling the reporter and are dropped here),
 * classifies endpoints, and turns model-request traces into records.
 *
 * Nothing here names a collector or an internal gateway. Both come from
 * `config/usage-telemetry.yaml` (embedded by the build) or the environment, so
 * a build without them reports nothing.
 */

import { readStoredCredential } from "../core/auth-storage.ts";
import { getStepAuthPath } from "./auth.ts";
import { normalizeStepUid } from "./build-identity.ts";
import { readOrCreateStepDeviceId, resolveStepStorageRoot } from "./device-id.ts";
import { resolveStepLoginProfiles } from "./onboarding.ts";
import {
	NOOP_OBSERVABILITY_PROVIDER,
	type StepObservabilityProvider,
	type StepTelemetryEventName,
	type StepTelemetryReporter,
	trackStepTelemetry,
} from "./telemetry-contract.ts";
import {
	createStepTelemetryRuntime,
	resolveStepTelemetrySettings,
	type StepTelemetryRuntimeOptions,
} from "./telemetry-runtime.ts";
import { readStepUsageTelemetryConfig, type StepUsageTelemetryConfig } from "./usage-telemetry-config.ts";

/** Events this build forwards; every other `track()` call is dropped. */
export const STEP_USAGE_TELEMETRY_EVENTS: ReadonlySet<StepTelemetryEventName> = new Set<StepTelemetryEventName>([
	"device_daily_active",
	"session_trace_recorded",
]);

export type StepUsageUserType = "internal" | "external" | "third_party";
export type StepUsageClient = "cli" | "web" | "desktop";

export interface StepUsageEndpointClassification {
	readonly userType: StepUsageUserType;
	/** `internal`, a Step login profile id, or the configured provider id. */
	readonly providerKind: string;
}

/** A Step endpoint a login profile addresses, e.g. `step_plan` → `https://api.stepfun.com/step_plan`. */
export interface StepUsageProfileEndpoint {
	readonly id: string;
	readonly baseUrl: string;
}

export interface StepUsageClassifierOptions {
	/** Hostnames of internal gateways (exact, case-insensitive). */
	readonly internalHosts: readonly string[];
	/** Step login profiles; see `resolveStepLoginProfiles()`. */
	readonly profiles: readonly StepUsageProfileEndpoint[];
}

const INTERNAL_HOSTS_ENV = "STEPCODE_INTERNAL_PROVIDER_HOSTS";
const BUILD_INTERNAL_HOSTS_ENV = "STEPCODE_BUILD_INTERNAL_PROVIDER_HOSTS";
// Legacy single-value build variable, substituted by `bun build
// --env=STEPCODE_BUILD_*`; the YAML config is the primary source.
const INLINED_BUILD_INTERNAL_HOSTS = process.env.STEPCODE_BUILD_INTERNAL_PROVIDER_HOSTS;
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Internal gateway hostnames.
 *
 * Precedence: the dedicated environment variable, then the usage config
 * (`config/usage-telemetry.yaml`, runtime override included), then the legacy
 * build variable.
 */
export function readInternalProviderHosts(env: NodeJS.ProcessEnv = process.env): string[] {
	const explicit = normalizeHosts(env[INTERNAL_HOSTS_ENV]?.trim() ?? "");
	if (explicit.length > 0) return explicit;
	const configured = readStepUsageTelemetryConfig(env)?.internalProviderHosts;
	if (configured && configured.length > 0) return [...configured];
	const legacy =
		env[BUILD_INTERNAL_HOSTS_ENV]?.trim() ||
		(env === process.env ? INLINED_BUILD_INTERNAL_HOSTS?.trim() : undefined) ||
		"";
	return normalizeHosts(legacy);
}

function normalizeHosts(raw: string): string[] {
	return [
		...new Set(
			raw
				.split(",")
				.map((host) => host.trim().toLowerCase())
				.filter(Boolean),
		),
	];
}

/**
 * Classify the endpoint a request actually reached.
 *
 * Internal gateways are matched by hostname. Step endpoints are matched against
 * the login profiles' base URLs (longest prefix wins, so `/step_plan` and `/v1`
 * on the same host stay distinct); another path on a Step host is still
 * external but keeps the provider id. Everything else is a third-party provider
 * reported under its configured id, never its address.
 */
export function classifyStepUsageEndpoint(
	baseUrl: string,
	provider: string,
	options: StepUsageClassifierOptions,
): StepUsageEndpointClassification {
	const providerKind = provider.trim() || "unknown";
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return { userType: "third_party", providerKind };
	}
	const hostname = url.hostname.toLowerCase();
	if (options.internalHosts.includes(hostname)) return { userType: "internal", providerKind: "internal" };

	const target = normalizeUrlPrefix(baseUrl);
	let match: StepUsageProfileEndpoint | undefined;
	let stepHost = false;
	for (const profile of options.profiles) {
		const base = normalizeUrlPrefix(profile.baseUrl);
		if (!base) continue;
		if (hostOf(base) === hostname) stepHost = true;
		const matches = target === base || target.startsWith(`${base}/`);
		if (matches && (!match || base.length > normalizeUrlPrefix(match.baseUrl).length)) match = profile;
	}
	if (match) return { userType: "external", providerKind: match.id };
	return stepHost ? { userType: "external", providerKind } : { userType: "third_party", providerKind };
}

/** The UTC+8 calendar day of an instant, `YYYY-MM-DD`. */
export function stepUsageLocalDay(at: Date = new Date()): string {
	return new Date(at.getTime() + UTC8_OFFSET_MS).toISOString().slice(0, 10);
}

/** `desktop` when the desktop shell started this process; otherwise the host's own kind. */
export function resolveStepUsageClient(
	fallback: StepUsageClient,
	env: NodeJS.ProcessEnv = process.env,
): StepUsageClient {
	return env.STEPCODE_HOST?.trim() === "desktop" ? "desktop" : fallback;
}

/** Narrow a reporter to {@link STEP_USAGE_TELEMETRY_EVENTS}; context, flush, and shutdown pass through. */
export function filterStepUsageReporter(reporter: StepTelemetryReporter): StepTelemetryReporter {
	return {
		enabled: reporter.enabled,
		track: (event, properties, options) =>
			STEP_USAGE_TELEMETRY_EVENTS.has(event) ? reporter.track(event, properties, options) : undefined,
		...(reporter.setContext ? { setContext: (patch) => reporter.setContext?.(patch) } : {}),
		...(reporter.flush ? { flush: () => reporter.flush?.() ?? Promise.resolve() } : {}),
		...(reporter.shutdown ? { shutdown: () => reporter.shutdown?.() ?? Promise.resolve() } : {}),
	};
}

function normalizeUrlPrefix(value: string): string {
	return value.trim().replace(/\/+$/u, "").toLowerCase();
}

function hostOf(normalizedUrl: string): string | undefined {
	try {
		return new URL(normalizedUrl).hostname;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Observability provider
// ---------------------------------------------------------------------------

export interface StepUsageObservabilityOptions {
	readonly client: StepUsageClient;
	readonly env?: NodeJS.ProcessEnv;
	/** Process start time, defaults to {@link processStartAt}. Injectable for tests. */
	readonly processStartedAt?: Date;
	/** Credential file whose `step.uid` identifies the signed-in account. */
	readonly authPath?: () => string;
	/**
	 * The process runs on an explicitly supplied key (`--api-key`, `STEP_API_KEY`).
	 * The stored account then is not the one being used, so its uid is not attached.
	 */
	readonly explicitCredential?: boolean;
	/** Runtime seams for tests and embedders (fetch, clock, spool directory, intervals). */
	readonly runtime?: Omit<StepTelemetryRuntimeOptions, "env" | "config" | "context" | "enabled">;
	/** Clock for the UTC+8 day; injectable for tests. */
	readonly now?: () => Date;
}

export interface StepUsageObservabilityProvider extends StepObservabilityProvider {
	/** Re-read the account uid after a sign-in, so later records carry it. */
	refreshIdentity(reporter: StepTelemetryReporter): void;
}

interface DailyActivity {
	record(classification: StepUsageEndpointClassification, model: { provider: string; id: string }): void;
}

/**
 * The usage-telemetry implementation of the observability seam.
 *
 * Reporting is off unless a collector endpoint resolves (environment, runtime
 * or embedded usage config, or a release `config.toml`; there is no built-in
 * default). Without one the reporter is the
 * public no-op, so nothing is sent and nothing is spooled.
 */
export function createStepUsageObservabilityProvider(
	options: StepUsageObservabilityOptions,
): StepUsageObservabilityProvider {
	const env = options.env ?? process.env;
	const now = options.now ?? (() => new Date());
	// The day's "first open" is the process start, not the first request: the
	// CLI may start signed out and send its first request minutes later.
	const openedAt = options.processStartedAt ?? processStartAt(now);
	const client = resolveStepUsageClient(options.client, env);
	const classifier: StepUsageClassifierOptions = {
		internalHosts: readInternalProviderHosts(env),
		profiles: resolveStepLoginProfiles(env).map((profile) => ({ id: profile.id, baseUrl: profile.baseUrl })),
	};
	const activities = new WeakMap<StepTelemetryReporter, DailyActivity>();
	const activityFor = (reporter: StepTelemetryReporter): DailyActivity => {
		let activity = activities.get(reporter);
		if (!activity) {
			activity = createDailyActivity(reporter, client, now, openedAt);
			activities.set(reporter, activity);
		}
		return activity;
	};
	const readUid = (): string | undefined => {
		if (options.explicitCredential) return undefined;
		try {
			const credential = readStoredCredential("step", (options.authPath ?? (() => getStepAuthPath(env)))());
			return normalizeStepUid(credential && "uid" in credential ? credential.uid : undefined);
		} catch {
			// An unreadable credential file only leaves records without an account id.
			return undefined;
		}
	};
	const syncUid = (reporter: StepTelemetryReporter): void => {
		const uid = readUid();
		if (uid) reporter.setContext?.({ uid });
	};

	return {
		createReporter(config) {
			const policy = readTelemetryPolicy(config?.config);
			const settings = resolveStepTelemetrySettings(env, policy);
			const usageConfig: StepUsageTelemetryConfig | undefined = readStepUsageTelemetryConfig(env);
			if (usageConfig?.enabled === false) return NOOP_OBSERVABILITY_PROVIDER.createReporter();
			if (!settings.enabled || !settings.endpoint) return NOOP_OBSERVABILITY_PROVIDER.createReporter();
			const reporter = filterStepUsageReporter(
				createStepTelemetryRuntime({
					...options.runtime,
					env,
					config: policy,
					...(config?.version ? { context: { version: config.version } } : {}),
				}),
			);
			syncUid(reporter);
			void readOrCreateStepDeviceId(resolveStepStorageRoot(env))
				.then((result) => {
					if (result.deviceId) reporter.setContext?.({ deviceId: result.deviceId });
				})
				.catch(() => {
					// A read-only home leaves records without a device id; the collector drops daily rows then.
				});
			return reporter;
		},
		createModelRequestObserver(reporter) {
			if (reporter.enabled === false) return undefined;
			return {
				onModelResponse(response) {
					// Any HTTP response, error statuses included, is use of the endpoint.
					// Third-party providers send no trace id, so this cannot wait for one.
					const classification = classifyStepUsageEndpoint(response.baseUrl, response.provider, classifier);
					activityFor(reporter).record(classification, { provider: response.provider, id: response.model });
				},
				onTraceId(trace) {
					const classification = classifyStepUsageEndpoint(trace.baseUrl, trace.provider, classifier);
					trackStepTelemetry(
						reporter,
						"session_trace_recorded",
						{
							session_id: trace.sessionId,
							trace_id: trace.traceId,
							user_type: classification.userType,
							provider_kind: classification.providerKind,
							provider: trace.provider,
							model: trace.model,
							status_code: trace.statusCode,
							attempt: trace.attempt,
							local_day: stepUsageLocalDay(now()),
							client,
						},
						trace.sessionId ? { sessionId: trace.sessionId } : undefined,
					);
				},
			};
		},
		traceHeaderPolicy: () => NOOP_OBSERVABILITY_PROVIDER.traceHeaderPolicy(),
		refreshIdentity: syncUid,
	};
}

function createDailyActivity(
	reporter: StepTelemetryReporter,
	client: StepUsageClient,
	now: () => Date,
	openedAt: Date,
): DailyActivity {
	// Per process: the collector keeps the first record of a day and type, so a
	// later launch re-sending it is harmless, and a lost first delivery is
	// replaced by the next launch's instead of being suppressed by a local marker.
	const reported = new Set<string>();
	return {
		record(classification, model) {
			const day = stepUsageLocalDay(now());
			const key = `${day}:${classification.userType}`;
			if (reported.has(key)) return;
			reported.add(key);
			trackStepTelemetry(reporter, "device_daily_active", {
				user_type: classification.userType,
				provider_kind: classification.providerKind,
				provider: model.provider,
				model: model.id,
				local_day: day,
				client,
				// Only when the process started on this same UTC+8 day: a process left
				// running past midnight belongs to its own day, so the collector would
				// otherwise date today's record to yesterday.
				...(stepUsageLocalDay(openedAt) === day ? { opened_at: openedAt.toISOString() } : {}),
			});
		},
	};
}

/**
 * The process start instant, from `process.uptime()` so every host (CLI, Web,
 * desktop server) reports the same instant regardless of when the provider is
 * constructed. Clamped to now for clocks that disagree.
 */
export function processStartAt(now: () => Date = () => new Date()): Date {
	const startedAt = new Date(now().getTime() - Math.max(0, process.uptime()) * 1000);
	return startedAt;
}

/**
 * Narrow the seam's untyped config to the persisted telemetry policy
 * (`config.toml` `[telemetry]`). Read defensively: a malformed file must not
 * disable the gates or turn reporting on.
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
