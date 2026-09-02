import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import {
	normalizeStepCommit,
	normalizeStepDeviceId,
	normalizeStepUid,
	normalizeStepWireSessionId,
	readStepBuildIdentity,
} from "./build-identity.ts";
import { resolveStepStorageRoot } from "./device-id.ts";
import type {
	StepTelemetryContextPatch,
	StepTelemetryEventName,
	StepTelemetryPrimitive,
	StepTelemetryProperties,
	StepTelemetryPropertiesFor,
	StepTelemetryReporter,
	StepTelemetryTrackOptions,
} from "./telemetry.ts";
import { isKnownStepTelemetryEvent, STEP_TELEMETRY_EVENT_PROPERTY_NAMES } from "./telemetry-events.ts";
import {
	normalizeStepHarnessVersionValue,
	readStepRuntimeVersion,
	resolveStepCliVersion,
	STEP_CLI_VERSION,
} from "./version.ts";

/** Envelope written to the Step analytics collector and local spool. */
export interface StepTelemetryRecord {
	readonly eventId: string;
	/** Unknown extension events remain readable for compatibility replays. */
	readonly event: string;
	readonly at: string;
	readonly properties: StepTelemetryProperties;
	readonly context: StepTelemetryContext;
}

type PendingTelemetryRecord = Omit<StepTelemetryRecord, "context"> & {
	readonly sessionId?: string;
};

/** Ambient identity carried on every event envelope. */
export interface StepTelemetryContext {
	readonly channel: string;
	/** Product version; required by the legacy Step telemetry wire contract. */
	readonly version: string;
	readonly platform: string;
	readonly commit?: string;
	readonly deviceId?: string;
	readonly sessionId?: string;
	readonly uid?: string;
	readonly username?: string;
}

export interface StepTelemetryRuntimeOptions {
	/** Explicitly enable/disable the reporter. Defaults to Step's env policy. */
	readonly enabled?: boolean;
	/** Optional persisted product policy. Environment/test opt-outs still win. */
	readonly config?: {
		readonly enabled?: boolean;
		readonly spool?: boolean;
		readonly endpoint?: string;
	};
	/** Test or host environment. Defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/** HTTP collector URL. Defaults to STEP_CLI_TELEMETRY_ENDPOINT. */
	readonly endpoint?: string;
	/** Directory for JSONL durability. Defaults to `<step-storage-root>/telemetry`. */
	readonly spoolDirectory?: string;
	/** Number of days to retain local JSONL batches. Set to 0 to disable pruning. */
	readonly spoolRetentionDays?: number;
	/** Initial envelope context. */
	readonly context?: Partial<StepTelemetryContext>;
	/** Injectable network implementation for tests and embedders. */
	readonly fetchImpl?: typeof fetch;
	/** Maximum number of records retained while a sink is slow. */
	readonly maxQueued?: number;
	/** Flush when this many records are queued. */
	readonly flushThreshold?: number;
	/** Periodic flush interval. Set to 0 to disable the timer. */
	readonly flushIntervalMs?: number;
	/** Request timeout for collector delivery. */
	readonly requestTimeoutMs?: number;
	/** Retry delays for non-final collector writes. */
	readonly retryBackoffsMs?: readonly number[];
	/** Injectable delay used by the retry loop. */
	readonly sleep?: (milliseconds: number) => Promise<void>;
	/** Clock used for deterministic tests. */
	readonly clock?: () => string;
}

export type StepTelemetryDisabledReason = "test-runtime" | "env-opt-out" | "config-opt-out";

/** Resolved gates exposed for diagnostics and parity tests. */
export interface StepResolvedTelemetrySettings {
	readonly enabled: boolean;
	readonly spoolEnabled: boolean;
	readonly endpoint?: string;
	readonly reason?: StepTelemetryDisabledReason;
}

export interface StepTelemetryRuntime extends StepTelemetryReporter {
	readonly enabled: boolean;
	readonly endpoint: string | undefined;
	readonly spoolDirectory: string | undefined;
	track(event: StepTelemetryEventName, properties: StepTelemetryProperties, options?: StepTelemetryTrackOptions): void;
	/** @deprecated Compatibility path for a host event not yet in the registry. */
	track(event: string, properties: StepTelemetryProperties, options?: StepTelemetryTrackOptions): void;
	setContext(patch: StepTelemetryContextPatch): void;
	flush(): Promise<void>;
	shutdown(options?: { timeoutMs?: number }): Promise<void>;
}

/** Periodic process resource sampler used by the Step runtime. */
export interface StepSystemMetricsCollector {
	start(): void;
	stop(): void;
	/** Take an immediate sample. Safe to call after stop(). */
	sample(): void;
}

export interface StepSystemMetricsCollectorOptions {
	/** Period between samples. Defaults to five minutes. */
	readonly intervalMs?: number;
	/** Initial sample delay. Pass null to disable the warm-up sample. */
	readonly warmupMs?: number | null;
	/** Injectable monotonic clock, in nanoseconds, for deterministic tests. */
	readonly now?: () => bigint;
}

/** Handle returned by the process-level crash observers. */
export interface StepTelemetryCrashHandlers {
	dispose(): void;
}

const DEFAULT_MAX_QUEUED = 512;
const DEFAULT_FLUSH_THRESHOLD = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;
const DEFAULT_RETRY_BACKOFFS_MS = [1_000, 4_000, 16_000] as const;
const DEFAULT_SPOOL_FILE_PREFIX = "events";
const FAILED_SPOOL_FILE_PREFIX = "failed";
const DEFAULT_SPOOL_RETENTION_DAYS = 7;
const DEFAULT_SYSTEM_METRICS_INTERVAL_MS = 300_000;
const DEFAULT_SYSTEM_METRICS_WARMUP_MS = 1_500;
const MAX_USERNAME_LENGTH = 64;
const PLAUSIBLE_USERNAME = /^[\w.@:-]+$/u;
/** Release default from the legacy Step ObservableServer endpoint registry. */
const RELEASE_TELEMETRY_ENDPOINT = "https://api.stepfun.com/stepcliobserserver/api/v1/events";

/**
 * Create the process-level reporter used by the Step entrypoint.
 *
 * Tracking is deliberately fire-and-forget. A collector outage, a full disk,
 * or malformed host callback must never delay or fail the agent loop. Batches
 * are sent to the collector and the local spool independently; an HTTP failure
 * gets an additional `failed-*` spool copy so the event is still recoverable.
 */
export function createStepTelemetryRuntime(options: StepTelemetryRuntimeOptions = {}): StepTelemetryRuntime {
	const env = options.env ?? process.env;
	const resolved = resolveStepTelemetrySettings(env, options.config);
	// The environment/configuration gates are authoritative.  In particular,
	// test runtimes and explicit opt-outs must not become network-capable merely
	// because an embedding host passed `enabled: true` for convenience.  The
	// option can still disable a normally-enabled runtime (useful for a host that
	// shares the process with Pi), but it cannot override a denial.
	const enabled = resolved.enabled && options.enabled !== false;
	if (!enabled) return createDisabledRuntime();

	const endpoint = normalizeEndpoint(options.endpoint ?? resolved.endpoint);
	const spoolDirectory =
		resolved.spoolEnabled === false || options.config?.spool === false
			? undefined
			: (normalizePath(options.spoolDirectory) ??
				normalizePath(
					firstNonBlank(env.STEP_CLI_TELEMETRY_DIR, env.STEP_HARNESS_TELEMETRY_DIR, env.STEPCLI_TELEMETRY_DIR),
				) ??
				join(resolveStepStorageRoot(env), "telemetry"));
	const maxQueued = positiveInt(options.maxQueued, DEFAULT_MAX_QUEUED);
	const flushThreshold = positiveInt(options.flushThreshold, DEFAULT_FLUSH_THRESHOLD);
	const flushIntervalMs = nonNegativeInt(options.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS);
	const requestTimeoutMs = positiveInt(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
	const retryBackoffsMs = options.retryBackoffsMs ?? DEFAULT_RETRY_BACKOFFS_MS;
	const spoolRetentionDays = nonNegativeInt(options.spoolRetentionDays, DEFAULT_SPOOL_RETENTION_DAYS);
	const sleep = options.sleep ?? defaultUnrefSleep;
	const clock = options.clock ?? (() => new Date().toISOString());
	const initialSessionId = normalizeStepWireSessionId(options.context?.sessionId);
	let context: Omit<StepTelemetryContext, "sessionId"> = {
		channel: normalizeContextValue(options.context?.channel) ?? readBuildChannel(env),
		platform: normalizeContextValue(options.context?.platform ?? process.platform) ?? process.platform,
		// The old TelemetryContext requires a version. Resolve an explicit
		// runtime override first, then the injected build version, and finally the
		// fixed Step source fallback. `resolveStepCliVersion` also knows how
		// to read Bun's compile-time value when its runtime environment is empty.
		version:
			normalizeVersionContext(options.context?.version) ??
			readStepRuntimeVersion(env) ??
			resolveStepCliVersion(env).value ??
			STEP_CLI_VERSION.value,
		...optionalContextValue("commit", readBuildCommit(env, options.context?.commit)),
		...optionalContextValue(
			"deviceId",
			options.context?.deviceId ??
				firstNonBlank(env.STEP_CLI_DEVICE_ID, env.STEP_HARNESS_DEVICE_ID, env.STEPCLI_DEVICE_ID),
		),
		...optionalContextValue(
			"uid",
			options.context?.uid ?? firstNonBlank(env.STEP_CLI_UID, env.STEP_HARNESS_UID, env.STEPCLI_UID),
		),
		...optionalContextValue("username", readTelemetryUsername(env, options.context?.username)),
	};
	// Session is the one context field that changes during a process. Keep it on
	// each pending record so a later /new or /resume cannot relabel old events.
	let foregroundSessionId = initialSessionId;
	let buffer: PendingTelemetryRecord[] = [];
	let trackVersion = 0;
	let timer: ReturnType<typeof setInterval> | undefined;
	const inFlight = new Set<Promise<void>>();
	let stopped = false;
	let appendTail = Promise.resolve();
	let pruneStarted: Promise<void> | undefined;
	type PendingSpoolWrite = {
		readonly target: string;
		readonly payload: string;
		readonly records: readonly StepTelemetryRecord[];
		completed: boolean;
		syncWritten: boolean;
	};
	// A threshold/timer flush removes records from `buffer` before its async
	// sinks run. Keep every not-yet-completed spool append here as a second,
	// synchronous recovery queue for process.exit().
	const pendingSpoolWrites = new Set<PendingSpoolWrite>();

	const pruneSpool = (): Promise<void> => {
		if (!spoolDirectory || spoolRetentionDays <= 0) return Promise.resolve();
		pruneStarted ??= pruneExpiredSpoolFiles(spoolDirectory, spoolRetentionDays);
		return pruneStarted;
	};

	const materializeRecord = (record: PendingTelemetryRecord): StepTelemetryRecord => {
		const { sessionId, ...rest } = record;
		return {
			...rest,
			context: {
				...context,
				...(sessionId ? { sessionId } : undefined),
			},
		};
	};

	const readSpoolEventIds = (target: string): Set<string> => {
		const ids = new Set<string>();
		try {
			for (const line of readFileSync(target, "utf8").split("\n")) {
				if (!line) continue;
				try {
					const record: unknown = JSON.parse(line);
					if (
						typeof record === "object" &&
						record !== null &&
						"eventId" in record &&
						typeof record.eventId === "string"
					) {
						ids.add(record.eventId);
					}
				} catch {
					// Preserve malformed legacy lines; only dedupe known records.
				}
			}
		} catch {
			// A missing target simply means every incoming record is new.
		}
		return ids;
	};

	const dedupeSpoolFileSync = (target: string): void => {
		try {
			const original = readFileSync(target, "utf8");
			const seen = new Set<string>();
			let changed = false;
			const lines = original.split("\n");
			const kept = lines.filter((line) => {
				if (!line) return true;
				try {
					const record: unknown = JSON.parse(line);
					if (
						typeof record === "object" &&
						record !== null &&
						"eventId" in record &&
						typeof record.eventId === "string"
					) {
						if (seen.has(record.eventId)) {
							changed = true;
							return false;
						}
						seen.add(record.eventId);
					}
				} catch {
					// Preserve malformed legacy lines.
				}
				return true;
			});
			if (changed) writeFileSync(target, kept.join("\n"), { encoding: "utf8", mode: 0o600 });
		} catch {
			// Best effort only; the regular append remains the durable fallback.
		}
	};

	const appendSync = (target: string, payload: string, records?: readonly StepTelemetryRecord[]): boolean => {
		if (!spoolDirectory) return false;
		try {
			mkdirSync(spoolDirectory, { recursive: true, mode: 0o700 });
			if (!records || records.length === 0) {
				appendFileSync(target, payload, { encoding: "utf8", mode: 0o600 });
				return true;
			}
			const existingIds = readSpoolEventIds(target);
			const freshRecords = records.filter((record) => !existingIds.has(record.eventId));
			if (freshRecords.length > 0) {
				const freshPayload = `${freshRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
				appendFileSync(target, freshPayload, { encoding: "utf8", mode: 0o600 });
			}
			return true;
		} catch {
			// Telemetry must never turn a normal process exit into an error.
			return false;
		}
	};

	const syncExitSpool = (): void => {
		if (!spoolDirectory) return;
		// Batches already removed from `buffer` are the important case: their
		// async append callbacks may never run once process.exit() starts.
		for (const pending of pendingSpoolWrites) {
			if (pending.completed || pending.syncWritten) continue;
			// Mark before writing so an async continuation that is still queued will
			// observe the state and skip a second append.
			pending.syncWritten = true;
			if (appendSync(pending.target, pending.payload, pending.records)) {
				pending.completed = true;
				pendingSpoolWrites.delete(pending);
			} else {
				pending.syncWritten = false;
			}
		}

		if (buffer.length === 0) return;
		const records = buffer.map(materializeRecord);
		const target = join(spoolDirectory, `events-${records[0]?.at.slice(0, 10) ?? "unknown"}.jsonl`);
		const payload = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
		if (appendSync(target, payload, records)) buffer = [];
	};
	const removeExitListenerIfDrained = (): void => {
		if (buffer.length === 0 && pendingSpoolWrites.size === 0) process.off("exit", syncExitSpool);
	};
	process.once("exit", syncExitSpool);

	const stopTimer = (): void => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	const startTimer = (): void => {
		if (timer || flushIntervalMs <= 0) return;
		timer = setInterval(() => {
			void flush();
		}, flushIntervalMs);
		timer.unref?.();
	};

	const writeSpool = (records: readonly StepTelemetryRecord[], prefix: string): Promise<void> => {
		if (records.length === 0 || !spoolDirectory) return Promise.resolve();
		const target = join(spoolDirectory, `${prefix}-${records[0]?.at.slice(0, 10) ?? "unknown"}.jsonl`);
		const payload = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
		const pending: PendingSpoolWrite = {
			target,
			payload,
			records,
			completed: false,
			syncWritten: false,
		};
		pendingSpoolWrites.add(pending);
		// Serialize appends so concurrent threshold/timer flushes cannot interleave
		// partial JSON lines.
		appendTail = appendTail
			.catch(() => undefined)
			.then(async () => {
				if (pending.completed || pending.syncWritten) return;
				await pruneSpool();
				await mkdir(spoolDirectory, { recursive: true, mode: 0o700 });
				if (pending.completed || pending.syncWritten) return;
				await appendFile(target, payload, { encoding: "utf8", mode: 0o600 });
				if (pending.syncWritten) dedupeSpoolFileSync(target);
				pending.completed = true;
				pendingSpoolWrites.delete(pending);
			});
		return appendTail;
	};

	const sendHttp = async (records: readonly StepTelemetryRecord[], final: boolean): Promise<void> => {
		if (!endpoint || records.length === 0) return;
		const fetchImpl = options.fetchImpl ?? globalThis.fetch;
		if (!fetchImpl) throw new Error("fetch is unavailable");
		const delays = final ? [] : retryBackoffsMs;
		for (let attempt = 0; ; attempt += 1) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
			timeout.unref?.();
			let response: Response;
			try {
				response = await fetchImpl(endpoint, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json",
					},
					body: JSON.stringify({ events: records }),
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timeout);
			}
			if (response.ok) return;
			if (attempt >= delays.length || !isRetryableStatus(response.status)) {
				throw new Error(`telemetry collector returned ${response.status}`);
			}
			await sleep(delays[attempt]!);
		}
	};

	const flushBatch = async (records: readonly StepTelemetryRecord[], final: boolean): Promise<void> => {
		// Keep a local copy even when HTTP succeeds. This mirrors the old Step
		// client, whose spool is the durable audit trail and replay source.
		const spool = writeSpool(records, DEFAULT_SPOOL_FILE_PREFIX);
		const http = sendHttp(records, final);
		const results = await Promise.allSettled([spool, http]);
		if (results[1]?.status === "rejected") {
			await writeSpool(records, FAILED_SPOOL_FILE_PREFIX).catch(() => undefined);
		}
		await appendTail.catch(() => undefined);
	};

	const startBatch = (pending: readonly PendingTelemetryRecord[], final: boolean): void => {
		if (pending.length === 0) return;
		const task = flushBatch(pending.map(materializeRecord), final).catch(() => undefined);
		inFlight.add(task);
		void task.finally(() => inFlight.delete(task));
	};

	const flushWithOptions = async (final: boolean): Promise<void> => {
		// Keep taking snapshots until no producer changed the queue while this
		// flush was waiting. A single inFlight snapshot is insufficient: a
		// threshold flush can finish while a second batch is queued in `buffer`,
		// and that second batch must be part of the same explicit flush barrier.
		for (;;) {
			const versionAtStart = trackVersion;
			if (buffer.length > 0) {
				const pending = buffer;
				buffer = [];
				startBatch(pending, final);
			}
			await Promise.allSettled([...inFlight]);
			await appendTail.catch(() => undefined);
			if (buffer.length === 0 && inFlight.size === 0 && trackVersion === versionAtStart) return;
		}
	};
	const flush = (): Promise<void> => flushWithOptions(false);

	startTimer();
	return {
		enabled: true,
		endpoint,
		spoolDirectory,
		track<K extends StepTelemetryEventName>(
			event: K,
			properties: StepTelemetryPropertiesFor<K>,
			options?: StepTelemetryTrackOptions,
		): void {
			if (stopped) return;
			const explicitSessionId = normalizeStepWireSessionId(options?.sessionId ?? options?.context?.sessionId);
			const record: PendingTelemetryRecord = {
				eventId: randomUUID(),
				event,
				at: clock(),
				properties: copyProperties(event, properties as StepTelemetryProperties),
				...((explicitSessionId ?? foregroundSessionId)
					? { sessionId: explicitSessionId ?? foregroundSessionId }
					: undefined),
			};
			buffer.push(record);
			trackVersion += 1;
			if (buffer.length > maxQueued) buffer.splice(0, buffer.length - maxQueued);
			if (buffer.length >= flushThreshold) void flush();
		},
		setContext(patch: StepTelemetryContextPatch): void {
			if (patch.sessionId !== undefined) foregroundSessionId = normalizeStepWireSessionId(patch.sessionId);
			context = {
				...context,
				...(patch.channel !== undefined
					? { channel: normalizeContextValue(patch.channel) ?? context.channel }
					: undefined),
				...(patch.version !== undefined
					? {
							version: normalizeVersionContext(patch.version) ?? context.version,
						}
					: undefined),
				...(patch.platform !== undefined
					? {
							platform: normalizeContextValue(patch.platform) ?? context.platform,
						}
					: undefined),
				...optionalContextValue("deviceId", patch.deviceId),
				...optionalContextValue("uid", patch.uid),
				...optionalContextValue("username", patch.username),
				...optionalContextValue("commit", patch.commit),
			};
		},
		flush,
		async shutdown(shutdownOptions): Promise<void> {
			if (stopped) return;
			stopped = true;
			stopTimer();
			const timeoutMs = shutdownOptions?.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
			let finalFlushSettled = false;
			const finalFlush = flushWithOptions(true).finally(() => {
				finalFlushSettled = true;
				removeExitListenerIfDrained();
			});
			await withTimeout(finalFlush, timeoutMs);
			// A completed flush no longer needs the process-level fallback. If the
			// timeout won the race, leave the listener installed until the async
			// sinks settle (or until process.exit() invokes the synchronous drain).
			if (finalFlushSettled) removeExitListenerIfDrained();
		},
	};
}

/**
 * Sample process and host resources without coupling the sampler to a concrete
 * telemetry runtime. The collector is intentionally opt-in: callers that do
 * not want periodic metrics can keep the existing lightweight runtime, while
 * the Step entrypoint can enable parity with the legacy process bootstrap.
 */
export function createStepSystemMetricsCollector(
	reporter: StepTelemetryReporter,
	options: StepSystemMetricsCollectorOptions = {},
): StepSystemMetricsCollector {
	const intervalMs = nonNegativeInt(options.intervalMs, DEFAULT_SYSTEM_METRICS_INTERVAL_MS);
	const warmupMs =
		options.warmupMs === null ? null : nonNegativeInt(options.warmupMs, DEFAULT_SYSTEM_METRICS_WARMUP_MS);
	const now = options.now ?? process.hrtime.bigint;
	let intervalTimer: ReturnType<typeof setInterval> | undefined;
	let warmupTimer: ReturnType<typeof setTimeout> | undefined;
	let previousCpu = process.cpuUsage();
	let previousAt = readMonotonicNow(now);

	const sample = (): void => {
		try {
			const at = readMonotonicNow(now);
			const elapsedUs = safeFiniteMetric(Number(at - previousAt) / 1_000);
			const cpu = process.cpuUsage(previousCpu);
			previousCpu = process.cpuUsage();
			previousAt = at;
			const memory = process.memoryUsage();
			const host = readHostMetrics();
			safeTrackRuntime(reporter, "system_metrics", {
				process_uptime_ms: safeFiniteMetric(process.uptime() * 1_000),
				rss_bytes: safeFiniteMetric(memory.rss),
				heap_used_bytes: safeFiniteMetric(memory.heapUsed),
				heap_total_bytes: safeFiniteMetric(memory.heapTotal),
				external_bytes: safeFiniteMetric(memory.external),
				cpu_user_us: safeFiniteMetric(cpu.user),
				cpu_system_us: safeFiniteMetric(cpu.system),
				cpu_elapsed_us: elapsedUs,
				load_avg_1m: roundMetric(host.loadAverage, 2),
				free_mem_bytes: safeFiniteMetric(host.freeMemory),
				total_mem_bytes: safeFiniteMetric(host.totalMemory),
				cpu_count: host.cpuCount,
			});
		} catch {
			// A platform-specific resource API can fail in constrained runtimes. Stop
			// future sampling rather than allowing a timer to repeatedly throw.
			stop();
		}
	};
	const sampleSafely = (): void => {
		try {
			sample();
		} catch {
			stop();
		}
	};
	const start = (): void => {
		if (intervalTimer || warmupTimer) return;
		if (warmupMs !== null && warmupMs > 0) {
			warmupTimer = setTimeout(() => {
				warmupTimer = undefined;
				sampleSafely();
			}, warmupMs);
			warmupTimer.unref?.();
		}
		if (intervalMs > 0) {
			intervalTimer = setInterval(sampleSafely, intervalMs);
			intervalTimer.unref?.();
		}
	};
	function stop(): void {
		if (warmupTimer) clearTimeout(warmupTimer);
		if (intervalTimer) clearInterval(intervalTimer);
		warmupTimer = undefined;
		intervalTimer = undefined;
	}

	return { start, stop, sample: sampleSafely };
}

/**
 * Install process-level observers for failures that bypass the CLI catch
 * block. `uncaughtExceptionMonitor` preserves Node's default crash behavior;
 * the returned disposer lets the normal shutdown path remove both listeners.
 */
export function installStepTelemetryCrashHandlers(runtime: StepTelemetryReporter): StepTelemetryCrashHandlers {
	const onUncaughtException = (error: unknown): void => {
		trackStepTelemetryCrash(runtime, error, "uncaught_exception");
		void flushReporter(runtime);
	};
	const onUnhandledRejection = (reason: unknown): void => {
		trackStepTelemetryCrash(runtime, reason, "unhandled_rejection");
		void flushReporter(runtime);
	};
	process.on("uncaughtExceptionMonitor", onUncaughtException);
	process.on("unhandledRejection", onUnhandledRejection);
	let disposed = false;
	return {
		dispose(): void {
			if (disposed) return;
			disposed = true;
			process.off("uncaughtExceptionMonitor", onUncaughtException);
			process.off("unhandledRejection", onUnhandledRejection);
		},
	};
}

/** Record a handled entrypoint/runtime error without exposing its message. */
export function trackStepTelemetryError(
	reporter: StepTelemetryReporter,
	error: unknown,
	where: string,
	retryable = false,
): void {
	safeTrackRuntime(reporter, "error_raised", {
		error_type: readTelemetryErrorType(error),
		where: normalizeTelemetryDimension(where),
		retryable: retryable === true,
	});
}

/** Record a process-level failure that bypassed the entrypoint catch block. */
export function trackStepTelemetryCrash(reporter: StepTelemetryReporter, error: unknown, source: string): void {
	safeTrackRuntime(reporter, "crash", {
		error_type: readTelemetryErrorType(error),
		source: normalizeTelemetryDimension(source),
	});
}

function flushReporter(reporter: StepTelemetryReporter): Promise<void> {
	const flush = (reporter as StepTelemetryRuntime).flush;
	if (typeof flush !== "function") return Promise.resolve();
	try {
		return Promise.resolve(flush.call(reporter)).catch(() => undefined);
	} catch {
		return Promise.resolve();
	}
}

function readTelemetryErrorType(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		return normalizeTelemetryDimension(code ?? error.name);
	}
	return normalizeTelemetryDimension(typeof error);
}

function normalizeTelemetryDimension(value: string): string {
	const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
	return normalized ? normalized.slice(0, 128) : "unknown";
}

function readMonotonicNow(now: () => bigint): bigint {
	try {
		const value = now();
		return typeof value === "bigint" ? value : process.hrtime.bigint();
	} catch {
		return process.hrtime.bigint();
	}
}

function readHostMetrics(): {
	loadAverage: number;
	freeMemory: number;
	totalMemory: number;
	cpuCount: number;
} {
	let loadAverage = 0;
	let freeMemory = 0;
	let totalMemory = 0;
	let cpuCount = 0;
	try {
		loadAverage = loadavg()[0] ?? 0;
	} catch {
		// Keep zero defaults when the host does not expose load averages.
	}
	try {
		freeMemory = freemem();
		totalMemory = totalmem();
	} catch {
		// Keep zero defaults when host memory APIs are unavailable.
	}
	try {
		cpuCount = Math.max(0, cpus().length);
	} catch {
		// Keep zero defaults when CPU enumeration is restricted.
	}
	return { loadAverage, freeMemory, totalMemory, cpuCount };
}

function safeFiniteMetric(value: number): number {
	return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function roundMetric(value: number, digits: number): number {
	if (!Number.isFinite(value) || value < 0) return 0;
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function safeTrackRuntime(
	reporter: StepTelemetryReporter,
	event: StepTelemetryEventName,
	properties: StepTelemetryProperties,
): void {
	try {
		void Promise.resolve(reporter.track(event, properties)).catch(() => undefined);
	} catch {
		// Telemetry must never alter the host process or agent loop.
	}
}

/** Resolve the old Step endpoint aliases and release-channel default. */
export function readTelemetryEndpoint(
	env: NodeJS.ProcessEnv = process.env,
	config?: StepTelemetryRuntimeOptions["config"],
): string | undefined {
	const explicit = firstNonBlank(
		env.STEP_CLI_TELEMETRY_ENDPOINT,
		env.STEP_HARNESS_TELEMETRY_ENDPOINT,
		env.STEPCLI_TELEMETRY_ENDPOINT,
	);
	if (explicit) return explicit;
	// A persisted endpoint is honored only by release builds. This is the old
	// Step safety boundary: a source checkout may spool locally, while an
	// explicit environment endpoint remains the documented dev test escape hatch.
	const configured = normalizeEndpoint(config?.endpoint);
	if (configured && readBuildChannel(env) === "release") return configured;
	// An unset/unknown channel is deliberately treated as dev so source
	// checkouts continue to spool locally. Released binaries set this at build
	// time, matching the legacy endpoint resolver.
	return readBuildChannel(env) === "release" ? RELEASE_TELEMETRY_ENDPOINT : undefined;
}

/**
 * Resolve Step's telemetry gates in the same order as the legacy runtime:
 * test runtime, environment opt-out, persistent opt-out, then endpoint
 * precedence (environment > release config > release default). A dev build
 * still records to its local spool, but never reaches a collector unless an
 * endpoint is explicitly supplied through the environment or call options.
 */
export function resolveStepTelemetrySettings(
	env: NodeJS.ProcessEnv = process.env,
	config?: StepTelemetryRuntimeOptions["config"],
): StepResolvedTelemetrySettings {
	if (isTestRuntime(env)) return { enabled: false, spoolEnabled: false, reason: "test-runtime" };
	if (
		readFlag(env.STEP_CLI_DISABLE_TELEMETRY) ||
		readFlag(env.STEP_HARNESS_DISABLE_TELEMETRY) ||
		readFlag(env.STEP_HARNESS_TELEMETRY_DISABLED) ||
		readFlag(env.STEPCLI_DISABLE_TELEMETRY)
	) {
		return { enabled: false, spoolEnabled: false, reason: "env-opt-out" };
	}
	if (config?.enabled === false) return { enabled: false, spoolEnabled: false, reason: "config-opt-out" };
	return {
		enabled: true,
		spoolEnabled: config?.spool !== false,
		...(readTelemetryEndpoint(env, config) ? { endpoint: readTelemetryEndpoint(env, config) } : undefined),
	};
}

/** Compatibility spelling used by the former Step runtime's settings module. */
export const resolveTelemetrySettings = resolveStepTelemetrySettings;

function readBuildChannel(env: NodeJS.ProcessEnv): string {
	return readStepBuildIdentity(env).channel;
}

/**
 * Read the build commit while preserving Bun's compile-time environment.
 * Runtime aliases remain accepted for source launches and old release jobs;
 * the static value is only a fallback when no runtime alias is present.
 */
function readBuildCommit(env: NodeJS.ProcessEnv, explicit?: string): string | undefined {
	if (typeof explicit === "string" && explicit.trim()) return normalizeStepCommit(explicit);
	return readStepBuildIdentity(env).commit;
}

function createDisabledRuntime(): StepTelemetryRuntime {
	return {
		enabled: false,
		endpoint: undefined,
		spoolDirectory: undefined,
		track() {},
		setContext() {},
		async flush() {},
		async shutdown() {},
	};
}

function isTestRuntime(env: NodeJS.ProcessEnv): boolean {
	return env.NODE_ENV === "test" || env.VITEST !== undefined;
}

function readFlag(value: string | undefined): boolean {
	return value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isRetryableStatus(status: number): boolean {
	// Keep this vocabulary identical to the legacy shared HTTP retry helper.
	return status === 429 || status >= 500;
}

function normalizeEndpoint(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = new URL(trimmed);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

function normalizePath(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed || undefined;
}

function positiveInt(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) && value !== undefined && value > 0 ? Math.trunc(value) : fallback;
}

function nonNegativeInt(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) && value !== undefined && value >= 0 ? Math.trunc(value) : fallback;
}

/** A retry delay must not keep an otherwise idle CLI process alive. */
function defaultUnrefSleep(milliseconds: number): Promise<void> {
	return new Promise<void>((resolve) => {
		const handle = setTimeout(resolve, milliseconds);
		handle.unref?.();
	});
}

function normalizeContextValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
	return normalized ? normalized.slice(0, 256) : undefined;
}

function firstNonBlank(...values: readonly (string | undefined)[]): string | undefined {
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

/** Prune both normal and failed batches once per runtime startup. */
async function pruneExpiredSpoolFiles(directory: string, retentionDays: number): Promise<void> {
	if (retentionDays <= 0) return;
	try {
		const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1_000;
		const entries = await readdir(directory);
		await Promise.all(
			entries
				.filter((entry) => /^(?:events|failed)-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(entry))
				.map(async (entry) => {
					const target = join(directory, entry);
					try {
						const info = await stat(target);
						if (info.mtimeMs < cutoff) await rm(target, { force: true });
					} catch {
						// Files can disappear concurrently; pruning is best effort.
					}
				}),
		);
	} catch {
		// A missing or unreadable spool directory is created by the subsequent write.
	}
}

function normalizeVersionContext(value: string | undefined): string | undefined {
	return normalizeStepHarnessVersionValue(value);
}

function optionalContextValue<K extends keyof Omit<StepTelemetryContext, "channel" | "platform" | "sessionId">>(
	key: K,
	value: string | undefined,
): Pick<StepTelemetryContext, K> | Record<string, never> {
	const normalized = normalizeTelemetryContextField(key, value);
	return normalized ? ({ [key]: normalized } as Pick<StepTelemetryContext, K>) : {};
}

function normalizeTelemetryContextField(
	key: keyof Omit<StepTelemetryContext, "channel" | "platform" | "sessionId">,
	value: string | undefined,
): string | undefined {
	switch (key) {
		case "commit":
			return normalizeStepCommit(value);
		case "deviceId":
			return normalizeStepDeviceId(value);
		case "uid":
			return normalizeStepUid(value);
		case "username":
			return normalizeTelemetryUsername(value);
	}
}

function copyProperties(event: StepTelemetryEventName, properties: StepTelemetryProperties): StepTelemetryProperties {
	const copy: Record<string, StepTelemetryPrimitive> = {};
	const allowed = isKnownStepTelemetryEvent(event) ? new Set(STEP_TELEMETRY_EVENT_PROPERTY_NAMES[event]) : undefined;
	for (const [key, value] of Object.entries(properties)) {
		// Known event fields are an allowlist. Unknown extension events retain the
		// previous conservative key filter so a typo cannot turn a prompt/body/path
		// field into an outbound analytics channel.
		if (allowed ? !allowed.has(key) : isUnsafePropertyKey(key)) continue;
		if (typeof value === "string") {
			copy[key] = redactTelemetryString(value);
		} else if (typeof value === "number") {
			if (Number.isFinite(value)) copy[key] = value;
		} else if (typeof value === "boolean" || value === null) {
			copy[key] = value;
		}
	}
	return copy;
}

/** Event properties are intentionally primitive; these names are user-content channels. */
function isUnsafePropertyKey(key: string): boolean {
	return /(?:^|_)(?:prompt|content|body|text|message|arguments|args|command|url|path|token|secret|password)(?:$|_)/iu.test(
		key,
	);
}

const REDACTED_PATH = "<redacted:path>";
const NODE_MODULES_MARKER = "node_modules/";
const LABELED_REDACTION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
	[/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu, "<redacted:email>"],
	[/https?:\/\/[^\s"'<>]+/giu, "<redacted:url>"],
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/gu, "<redacted:jwt>"],
	[/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/gu, "<redacted:token>"],
	[/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, "<redacted:token>"],
	[/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu, "<redacted:token>"],
	[/\b(?:sk|pk|ak)-[A-Za-z0-9_-]{16,}\b/gu, "<redacted:api-key>"],
];

// The path grammar mirrors the legacy client and deliberately accepts Unicode
// segments. The previous ASCII-only expression leaked CJK home directories.
const PATH_SEGMENT = String.raw`[^\s/\\:*?"'\x60<>|,;()\[\]{}]`;
const PATH_START = String.raw`(?:(?<![^\s"'\x60=(\[{,;:])|(?<=:\/\/))`;
const POSIX_PATH_SOURCE = `${PATH_START}(?:/(?:${PATH_SEGMENT}+(?: ${PATH_SEGMENT}+)*(?=/)|${PATH_SEGMENT}+)){2,}/?`;
const WINDOWS_PATH_SEGMENT = String.raw`[^\s\\/:*?"<>|]`;
const WINDOWS_PATH_SOURCE = String.raw`(?<!\w)[A-Za-z]:\\(?:(?:${WINDOWS_PATH_SEGMENT}+(?: ${WINDOWS_PATH_SEGMENT}+)*(?=\\)|${WINDOWS_PATH_SEGMENT}+)\\?){2,}`;
const ABSOLUTE_PATH = new RegExp(`${WINDOWS_PATH_SOURCE}|${POSIX_PATH_SOURCE}`, "gu");

/** Redact the same sensitive shapes as the legacy Step telemetry client. */
export function redactTelemetryString(value: string): string {
	let output = value.replace(ABSOLUTE_PATH, collapseAbsolutePath);
	for (const [pattern, replacement] of LABELED_REDACTION_PATTERNS) {
		output = output.replace(pattern, replacement);
	}
	return output;
}

/**
 * Read the launcher-provided username using the legacy Step boundary.
 *
 * Usernames are copied to every telemetry envelope, so accepting arbitrary
 * strings here would turn an environment variable into an unbounded data
 * channel. Keep the old 64-character limit and conservative character set while
 * accepting the Step CLI variable.
 */
export function readTelemetryUsername(env: NodeJS.ProcessEnv, explicit?: string): string | undefined {
	return normalizeTelemetryUsername(explicit ?? firstNonBlank(env.STEP_CLI_USER, env.STEP_HARNESS_USER));
}

function normalizeTelemetryUsername(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const raw = value?.trim();
	if (!raw || raw.length > MAX_USERNAME_LENGTH) return undefined;
	return PLAUSIBLE_USERNAME.test(raw) ? raw : undefined;
}

function collapseAbsolutePath(match: string): string {
	const index = match.indexOf(NODE_MODULES_MARKER);
	return index === -1 ? REDACTED_PATH : match.slice(index);
}

async function withTimeout(task: Promise<void>, timeoutMs: number): Promise<void> {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		handle = setTimeout(resolve, timeoutMs);
		handle.unref?.();
	});
	try {
		await Promise.race([task.catch(() => undefined), timeout]);
	} finally {
		if (handle) clearTimeout(handle);
	}
}
