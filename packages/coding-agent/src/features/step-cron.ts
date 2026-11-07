/** Durable and session-only five-field cron scheduling for Step. */

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type { AgentToolResult } from "@step-harness/agent-core";
import { type Static, Type } from "typebox";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
} from "../core/extensions/types.ts";
import type { StepTelemetryProperties, StepTelemetryReporter } from "../step/telemetry.ts";

const TICK_INTERVAL_MS = 1_000;
/** Cross-process pickup cadence; firing precision comes from the in-memory view. */
const DURABLE_REFRESH_INTERVAL_MS = 30_000;
const DEFAULT_MAX_JOBS = 50;
const AUTO_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SEARCH_MINUTES = 366 * 24 * 60;
/**
 * Kernel ceilings, not a product policy. A host that shows a form may apply a
 * stricter cap of its own; it must not narrow these, because the
 * persisted-record reader shares them — a prompt written by an earlier build
 * that exceeded a narrowed value would be treated as an unsupported record and
 * silently stop being scheduled.
 *
 * The two behave differently on purpose, matching the original records: an
 * oversized prompt is rejected, while an oversized title is truncated. A title
 * is presentation; a prompt is what the task will do, so silently shortening it
 * would change the work.
 */
export const CRON_MAX_PROMPT_LENGTH = 16_000;
export const CRON_MAX_TITLE_LENGTH = 200;
const MAX_PROMPT_LENGTH = CRON_MAX_PROMPT_LENGTH;
const MAX_CRON_LENGTH = 200;
const MAX_LOCK_AGE_MS = 60_000;

type TimerHandle = ReturnType<typeof setInterval>;

export type CronJobStatus = "enabled" | "paused" | "expired" | "completed";
/**
 * Why a task is in its current status when the status alone is ambiguous.
 *
 * `session_missing` is the one the host sets: the bound session file was
 * deleted, so the task can never deliver and is paused rather than retried.
 */
export type CronStatusReason = "session_missing";
export type CronRunStatus = "delivered" | "failed" | "missed" | "skipped" | "blocked";

/**
 * A scheduled job. `schemaVersion: 1` is the original CLI record; v2 adds the
 * optional desktop fields below. The CLI ignores fields it does not use.
 */
export interface CronJob {
	schemaVersion: 1 | 2;
	id: string;
	cron: string;
	prompt: string;
	recurring: boolean;
	/** Explicit interval schedule; when set, cron is only a validation/fallback expression. */
	intervalHours?: number;
	/** One-shot absolute fire time. */
	runAt?: number;
	durable: boolean;
	createdAt: number;
	nextFireAt: number;
	lastFiredAt?: number;
	autoExpireAt?: number;
	workspace?: string;
	sessionId?: string;
	/**
	 * Set when the host created the bound session for this task rather than
	 * binding a session the user already had. The sidebar uses it to place the
	 * session under scheduled tasks instead of guessing from its cwd.
	 */
	sessionCreated?: boolean;
	title?: string;
	/** Why the task is not running, when its status alone does not say it. */
	statusReason?: CronStatusReason;
	status?: CronJobStatus;
	enabled?: boolean;
	inputs?: { skills?: string[] };
	model?: { provider: string; modelId?: string; thinkingLevel?: string };
	permissionPreset?: string;
	fullAccessAcknowledged?: boolean;
	delivery?: { lark?: { target: string; format?: "markdown" | "text" } };
	expiresAt?: number;
	runCount?: number;
	lastRunId?: string;
	lastStatus?: CronRunStatus;
	lastError?: string;
	origin?: "agent" | "desktop" | "legacy";
	jitter?: boolean;
}

export interface CronCreateOptions {
	id?: string;
	workspace?: string;
	sessionId?: string;
	sessionCreated?: boolean;
	title?: string;
	status?: CronJobStatus;
	statusReason?: CronStatusReason;
	enabled?: boolean;
	inputs?: { skills?: string[] };
	model?: { provider: string; modelId?: string; thinkingLevel?: string };
	permissionPreset?: string;
	fullAccessAcknowledged?: boolean;
	intervalHours?: number;
	runAt?: number;
	delivery?: { lark?: { target: string; format?: "markdown" | "text" } };
	expiresAt?: number;
	origin?: "agent" | "desktop" | "legacy";
	/** null keeps the record indefinitely; undefined keeps the legacy seven-day guard for recurring jobs. */
	autoExpireMs?: number | null;
	jitter?: boolean;
}

export interface CronUpdatePatch {
	cron?: string;
	prompt?: string;
	title?: string;
	inputs?: { skills?: string[] };
	model?: { provider: string; modelId?: string; thinkingLevel?: string };
	permissionPreset?: string | null;
	fullAccessAcknowledged?: boolean | null;
	delivery?: { lark?: { target: string; format?: "markdown" | "text" } };
	expiresAt?: number | null;
	status?: CronJobStatus;
	/** Host note for why a task was paused; null clears it. */
	statusReason?: CronStatusReason | null;
	recurring?: boolean;
	intervalHours?: number | null;
	runAt?: number | null;
	runCount?: number;
}

export interface CronCreateResult {
	job: CronJob;
	nextFireAt: number;
}

interface ParsedCronField {
	values: Set<number>;
	wildcard: boolean;
}

/** A small, dependency-free five-field parser used behind the runtime seam. */
export class SimpleCronExpression {
	private readonly minute: ParsedCronField;
	private readonly hour: ParsedCronField;
	private readonly dayOfMonth: ParsedCronField;
	private readonly month: ParsedCronField;
	private readonly dayOfWeek: ParsedCronField;

	private constructor(expression: string) {
		const fields = expression.trim().split(/\s+/u);
		if (fields.length !== 5) throw new Error("Cron expressions must contain exactly five fields");
		this.minute = parseField(fields[0] ?? "", 0, 59, "minute");
		this.hour = parseField(fields[1] ?? "", 0, 23, "hour");
		this.dayOfMonth = parseField(fields[2] ?? "", 1, 31, "day-of-month");
		this.month = parseField(fields[3] ?? "", 1, 12, "month");
		this.dayOfWeek = parseField(fields[4] ?? "", 0, 7, "day-of-week", true);
	}

	static parse(expression: string): SimpleCronExpression {
		if (typeof expression !== "string" || expression.trim().length === 0) {
			throw new Error("Cron expression must be a non-empty string");
		}
		if (expression.trim().length > MAX_CRON_LENGTH)
			throw new Error(`Cron expression exceeds ${MAX_CRON_LENGTH} characters`);
		return new SimpleCronExpression(expression);
	}

	matches(date: Date): boolean {
		const dayOfWeek = date.getDay();
		const domMatches = this.dayOfMonth.values.has(date.getDate());
		const dowMatches = this.dayOfWeek.values.has(dayOfWeek);
		const dayMatches =
			this.dayOfMonth.wildcard || this.dayOfWeek.wildcard ? domMatches && dowMatches : domMatches || dowMatches;
		return (
			this.minute.values.has(date.getMinutes()) &&
			this.hour.values.has(date.getHours()) &&
			dayMatches &&
			this.month.values.has(date.getMonth() + 1)
		);
	}

	/** Return the first matching local-time minute strictly after `afterMs`. */
	next(afterMs: number): number {
		if (!Number.isFinite(afterMs)) throw new Error("Cron base time must be finite");
		const minute = Math.floor(afterMs / 60_000) * 60_000;
		for (let offset = 1; offset <= MAX_SEARCH_MINUTES; offset++) {
			// Calendar setters skip the repeated hour at the fall-back DST boundary.
			const candidate = new Date(minute + offset * 60_000);
			if (this.matches(candidate)) return candidate.getTime();
		}
		throw new Error("Cron expression has no occurrence within the supported search window");
	}
}

function parseField(text: string, min: number, max: number, name: string, normalizeSunday = false): ParsedCronField {
	if (!text) throw new Error(`Cron ${name} field is empty`);
	const values = new Set<number>();
	const wildcard = text.startsWith("*");
	for (const rawPart of text.split(",")) {
		if (!rawPart) throw new Error(`Cron ${name} field contains an empty item`);
		if ((rawPart.match(/\//gu) ?? []).length > 1) throw new Error(`Cron ${name} field contains multiple steps`);
		const [rawBase, rawStep] = rawPart.split("/", 2);
		if (rawStep !== undefined && !/^\d+$/u.test(rawStep))
			throw new Error(`Cron ${name} step must be a positive integer`);
		const step = rawStep === undefined ? 1 : Number(rawStep);
		if (!Number.isSafeInteger(step) || step < 1) throw new Error(`Cron ${name} step must be a positive integer`);
		let start: number;
		let end: number;
		if (rawBase === "*") {
			start = min;
			end = max;
		} else if (rawBase?.includes("-")) {
			if (!/^\d+-\d+$/u.test(rawBase)) throw new Error(`Cron ${name} range must contain two numeric values`);
			const [rawStart, rawEnd] = rawBase.split("-");
			start = parseNumber(rawStart ?? "", min, max, name);
			end = parseNumber(rawEnd ?? "", min, max, name);
			if (end < start) throw new Error(`Cron ${name} range must ascend`);
		} else {
			start = parseNumber(rawBase ?? "", min, max, name);
			end = start;
			if (rawStep !== undefined) throw new Error(`Cron ${name} steps require * or a range`);
		}
		for (let value = start; value <= end; value += step) {
			values.add(normalizeSunday && value === 7 ? 0 : value);
		}
	}
	if (values.size === 0) throw new Error(`Cron ${name} field has no values`);
	return { values, wildcard };
}

function parseNumber(value: string, min: number, max: number, name: string): number {
	if (!/^\d+$/u.test(value)) throw new Error(`Cron ${name} field must use numeric values`);
	const number = Number.parseInt(value, 10);
	if (!Number.isInteger(number) || number < min || number > max) {
		throw new Error(`Cron ${name} value ${value} is outside ${min}..${max}`);
	}
	return number;
}

export interface CronFileStoreOptions {
	lockMaxAgeMs?: number;
	warn?: (message: string) => void;
}

/** Versioned JSONL persistence with atomic replacement and an exclusive lock. */
export class CronFileStore {
	readonly filePath: string;
	private readonly lockMaxAgeMs: number;
	private readonly warn: (message: string) => void;
	private readonly warnedRows = new Set<string>();

	constructor(filePath: string, options: CronFileStoreOptions = {}) {
		this.filePath = path.resolve(filePath);
		this.lockMaxAgeMs = options.lockMaxAgeMs ?? MAX_LOCK_AGE_MS;
		this.warn = options.warn ?? ((message) => console.warn(`[step-cron] ${message}`));
	}

	load(): CronJob[] {
		return this.readRecords().records.flatMap(({ job }) => (job ? [job] : []));
	}

	save(jobs: readonly CronJob[]): void {
		this.update(() => jobs);
	}

	/** Hold the lock across read, mutation (including dispatch), and replacement. */
	update(mutate: (jobs: CronJob[]) => readonly CronJob[]): void {
		mkdirSync(path.dirname(this.filePath), { recursive: true });
		const lockPath = `${this.filePath}.lock`;
		const lockFd = this.acquireLock(lockPath);
		const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			const { content, records } = this.readRecords();
			const next = new Map(
				mutate(records.flatMap(({ job }) => (job ? [{ ...job }] : []))).map((job) => [job.id, job]),
			);
			const rows: string[] = [];
			for (const { raw, job } of records) {
				if (!job) {
					// A newer schema or a damaged row is not ours to delete.
					rows.push(raw);
					continue;
				}
				const updated = next.get(job.id);
				if (updated) {
					rows.push(JSON.stringify(updated) === JSON.stringify(job) ? raw : JSON.stringify(updated));
					next.delete(job.id);
				}
			}
			rows.push(...[...next.values()].map((job) => JSON.stringify(job)));
			const data = rows.length ? `${rows.join("\n")}\n` : "";
			if (data === content) return;
			writeFileSync(temporaryPath, data, { encoding: "utf8", mode: 0o600 });
			renameSync(temporaryPath, this.filePath);
		} finally {
			try {
				unlinkSync(temporaryPath);
			} catch {
				// The atomic rename already removed the temporary path.
			}
			closeSync(lockFd);
			try {
				unlinkSync(lockPath);
			} catch {
				// Another cleanup path may have removed the lock.
			}
		}
	}

	backupBeforeMigration(): void {
		try {
			copyFileSync(this.filePath, `${this.filePath}.bak`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private readRecords(): { content: string; records: Array<{ raw: string; job?: CronJob }> } {
		let content: string;
		try {
			content = readFileSync(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { content: "", records: [] };
			throw error;
		}
		const records: Array<{ raw: string; job?: CronJob }> = [];
		for (const [index, raw] of content.split(/\r?\n/u).entries()) {
			if (!raw.trim()) continue;
			let job: CronJob | undefined;
			try {
				job = parsePersistedJob(JSON.parse(raw));
			} catch {
				// Keep the original line even when it cannot be parsed.
			}
			if (!job && !this.warnedRows.has(raw)) {
				this.warnedRows.add(raw);
				this.warn(`Ignoring invalid or unsupported cron record at line ${index + 1}; preserving it on disk`);
			}
			records.push({ raw, job });
		}
		return { content, records };
	}

	private acquireLock(lockPath: string): number {
		try {
			return openSync(lockPath, "wx", 0o600);
		} catch (error) {
			if (isStaleLock(lockPath, this.lockMaxAgeMs)) {
				try {
					unlinkSync(lockPath);
					return openSync(lockPath, "wx", 0o600);
				} catch {
					// Fall through to the actionable error below.
				}
			}
			throw new Error(
				`Unable to acquire cron storage lock ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

function isStaleLock(lockPath: string, maxAgeMs: number): boolean {
	try {
		return Date.now() - statSync(lockPath).mtimeMs > maxAgeMs;
	} catch {
		return false;
	}
}

function parsePersistedJob(value: unknown): CronJob | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	if ((candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2) || candidate.durable !== true) return undefined;
	if (
		typeof candidate.id !== "string" ||
		!candidate.id.trim() ||
		typeof candidate.cron !== "string" ||
		typeof candidate.prompt !== "string" ||
		!candidate.prompt.trim() ||
		candidate.prompt.length > MAX_PROMPT_LENGTH ||
		typeof candidate.recurring !== "boolean" ||
		typeof candidate.createdAt !== "number" ||
		typeof candidate.nextFireAt !== "number"
	) {
		return undefined;
	}
	if (
		candidate.intervalHours !== undefined &&
		(typeof candidate.intervalHours !== "number" ||
			!Number.isInteger(candidate.intervalHours) ||
			candidate.intervalHours < 1 ||
			candidate.intervalHours > 168)
	)
		return undefined;
	const numbers = [
		candidate.createdAt,
		candidate.nextFireAt,
		candidate.lastFiredAt === undefined ? 0 : candidate.lastFiredAt,
		candidate.autoExpireAt === undefined ? 0 : candidate.autoExpireAt,
		candidate.expiresAt === undefined ? 0 : candidate.expiresAt,
	];
	if (!numbers.every((value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15))
		return undefined;
	if (candidate.workspace !== undefined && (typeof candidate.workspace !== "string" || !candidate.workspace.trim()))
		return undefined;
	if (candidate.sessionId !== undefined && (typeof candidate.sessionId !== "string" || !candidate.sessionId.trim()))
		return undefined;
	if (
		candidate.title !== undefined &&
		(typeof candidate.title !== "string" || candidate.title.length > CRON_MAX_TITLE_LENGTH)
	)
		return undefined;
	if (candidate.sessionCreated !== undefined && typeof candidate.sessionCreated !== "boolean") return undefined;
	if (candidate.statusReason !== undefined && candidate.statusReason !== "session_missing") return undefined;
	if (
		candidate.status !== undefined &&
		!["enabled", "paused", "expired", "completed"].includes(candidate.status as string)
	)
		return undefined;
	if (candidate.inputs !== undefined) {
		const inputs = candidate.inputs as Record<string, unknown>;
		if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return undefined;
		if (inputs.skills !== undefined) {
			if (!Array.isArray(inputs.skills) || inputs.skills.some((skill) => typeof skill !== "string"))
				return undefined;
		}
	}
	if (candidate.model !== undefined) {
		const model = candidate.model as Record<string, unknown>;
		if (!model || typeof model !== "object" || typeof model.provider !== "string" || !model.provider.trim())
			return undefined;
	}
	if (candidate.permissionPreset !== undefined && typeof candidate.permissionPreset !== "string") return undefined;
	if (candidate.fullAccessAcknowledged !== undefined && typeof candidate.fullAccessAcknowledged !== "boolean")
		return undefined;
	if (candidate.delivery !== undefined) {
		const delivery = candidate.delivery as Record<string, unknown>;
		if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) return undefined;
		if (delivery.lark !== undefined) {
			const lark = delivery.lark as Record<string, unknown>;
			if (!lark || typeof lark !== "object" || typeof lark.target !== "string" || !lark.target.trim())
				return undefined;
		}
	}
	if (candidate.runCount !== undefined && (typeof candidate.runCount !== "number" || candidate.runCount < 0))
		return undefined;
	if (candidate.lastRunId !== undefined && typeof candidate.lastRunId !== "string") return undefined;
	if (
		candidate.lastStatus !== undefined &&
		!["delivered", "failed", "missed", "skipped", "blocked"].includes(candidate.lastStatus as string)
	)
		return undefined;
	if (candidate.lastError !== undefined && typeof candidate.lastError !== "string") return undefined;
	if (candidate.origin !== undefined && !["agent", "desktop", "legacy"].includes(candidate.origin as string))
		return undefined;
	if (candidate.jitter !== undefined && typeof candidate.jitter !== "boolean") return undefined;
	try {
		SimpleCronExpression.parse(candidate.cron);
	} catch {
		return undefined;
	}
	return {
		...candidate,
		schemaVersion: candidate.schemaVersion,
		id: candidate.id,
		cron: candidate.cron,
		prompt: candidate.prompt,
		recurring: candidate.recurring,
		durable: true,
		createdAt: candidate.createdAt,
		nextFireAt: candidate.nextFireAt,
		...(typeof candidate.lastFiredAt === "number" ? { lastFiredAt: candidate.lastFiredAt } : {}),
		...(typeof candidate.autoExpireAt === "number" ? { autoExpireAt: candidate.autoExpireAt } : {}),
	} as CronJob;
}

export interface StepCronRuntimeOptions {
	now?: () => number;
	setInterval?: (callback: () => void, delayMs: number) => TimerHandle;
	clearInterval?: (timer: TimerHandle) => void;
	idFactory?: () => string;
	/** Optional sampling override for tests; production offsets are derived from the task id. */
	random?: () => number;
	/** Recurring interval fraction, capped at 0.5. Zero disables all jitter. */
	jitterRatio?: number;
	storagePath?: string;
	storeFactory?: (filePath: string) => CronFileStore;
	isIdle?: () => boolean;
	/** Per-job delivery gate; defaults to `isIdle`. */
	canDeliver?: (job: CronJob) => boolean;
	/** Batch missed-notice gate; defaults to `isIdle`. */
	canDeliverMissed?: () => boolean;
	maxJobs?: number;
	sendMessage?: (message: CronDelivery) => void;
	telemetry?: StepTelemetryReporter;
	warn?: (message: string) => void;
	/**
	 * Which records this host delivers and may change.
	 *
	 * Durable records are shared by file path, so a project folder can hold a
	 * record another host owns. Unowned records are still read and written back
	 * unchanged; they are only never fired, listed or mutated here.
	 */
	ownsJob?: (job: CronJob) => boolean;
}

/** The narrow surface a host facade needs to expose to the extension. */
export interface CronRuntimeLike {
	start(cwd: string, trusted: boolean): void;
	setContext(cwd: string): void;
	create(
		cron: string,
		prompt: string,
		recurring?: boolean,
		durable?: boolean,
		trusted?: boolean,
		options?: CronCreateOptions,
	): CronCreateResult;
	list(): CronJob[];
	delete(id: string): boolean;
	update?(id: string, patch: CronUpdatePatch): CronJob;
	setEnabled?(id: string, enabled: boolean): boolean;
	runNow?(id: string): CronJob;
	onTurnEnd(): void;
	stop(): void;
}

export interface CronDelivery {
	kind: "fire" | "missed";
	job?: CronJob;
	jobs?: CronJob[];
	/** A host-initiated run (`runNow`) leaves the schedule untouched. */
	manual?: boolean;
}

export class StepCronRuntime {
	private readonly now: () => number;
	private readonly startInterval: (callback: () => void, delayMs: number) => TimerHandle;
	private readonly stopInterval: (timer: TimerHandle) => void;
	private readonly idFactory: () => string;
	private readonly random?: () => number;
	private readonly jitterRatio: number;
	private readonly storagePath?: string;
	private readonly storeFactory: (filePath: string) => CronFileStore;
	private readonly isIdle: () => boolean;
	private readonly canDeliver?: (job: CronJob) => boolean;
	private readonly canDeliverMissed?: () => boolean;
	private readonly maxJobs: number;
	private readonly ownsJob: (job: CronJob) => boolean;
	private readonly sendMessage: (message: CronDelivery) => void;
	private readonly telemetry?: StepTelemetryReporter;
	private readonly warn: (message: string) => void;
	private readonly jobs = new Map<string, CronJob>();
	private readonly deferred = new Set<string>();
	private readonly pendingMissed = new Set<string>();
	private readonly failures = new Map<string, string>();
	private interval: TimerHandle | undefined;
	private currentStore: CronFileStore | undefined;
	private currentCwd: string | undefined;
	private loaded = false;
	private recoveryPending = false;
	private trusted = false;
	private durableRefreshAt = Number.NEGATIVE_INFINITY;

	constructor(options: StepCronRuntimeOptions = {}) {
		this.now = options.now ?? Date.now;
		this.startInterval = options.setInterval ?? ((callback, delayMs) => setInterval(callback, delayMs));
		this.stopInterval = options.clearInterval ?? ((timer) => clearInterval(timer));
		this.idFactory = options.idFactory ?? (() => randomUUID().slice(0, 8));
		this.random = options.random;
		this.jitterRatio = Math.max(0, Math.min(0.5, options.jitterRatio ?? 0.5));
		this.storagePath = options.storagePath;
		this.storeFactory = options.storeFactory ?? ((filePath) => new CronFileStore(filePath, { warn: options.warn }));
		this.isIdle = options.isIdle ?? (() => true);
		this.canDeliver = options.canDeliver;
		this.canDeliverMissed = options.canDeliverMissed;
		this.maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
		this.ownsJob = options.ownsJob ?? (() => true);
		this.sendMessage = options.sendMessage ?? (() => {});
		this.telemetry = options.telemetry;
		this.warn = options.warn ?? ((message) => console.warn(`[step-cron] ${message}`));
	}

	start(cwd: string, trusted: boolean): void {
		this.currentCwd = path.resolve(cwd);
		this.trusted = trusted;
		if (!this.loaded) {
			this.recoveryPending = trusted;
			try {
				this.loadDurable(trusted);
			} catch (error) {
				this.reportFailure(
					"storage",
					`Unable to load cron storage: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (this.interval === undefined) this.interval = this.startInterval(() => this.tick(), TICK_INTERVAL_MS);
	}

	setContext(cwd: string): void {
		this.currentCwd = path.resolve(cwd);
	}

	create(
		cron: string,
		prompt: string,
		recurring = true,
		durable = false,
		trusted = true,
		options: CronCreateOptions = {},
	): CronCreateResult {
		const normalizedCron = cron.trim();
		const expression = SimpleCronExpression.parse(normalizedCron);
		const normalizedPrompt = prompt.trim();
		if (!normalizedPrompt) throw new Error("cron_create requires a non-empty prompt");
		if (options.permissionPreset === "full-access" && options.fullAccessAcknowledged !== true)
			throw new Error("Full access cron jobs require an explicit risk acknowledgment");
		if (normalizedPrompt.length > MAX_PROMPT_LENGTH)
			throw new Error(`Cron prompt exceeds ${MAX_PROMPT_LENGTH} characters`);
		if (durable && !trusted) throw new Error("Durable cron jobs require a trusted project");
		if (durable && !this.currentStore) {
			const filePath = this.resolveStoragePath();
			if (!filePath) throw new Error("No project directory is available for durable cron storage");
			this.currentStore = this.storeFactory(filePath);
		}
		const createdAt = this.readNow();
		if (
			options.intervalHours !== undefined &&
			(!Number.isInteger(options.intervalHours) || options.intervalHours < 1 || options.intervalHours > 168)
		)
			throw new Error("Cron interval must be a whole number between 1 and 168 hours");
		if (options.intervalHours !== undefined && !recurring)
			throw new Error("Cron interval jobs repeat; set recurring to true or omit intervalHours");
		if (options.runAt !== undefined) {
			if (!Number.isFinite(options.runAt)) throw new Error("Cron runAt must be a finite timestamp");
			if (recurring) throw new Error("Only a one-shot cron job takes a runAt time");
			// A one-shot time in the past would fire on the next tick, which reads as
			// "ran immediately" rather than "scheduled".
			if (options.runAt <= createdAt) throw new Error("A one-shot cron job must be scheduled in the future");
		}
		const nominalNext =
			(!recurring ? options.runAt : undefined) ??
			(options.intervalHours ? createdAt + options.intervalHours * 60 * 60 * 1000 : expression.next(createdAt));
		const desktopFields =
			options.workspace !== undefined ||
			options.sessionId !== undefined ||
			options.title !== undefined ||
			options.status !== undefined ||
			options.inputs !== undefined ||
			options.model !== undefined ||
			options.permissionPreset !== undefined ||
			options.fullAccessAcknowledged !== undefined ||
			options.delivery !== undefined ||
			options.expiresAt !== undefined ||
			options.origin !== undefined ||
			options.jitter === false ||
			options.intervalHours !== undefined ||
			options.runAt !== undefined;
		const autoExpireAt =
			options.autoExpireMs === null
				? undefined
				: recurring
					? createdAt + (options.autoExpireMs ?? AUTO_EXPIRE_MS)
					: undefined;
		const job = this.withLatestJobs(() => {
			if (this.jobs.size >= this.maxJobs)
				throw new Error(`At most ${this.maxJobs} cron jobs can be scheduled; delete an existing job first`);
			const requestedId = options.id?.trim();
			if (requestedId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/u.test(requestedId))
				throw new Error("Cron job id may only contain letters, digits, underscore, and hyphen");
			const id = requestedId || this.uniqueId();
			if (this.jobs.has(id)) throw new Error(`Cron job id ${id} already exists`);
			const next: CronJob = {
				schemaVersion: desktopFields ? 2 : 1,
				id,
				cron: normalizedCron,
				prompt: normalizedPrompt,
				recurring,
				...(options.intervalHours ? { intervalHours: options.intervalHours } : {}),
				...(!recurring && options.runAt !== undefined ? { runAt: options.runAt } : {}),
				durable,
				createdAt,
				nextFireAt: this.jitter(nominalNext, createdAt, id, recurring, expression, options.jitter !== false),
				...(options.workspace ? { workspace: path.resolve(options.workspace) } : {}),
				...(options.sessionId ? { sessionId: options.sessionId } : {}),
				...(options.sessionCreated ? { sessionCreated: true } : {}),
				...(options.title ? { title: options.title.slice(0, CRON_MAX_TITLE_LENGTH) } : {}),
				...(options.status ? { status: options.status } : {}),
				...(options.inputs ? { inputs: { skills: [...(options.inputs.skills ?? [])] } } : {}),
				...(options.model ? { model: { ...options.model } } : {}),
				...(options.permissionPreset ? { permissionPreset: options.permissionPreset } : {}),
				...(options.fullAccessAcknowledged ? { fullAccessAcknowledged: true } : {}),
				...(options.delivery ? { delivery: structuredClone(options.delivery) } : {}),
				...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
				...(options.origin ? { origin: options.origin } : {}),
				...(options.jitter === false ? { jitter: false } : {}),
				...(autoExpireAt !== undefined ? { autoExpireAt } : {}),
			};
			this.jobs.set(id, next);
			return { ...next };
		});
		this.emit("cron_scheduled", { recurring });
		return { job, nextFireAt: job.nextFireAt };
	}

	update(id: string, patch: CronUpdatePatch): CronJob {
		const job = this.withLatestJobs(() => {
			const current = this.readableJob(id, "update");
			const next: CronJob = { ...current };
			if (patch.cron !== undefined) {
				next.cron = patch.cron.trim();
				SimpleCronExpression.parse(next.cron);
			}
			if (patch.prompt !== undefined) {
				const prompt = patch.prompt.trim();
				if (!prompt) throw new Error("cron_update requires a non-empty prompt");
				if (prompt.length > MAX_PROMPT_LENGTH)
					throw new Error(`Cron prompt exceeds ${MAX_PROMPT_LENGTH} characters`);
				next.prompt = prompt;
			}
			if (patch.title !== undefined) next.title = patch.title.slice(0, CRON_MAX_TITLE_LENGTH);
			if (patch.inputs !== undefined) next.inputs = { skills: [...(patch.inputs.skills ?? [])] };
			if (patch.model !== undefined) next.model = { ...patch.model };
			if (patch.permissionPreset !== undefined) {
				if (patch.permissionPreset === null) delete next.permissionPreset;
				else next.permissionPreset = patch.permissionPreset;
			}
			if (patch.fullAccessAcknowledged !== undefined) {
				if (patch.fullAccessAcknowledged === null) delete next.fullAccessAcknowledged;
				else next.fullAccessAcknowledged = patch.fullAccessAcknowledged || undefined;
			}
			if (patch.delivery !== undefined) next.delivery = structuredClone(patch.delivery);
			if ("expiresAt" in patch) {
				if (patch.expiresAt === null) delete next.expiresAt;
				else if (patch.expiresAt !== undefined) next.expiresAt = patch.expiresAt;
			}
			if (patch.status !== undefined) {
				if (!["enabled", "paused", "expired", "completed"].includes(patch.status))
					throw new Error(`Unknown cron job status: ${String(patch.status)}`);
				next.status = patch.status;
				next.enabled = patch.status === "enabled";
				// A status the user set themselves replaces whatever the host recorded.
				if (patch.status !== "paused") delete next.statusReason;
			}
			if (patch.statusReason !== undefined) {
				if (patch.statusReason === null) delete next.statusReason;
				else next.statusReason = patch.statusReason;
			}
			if (patch.recurring !== undefined) next.recurring = patch.recurring;
			if (patch.intervalHours !== undefined) {
				if (patch.intervalHours === null) delete next.intervalHours;
				else next.intervalHours = patch.intervalHours;
			}
			if (patch.runAt !== undefined) {
				if (patch.runAt === null) delete next.runAt;
				else next.runAt = patch.runAt;
			}
			if (next.recurring && patch.runAt !== undefined && patch.runAt !== null)
				throw new Error("A repeating cron job takes a schedule, not a one-shot runAt");
			// One schedule shape per task. `runAt` is a one-shot time and
			// `intervalHours` is a repeating interval, so converting between the two
			// kinds has to drop the field that no longer applies: a stale `runAt`
			// otherwise wins the `nextFireAt` calculation below, and a converted
			// `once -> daily` task fires at its old absolute time or immediately.
			if (next.recurring) delete next.runAt;
			else delete next.intervalHours;
			if (patch.runCount !== undefined) next.runCount = Math.max(0, Math.floor(patch.runCount));
			if (
				(patch.permissionPreset !== undefined || patch.fullAccessAcknowledged !== undefined) &&
				next.permissionPreset === "full-access" &&
				next.fullAccessAcknowledged !== true
			)
				throw new Error("Full access cron jobs require an explicit risk acknowledgment");
			if (next.schemaVersion === 1) next.schemaVersion = 2;
			const now = this.readNow();
			const expression = SimpleCronExpression.parse(next.cron);
			if (next.intervalHours !== undefined) {
				if (!Number.isInteger(next.intervalHours) || next.intervalHours < 1 || next.intervalHours > 168)
					throw new Error("Cron interval must be a whole number between 1 and 168 hours");
			}
			if (patch.runAt !== undefined && patch.runAt !== null) {
				if (!Number.isFinite(patch.runAt)) throw new Error("Cron runAt must be a finite timestamp");
				if (patch.runAt <= now) throw new Error("A one-shot cron job must be scheduled in the future");
			}
			if (patch.expiresAt !== undefined && patch.expiresAt !== null && !Number.isFinite(patch.expiresAt))
				throw new Error("Cron expiry must be a finite timestamp or null");

			// Reopening: a task that used up its schedule comes back to life only when
			// the edit gives it a future schedule again. An explicit status in the same
			// patch wins over this, so "pause" stays pause.
			const extendedExpiry =
				next.expiresAt !== undefined && patch.expiresAt !== undefined && patch.expiresAt !== null;
			const scheduledOneShot =
				!next.recurring && patch.runAt !== undefined && patch.runAt !== null && patch.runAt > now;
			if (patch.status === undefined && (next.status === "expired" || next.status === "completed")) {
				const reopened =
					(next.status === "expired" && extendedExpiry && next.expiresAt !== undefined && next.expiresAt > now) ||
					(next.status === "completed" && scheduledOneShot);
				if (reopened) {
					next.status = "enabled";
					next.enabled = true;
					delete next.statusReason;
				}
			}

			// A one-shot task fires at its `runAt`. Re-enabling one whose time has
			// already passed would deliver on the next tick, which reads as an
			// immediate run; the user has to pick a new time instead.
			if (!next.recurring && patch.status === "enabled" && patch.runAt === undefined) {
				if (next.runAt === undefined || next.runAt <= now)
					throw new Error("A one-shot task needs a future time before it can run again");
			}

			if (
				patch.cron !== undefined ||
				patch.recurring !== undefined ||
				patch.intervalHours !== undefined ||
				patch.runAt !== undefined ||
				patch.expiresAt !== undefined ||
				patch.status === "enabled"
			) {
				if (!next.recurring)
					next.nextFireAt =
						next.runAt ?? this.jitter(expression.next(now), now, id, false, expression, next.jitter !== false);
				else
					next.nextFireAt =
						next.intervalHours !== undefined
							? now + next.intervalHours * 60 * 60 * 1000
							: this.jitter(expression.next(now), now, id, true, expression, next.jitter !== false);
			}
			this.jobs.set(id, next);
			return { ...next };
		});
		return job;
	}

	setEnabled(id: string, enabled: boolean): boolean {
		try {
			this.update(id, { status: enabled ? "enabled" : "paused" });
			return true;
		} catch {
			return false;
		}
	}

	runNow(id: string): CronJob {
		const job = this.withLatestJobs(() => {
			const current = this.readableJob(id, "run");
			this.fire(current, this.readNow(), true);
			return { ...current };
		});
		return job;
	}

	list(): CronJob[] {
		this.refreshDurableNow();
		return [...this.jobs.values()]
			.filter((job) => this.ownsJob(job))
			.sort((left, right) => left.nextFireAt - right.nextFireAt || left.id.localeCompare(right.id))
			.map((job) => ({ ...job }));
	}

	delete(id: string): boolean {
		const found = this.withLatestJobs(() => {
			if (!this.jobs.has(id) || !this.ownsJob(this.jobs.get(id)!)) return false;
			this.removeJob(id);
			return true;
		});
		this.emit("cron_deleted", { found });
		return found;
	}

	tick(): void {
		try {
			if (this.recoveryPending) {
				this.loadDurable(true);
				return;
			}
			const now = this.readNow();
			this.refreshDurableOnTick(now);
			if (this.needsLockedDrain(now)) this.withLatestJobs(() => this.drain(now));
			else this.deferDue(now);
			this.failures.delete("storage");
		} catch (error) {
			// A busy lock or failed write must not kill the timer or consume a job.
			this.reportFailure(
				"storage",
				`Unable to update cron storage: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	onTurnEnd(): void {
		this.tick();
	}

	stop(): void {
		if (this.interval !== undefined) this.stopInterval(this.interval);
		this.interval = undefined;
		this.jobs.clear();
		this.deferred.clear();
		this.pendingMissed.clear();
		this.failures.clear();
		this.currentStore = undefined;
		this.currentCwd = undefined;
		this.loaded = false;
		this.recoveryPending = false;
		this.trusted = false;
		this.durableRefreshAt = Number.NEGATIVE_INFINITY;
	}

	private loadDurable(trusted: boolean): void {
		const filePath = trusted ? this.resolveStoragePath() : undefined;
		if (filePath && this.attachStore(filePath)) {
			this.refreshDurable();
			const now = this.readNow();
			if (
				[...this.jobs.values()].some((job) => {
					if (!job.durable) return false;
					const expires = this.expirationOf(job);
					return job.nextFireAt <= now || (expires !== undefined && expires <= now);
				})
			) {
				this.withLatestJobs(() => {
					// Import the complete file before any delivery can change persisted state.
					for (const job of [...this.jobs.values()]) {
						if (!job.durable) continue;
						if (job.status !== undefined && job.status !== "enabled") continue;
						const expires = this.expirationOf(job);
						if (expires !== undefined && expires <= now) {
							if (job.nextFireAt <= now) {
								if (this.deliveryAllowed(job)) this.fire(job, now);
								else this.defer(job);
							} else {
								if (job.status !== undefined) {
									job.status = "expired";
									job.nextFireAt = now;
								} else this.removeJob(job.id);
								this.emit("cron_expired", { id: job.id, recurring: job.recurring });
							}
							continue;
						}
						if (job.nextFireAt > now) continue;
						if (!job.recurring) {
							this.pendingMissed.add(job.id);
						} else {
							try {
								const expression = SimpleCronExpression.parse(job.cron);
								job.nextFireAt =
									job.intervalHours !== undefined
										? now + job.intervalHours * 60 * 60 * 1000
										: this.jitter(expression.next(now), now, job.id, true, expression, job.jitter !== false);
							} catch (error) {
								// Keep the record, but do not let one bad schedule block project recovery.
								this.reportFailure(
									`delivery:${job.id}`,
									`Unable to advance missed cron ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
								);
								continue;
							}
						}
						this.emit("cron_missed", { trigger_count: 1 });
					}
					this.deliverMissed();
				});
			}
		}
		this.durableRefreshAt = this.readNow();
		this.loaded = true;
		this.recoveryPending = false;
		this.failures.delete("storage");
	}

	private drain(now: number): void {
		this.deliverMissed();
		for (const job of [...this.jobs.values()]) {
			if (!this.ownsJob(job)) continue;
			if (job.status !== undefined && job.status !== "enabled") continue;
			if (this.isExpiredBeforeDelivery(job, now)) {
				if (job.status !== undefined) {
					job.status = "expired";
					job.nextFireAt = now;
				} else this.removeJob(job.id);
				this.emit("cron_expired", { id: job.id, recurring: job.recurring });
				continue;
			}
			if (!this.isDue(job, now)) continue;
			if (!this.deliveryAllowed(job)) {
				this.defer(job);
				continue;
			}
			this.fire(job, now);
		}
	}

	/** Due, and not already held back for the batched missed-job notice. */
	private isDue(job: CronJob, now: number): boolean {
		return job.nextFireAt <= now && !this.pendingMissed.has(job.id);
	}

	private expirationOf(job: CronJob): number | undefined {
		return job.expiresAt ?? job.autoExpireAt;
	}

	/** Reached its expiry before the next occurrence, so it leaves without a final delivery. */
	private isExpiredBeforeDelivery(job: CronJob, now: number): boolean {
		const expires = this.expirationOf(job);
		return expires !== undefined && now >= expires && job.nextFireAt > now;
	}

	private deliveryAllowed(job: CronJob): boolean {
		if (job.status !== undefined && job.status !== "enabled") return false;
		return this.canDeliver ? this.canDeliver(job) : this.isIdle();
	}

	private missedAllowed(): boolean {
		return this.canDeliverMissed ? this.canDeliverMissed() : this.isIdle();
	}

	/**
	 * Only take the storage lock when `drain` can actually deliver or remove
	 * something. A busy host otherwise re-read and re-locked the shared file on
	 * every one-second tick just to re-mark the same jobs deferred.
	 */
	private needsLockedDrain(now: number): boolean {
		if (this.missedAllowed() && this.pendingMissed.size > 0) return true;
		for (const job of this.jobs.values()) {
			if (!this.ownsJob(job)) continue;
			if (job.status !== undefined && job.status !== "enabled") continue;
			if (this.isExpiredBeforeDelivery(job, now)) return true;
			if (this.deliveryAllowed(job) && this.isDue(job, now)) return true;
		}
		return false;
	}

	/** `drain`'s busy-host branch, which is in-memory bookkeeping only. */
	private deferDue(now: number): void {
		for (const job of this.jobs.values()) {
			if (!this.ownsJob(job)) continue;
			if (job.status !== undefined && job.status !== "enabled") continue;
			if (this.isDue(job, now)) this.defer(job);
		}
	}

	private deliverMissed(): void {
		if (this.pendingMissed.size === 0 || !this.missedAllowed()) return;
		const jobs = [...this.pendingMissed].flatMap((id) => {
			const job = this.jobs.get(id);
			return job && this.ownsJob(job) ? [{ ...job }] : [];
		});
		if (jobs.length === 0) return;
		try {
			this.sendMessage({ kind: "missed", jobs });
		} catch (error) {
			this.reportFailure(
				"missed",
				`Unable to deliver missed cron notice: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		for (const job of jobs) {
			if (job.status !== undefined) {
				const current = this.jobs.get(job.id);
				if (current) {
					current.status = "completed";
					current.nextFireAt = this.readNow();
					current.lastStatus = "missed";
				}
			} else this.removeJob(job.id);
		}
		this.failures.delete("missed");
	}

	private fire(job: CronJob, now: number, manual = false): void {
		const expires = this.expirationOf(job);
		const expired = expires !== undefined && now >= expires;
		let nextFireAt: number | undefined;
		try {
			if (job.recurring && !expired && !manual) {
				const expression = SimpleCronExpression.parse(job.cron);
				nextFireAt =
					job.intervalHours !== undefined
						? now + job.intervalHours * 60 * 60 * 1000
						: this.jitter(expression.next(now), now, job.id, true, expression, job.jitter !== false);
			}
			this.sendMessage({ kind: "fire", job: { ...job }, ...(manual ? { manual: true } : {}) });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (job.schemaVersion === 2 || job.status !== undefined) {
				job.lastStatus = "failed";
				job.lastError = message;
			}
			this.reportFailure(`delivery:${job.id}`, `Unable to deliver cron ${job.id}: ${message}`);
			return;
		}
		this.failures.delete(`delivery:${job.id}`);
		this.deferred.delete(job.id);
		job.lastFiredAt = now;
		if (job.schemaVersion === 2 || job.status !== undefined) {
			job.runCount = (job.runCount ?? 0) + 1;
			job.lastStatus = "delivered";
			delete job.lastError;
		}
		if (manual) {
			this.emit("cron_fired", { recurring: job.recurring });
			return;
		}
		if (job.recurring && expired) {
			if (job.status !== undefined) {
				job.status = "expired";
				job.nextFireAt = now;
			} else this.removeJob(job.id);
			this.emit("cron_expired", { id: job.id, recurring: true });
		} else if (nextFireAt === undefined) {
			if (job.status !== undefined) {
				job.status = "completed";
				job.nextFireAt = now;
			} else this.removeJob(job.id);
		} else {
			job.nextFireAt = nextFireAt;
		}
		this.emit("cron_fired", { recurring: job.recurring });
	}

	private defer(job: CronJob): void {
		if (this.deferred.has(job.id)) return;
		this.deferred.add(job.id);
		this.emit("cron_deferred", { id: job.id, defer_count: 1 });
	}

	private removeJob(id: string): void {
		this.jobs.delete(id);
		this.deferred.delete(id);
		this.pendingMissed.delete(id);
		this.failures.delete(`delivery:${id}`);
	}

	/** A job this host may change, or an error saying whose it is. */
	private readableJob(id: string, action: "run" | "update"): CronJob {
		const job = this.jobs.get(id);
		if (!job) throw new Error(`No cron job with id ${id}`);
		if (!this.ownsJob(job)) throw new Error(`Cron job ${id} belongs to another host and cannot be ${action}`);
		return job;
	}

	/**
	 * Adopt an existing project store. Creating one belongs to `create`, so a
	 * session that never schedules durable work performs no storage I/O.
	 */
	private attachStore(filePath: string): boolean {
		if (this.currentStore) return true;
		try {
			statSync(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
		this.currentStore = this.storeFactory(filePath);
		return true;
	}

	/** Attach the shared store if it exists by now, then adopt its records. */
	private refreshDurableNow(): void {
		if (!this.currentStore) {
			const filePath = this.trusted ? this.resolveStoragePath() : undefined;
			if (!filePath || !this.attachStore(filePath)) return;
		}
		this.refreshDurable();
	}

	/**
	 * Another runtime's edits do not need the one-second firing cadence: this
	 * runtime's own jobs are already in memory, and `withLatestJobs` re-reads the
	 * file under the lock before any mutation.
	 */
	private refreshDurableOnTick(now: number): void {
		if (now - this.durableRefreshAt < DURABLE_REFRESH_INTERVAL_MS) return;
		this.durableRefreshAt = now;
		this.refreshDurableNow();
	}

	private refreshDurable(): void {
		if (this.currentStore) this.syncDurable(this.currentStore.load());
	}

	private syncDurable(stored: readonly CronJob[]): void {
		for (const [id, job] of this.jobs) if (job.durable) this.jobs.delete(id);
		for (const job of stored) this.jobs.set(job.id, job);
		for (const id of this.deferred) if (!this.jobs.has(id)) this.deferred.delete(id);
		for (const id of this.pendingMissed) if (!this.jobs.has(id)) this.pendingMissed.delete(id);
	}

	private withLatestJobs<T>(mutate: () => T): T {
		const previousJobs = new Map<string, CronJob>([...this.jobs].map(([id, job]) => [id, { ...job }]));
		const previousDeferred = new Set(this.deferred);
		const previousMissed = new Set(this.pendingMissed);
		try {
			if (!this.currentStore) return mutate();
			let result!: T;
			this.currentStore.update((stored) => {
				this.syncDurable(stored);
				result = mutate();
				return [...this.jobs.values()].filter((job) => job.durable);
			});
			return result;
		} catch (error) {
			this.jobs.clear();
			for (const [id, job] of previousJobs) this.jobs.set(id, job);
			this.deferred.clear();
			for (const id of previousDeferred) this.deferred.add(id);
			this.pendingMissed.clear();
			for (const id of previousMissed) this.pendingMissed.add(id);
			throw error;
		}
	}

	private resolveStoragePath(): string | undefined {
		if (this.storagePath) return path.resolve(this.storagePath);
		if (!this.currentCwd) return undefined;
		return path.join(this.currentCwd, ".stepcode", "cron", "tasks.json");
	}

	private uniqueId(): string {
		for (let attempt = 0; attempt < 10; attempt++) {
			const id = this.idFactory()
				.replace(/[^a-zA-Z0-9_-]/gu, "")
				.slice(0, 24);
			if (id && !this.jobs.has(id)) return id;
		}
		return randomUUID().replaceAll("-", "").slice(0, 16);
	}

	private jitter(
		timestamp: number,
		base: number,
		id: string,
		recurring: boolean,
		expression: SimpleCronExpression,
		enabled = true,
	): number {
		if (!enabled || this.jitterRatio === 0) return timestamp;
		const sample = this.random?.() ?? createHash("sha256").update(id).digest().readUInt32BE(0) / 0xffff_ffff;
		const fraction = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0;
		if (recurring) {
			const interval = expression.next(timestamp) - timestamp;
			return timestamp + Math.round(fraction * Math.min(30 * 60_000, interval * this.jitterRatio));
		}
		const minute = new Date(timestamp).getMinutes();
		return minute === 0 || minute === 30 ? Math.max(base + 1, timestamp - Math.round(fraction * 90_000)) : timestamp;
	}

	private reportFailure(key: string, message: string): void {
		if (this.failures.get(key) === message) return;
		this.failures.set(key, message);
		this.warn(message);
	}

	private readNow(): number {
		try {
			const value = this.now();
			return Number.isFinite(value) ? value : Date.now();
		} catch {
			return Date.now();
		}
	}

	private emit(
		event: "cron_scheduled" | "cron_deleted" | "cron_fired" | "cron_missed" | "cron_deferred" | "cron_expired",
		properties: StepTelemetryProperties,
	): void {
		if (!this.telemetry) return;
		try {
			void Promise.resolve(this.telemetry.track(event, properties)).catch(() => undefined);
		} catch {
			// Telemetry never changes scheduler behavior.
		}
	}
}

export const CronCreateParams = Type.Object({
	cron: Type.String({ description: "Five-field local-time cron expression" }),
	prompt: Type.String({ description: "Prompt injected when the job fires" }),
	recurring: Type.Optional(Type.Boolean({ description: "Repeat until the seven-day expiry (default true)" })),
	durable: Type.Optional(Type.Boolean({ description: "Persist under .stepcode/cron (default false)" })),
});

export const CronDeleteParams = Type.Object({ id: Type.String({ description: "Cron job id" }) });

export const CronUpdateParams = Type.Object({
	id: Type.String({ description: "Cron job id" }),
	cron: Type.Optional(Type.String({ description: "Replacement five-field local-time cron expression" })),
	prompt: Type.Optional(Type.String({ description: "Replacement prompt" })),
	title: Type.Optional(Type.String({ description: "Task title" })),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Skills loaded when the task runs" })),
	enabled: Type.Optional(Type.Boolean({ description: "Enable or pause the task" })),
	expiresAt: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "Expiry epoch ms, or null" })),
});

export interface StepCronExtensionOptions {
	telemetry?: StepTelemetryReporter;
	enabled?: boolean;
	readOnly?: boolean;
	/**
	 * Ask the user before an agent creates, updates or deletes a task.
	 *
	 * This is a host capability, not a product default: the desktop host has a
	 * page that can show the dialog and wants the gate, while a CLI session (and
	 * any print / RPC host with no dialog surface) would otherwise lose the
	 * ability to schedule work altogether.
	 */
	requireApproval?: boolean;
	/** Register `cron_update`; off for the CLI so its tool surface stays unchanged. */
	allowUpdate?: boolean;
	runtime?: CronRuntimeLike;
}

function envFlagEnabled(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "on";
}

function jsonResult<T>(payload: T): AgentToolResult<T> {
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: payload };
}

function formatCronStatus(jobs: readonly CronJob[]): string {
	if (jobs.length === 0) return "No cron jobs scheduled.";
	return jobs
		.map(
			(job) =>
				`${job.id} ${job.cron} next=${new Date(job.nextFireAt).toLocaleString()} ${job.recurring ? "recurring" : "one-shot"}${job.durable ? " durable" : " session"}\n  ${job.prompt}`,
		)
		.join("\n");
}

/**
 * Describe a pending `cron_update` by what the task is now, not by its id.
 *
 * The approval dialog is the only place a person sees what they are agreeing
 * to, and an id alone says nothing about which scheduled work changes.
 */
function describeUpdateTarget(runtime: CronRuntimeLike, params: Static<typeof CronUpdateParams>): string {
	const job = runtime.list().find((candidate) => candidate.id === params.id);
	const current = job ? `${job.title ?? job.prompt.slice(0, 60)} (${job.cron})` : `unknown task ${params.id}`;
	const changes = [
		params.cron === undefined ? undefined : `schedule -> ${params.cron}`,
		params.prompt === undefined ? undefined : "prompt",
		params.title === undefined ? undefined : `title -> ${params.title}`,
		params.skills === undefined ? undefined : "skills",
		params.enabled === undefined ? undefined : params.enabled ? "resume" : "pause",
		params.expiresAt === undefined ? undefined : "expiry",
	].filter((value): value is string => value !== undefined);
	return `${current}\n${changes.length > 0 ? `changes: ${changes.join(", ")}` : "no changes"}`;
}

/**
 * Read from a captured extension context, tolerating a stale one.
 *
 * A ctx goes stale the moment its session is replaced — fork, newSession,
 * switchSession or reload — and touching a stale ctx throws. Timer callbacks can
 * land in that window, and an uncaught throw there takes down the whole host
 * rather than just skipping one notification, so treat it as "nothing to read".
 *
 * The plan-mode gate is read through the same helper: it asks the session
 * whether a human decision is pending, and a stale ctx cannot answer.
 */
function withLiveContext<T>(context: ExtensionContext | undefined, read: (ctx: ExtensionContext) => T): T | undefined {
	if (!context) return undefined;
	try {
		return read(context);
	} catch {
		return undefined;
	}
}

async function requireCronApproval(
	ctx: ExtensionContext,
	action: "create" | "update" | "delete",
	detail: string,
): Promise<void> {
	// `once` marks the dialog as a decision about one scheduled task, so a
	// standing "allow for this session" cannot silently cover every later
	// scheduled-task change in the conversation.
	const approved = await ctx.ui.confirm(
		`Approve scheduled task ${action}?`,
		`${detail}\n\nAgent-created scheduled-task changes require your approval.`,
		{ once: true },
	);
	if (!approved) throw new Error(`Cron ${action} was not approved`);
}

/** Register expression-based Cron tools; this extension has no Loop dependency. */
export function createStepCronExtension(options: StepCronExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		if (options.enabled === false || envFlagEnabled(process.env.STEP_DISABLE_CRON)) return;
		/**
		 * The approval gate is a host capability. A host that asks has a dialog
		 * surface; a host that does not must not lose the ability to schedule, and a
		 * host whose context cannot show a dialog at all is refused rather than
		 * silently allowed.
		 */
		const approve = (ctx: ExtensionContext, action: "create" | "update" | "delete", detail: string) => {
			if (!options.requireApproval) return;
			if (!ctx.hasUI) throw new Error(`Cron ${action} requires user approval, but this host has no dialog surface`);
			return requireCronApproval(ctx, action, detail);
		};
		let currentContext: ExtensionContext | undefined;
		const runtime =
			options.runtime ??
			new StepCronRuntime({
				telemetry: options.telemetry,
				// A durable record bound to a session belongs to the host that owns
				// that session. A CLI session loading the same project folder must not
				// fire, list, or delete it: it has no way to see that session, and
				// firing it would deliver a desktop task's prompt into this terminal
				// conversation instead.
				ownsJob: (job) => job.sessionId === undefined,
				isIdle: () =>
					Boolean(
						withLiveContext(
							currentContext,
							(ctx) =>
								ctx.isIdle() &&
								!ctx.hasPendingMessages() &&
								// A job whose delivery would start a turn stays due instead of
								// being fired into a queue, so an approval does not replay work
								// the user may reject.
								ctx.hasPendingUserDecision?.() !== true,
						),
					),
				warn: (message) => {
					withLiveContext(currentContext, (ctx) => ctx.ui.notify(message, "warning"));
				},
				sendMessage: (delivery) => {
					if (delivery.kind === "missed") {
						const jobs = delivery.jobs ?? [];
						const count = jobs.length;
						pi.sendMessage(
							{
								customType: "step-cron",
								content: [
									`[cron] Missed ${count} one-shot job${count === 1 ? "" : "s"} while the session was offline.`,
									...jobs.map(
										(job) => `- ${job.id} (${new Date(job.nextFireAt).toLocaleString()}): ${job.prompt}`,
									),
								].join("\n"),
								display: true,
								details: { kind: "missed", count, jobs },
							},
							{ deliverAs: "steer", triggerTurn: true },
						);
						return;
					}
					const job = delivery.job;
					if (!job) return;
					pi.sendMessage(
						{
							customType: "step-cron",
							content: `[cron] ${job.prompt}`,
							display: true,
							details: { id: job.id, cron: job.cron, recurring: job.recurring, durable: job.durable },
						},
						{ deliverAs: "steer", triggerTurn: true },
					);
				},
			});

		const setContext = (_event: unknown, ctx: ExtensionContext): void => {
			currentContext = ctx;
			runtime.setContext(ctx.cwd);
		};
		pi.on("session_start", (_event, ctx) => {
			setContext(_event, ctx);
			runtime.start(ctx.cwd, ctx.isProjectTrusted());
		});
		pi.on("turn_end", (_event, ctx) => {
			setContext(_event, ctx);
			runtime.onTurnEnd();
		});
		pi.on("agent_settled", (_event, ctx) => {
			setContext(_event, ctx);
			runtime.onTurnEnd();
		});
		pi.on("session_shutdown", () => {
			runtime.stop();
			currentContext = undefined;
		});

		pi.registerTool({
			name: "cron_create",
			label: "Create cron job",
			description: `Schedule a five-field local-time cron job (up to 50 jobs). Jobs fire only while StepCode is running and idle, after pending user input. Durable jobs (durable:true) persist under .stepcode/cron and survive session restarts; session jobs die with the process. Recurring jobs (recurring:true, default) expire after seven days as a runaway guard. Invalid expressions are rejected before the tool records anything.

When NOT to use: cron_create is for calendar or expression-based triggers that repeat or must survive a restart. For fanning work out to many subagents on schedule, cron_create only injects a follow-up prompt on trigger; the subsequent turn is where you would call workflow (with its own opt-in). For a multi-turn objective that should persist without a fixed calendar, use create_goal instead.

Scheduling: recurring jobs get a stable task-ID offset of up to 30 minutes late, capped at half the interval. One-shot jobs at :00 or :30 may fire up to 90 seconds early; other one-shot minutes are exact. Delivery failures remain due and retry. Missed one-shot durable jobs are surfaced as a single batched message when the session returns; missed recurring jobs advance to the next matching minute and emit cron_missed telemetry.`,
			promptSnippet: "Schedule recurring or one-shot calendar work",
			parameters: CronCreateParams,
			execute: async (_id, params, _signal, _onUpdate, ctx) => {
				if (options.readOnly) throw new Error("This task session cannot create cron jobs");
				await approve(ctx, "create", `${params.cron} - ${params.prompt.slice(0, 120)}`);
				currentContext = ctx;
				runtime.setContext(ctx.cwd);
				const recurring = params.recurring !== false;
				const durable = params.durable === true;
				const result = runtime.create(params.cron, params.prompt, recurring, durable, ctx.isProjectTrusted());
				return jsonResult({ ...result.job, nextFireAt: result.nextFireAt });
			},
		});
		pi.registerTool({
			name: "cron_list",
			label: "List cron jobs",
			description: "List scheduled cron jobs and their next fire times.",
			promptSnippet: "List scheduled cron jobs",
			parameters: Type.Object({}),
			execute: async (_id, _params, _signal, _onUpdate, ctx) => {
				currentContext = ctx;
				runtime.setContext(ctx.cwd);
				return jsonResult(runtime.list());
			},
		});
		pi.registerTool({
			name: "cron_delete",
			label: "Delete cron job",
			description: "Delete a scheduled cron job by id.",
			promptSnippet: "Delete a scheduled cron job",
			parameters: CronDeleteParams,
			execute: async (_id, params, _signal, _onUpdate, ctx) => {
				if (options.readOnly) throw new Error("This task session cannot delete cron jobs");
				await approve(ctx, "delete", params.id);
				currentContext = ctx;
				runtime.setContext(ctx.cwd);
				const found = runtime.delete(params.id);
				return jsonResult({ id: params.id, found });
			},
		});
		if (options.allowUpdate) {
			pi.registerTool({
				name: "cron_update",
				label: "Update cron job",
				description: "Update a scheduled cron job: title, expression, prompt, skills, enabled/paused, or expiry.",
				promptSnippet: "Update a scheduled cron job",
				parameters: CronUpdateParams,
				execute: async (_id, params, _signal, _onUpdate, ctx) => {
					if (options.readOnly) throw new Error("This task session cannot update cron jobs");
					await approve(ctx, "update", describeUpdateTarget(runtime, params));
					if (!runtime.update) throw new Error("This host does not support updating cron jobs");
					currentContext = ctx;
					runtime.setContext(ctx.cwd);
					const patch: CronUpdatePatch = {};
					if (params.cron !== undefined) patch.cron = params.cron;
					if (params.prompt !== undefined) patch.prompt = params.prompt;
					if (params.title !== undefined) patch.title = params.title;
					if (params.skills !== undefined) patch.inputs = { skills: params.skills };
					if (params.enabled !== undefined) patch.status = params.enabled ? "enabled" : "paused";
					if (params.expiresAt !== undefined) patch.expiresAt = params.expiresAt;
					const job = runtime.update(params.id, patch);
					return jsonResult(job);
				},
			});
		}
		pi.registerCommand("cron", {
			description: "Inspect or delete cron jobs",
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				currentContext = ctx;
				runtime.setContext(ctx.cwd);
				const tokens = args.trim().split(/\s+/u).filter(Boolean);
				try {
					if (tokens[0] === "delete" || tokens[0] === "remove") {
						if (options.readOnly) {
							ctx.ui.notify("This task session cannot delete cron jobs", "warning");
							return;
						}
						const id = tokens[1];
						if (!id || tokens.length !== 2) {
							ctx.ui.notify("Usage: /cron delete <id>", "warning");
							return;
						}
						ctx.ui.notify(runtime.delete(id) ? `Deleted cron job ${id}.` : `No cron job with id ${id}.`, "info");
						return;
					}
					if (tokens.length > 1 || (tokens[0] && tokens[0] !== "list" && tokens[0] !== "status")) {
						ctx.ui.notify("Usage: /cron [list|status|delete <id>]", "warning");
						return;
					}
					ctx.ui.notify(formatCronStatus(runtime.list()), "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				}
			},
		});
	};
}

export const stepCronExtensionInline = {
	name: "Step cron",
	factory: createStepCronExtension(),
	hidden: true,
} as const;
