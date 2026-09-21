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
import { Type } from "typebox";
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
const MAX_JOBS = 50;
const AUTO_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SEARCH_MINUTES = 366 * 24 * 60;
const MAX_PROMPT_LENGTH = 16_000;
const MAX_CRON_LENGTH = 200;
const MAX_LOCK_AGE_MS = 60_000;

type TimerHandle = ReturnType<typeof setInterval>;

export interface CronJob {
	schemaVersion: 1;
	id: string;
	cron: string;
	prompt: string;
	recurring: boolean;
	durable: boolean;
	createdAt: number;
	nextFireAt: number;
	lastFiredAt?: number;
	autoExpireAt?: number;
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
	if (candidate.schemaVersion !== 1 || candidate.durable !== true) return undefined;
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
		![
			candidate.createdAt,
			candidate.nextFireAt,
			candidate.lastFiredAt === undefined ? 0 : candidate.lastFiredAt,
			candidate.autoExpireAt === undefined ? 0 : candidate.autoExpireAt,
		].every((value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15)
	)
		return undefined;
	try {
		SimpleCronExpression.parse(candidate.cron);
	} catch {
		return undefined;
	}
	return {
		...candidate,
		schemaVersion: 1,
		id: candidate.id,
		cron: candidate.cron,
		prompt: candidate.prompt,
		recurring: candidate.recurring,
		durable: true,
		createdAt: candidate.createdAt,
		nextFireAt: candidate.nextFireAt,
		...(typeof candidate.lastFiredAt === "number" ? { lastFiredAt: candidate.lastFiredAt } : {}),
		...(typeof candidate.autoExpireAt === "number" ? { autoExpireAt: candidate.autoExpireAt } : {}),
	};
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
	sendMessage?: (message: CronDelivery) => void;
	telemetry?: StepTelemetryReporter;
	warn?: (message: string) => void;
}

export interface CronDelivery {
	kind: "fire" | "missed";
	job?: CronJob;
	jobs?: CronJob[];
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

	create(cron: string, prompt: string, recurring = true, durable = false, trusted = true): CronCreateResult {
		const normalizedCron = cron.trim();
		const expression = SimpleCronExpression.parse(normalizedCron);
		const normalizedPrompt = prompt.trim();
		if (!normalizedPrompt) throw new Error("cron_create requires a non-empty prompt");
		if (normalizedPrompt.length > MAX_PROMPT_LENGTH)
			throw new Error(`Cron prompt exceeds ${MAX_PROMPT_LENGTH} characters`);
		if (durable && !trusted) throw new Error("Durable cron jobs require a trusted project");
		if (durable && !this.currentStore) {
			const filePath = this.resolveStoragePath();
			if (!filePath) throw new Error("No project directory is available for durable cron storage");
			this.currentStore = this.storeFactory(filePath);
		}
		const createdAt = this.readNow();
		const nominalNext = expression.next(createdAt);
		const job = this.withLatestJobs(() => {
			if (this.jobs.size >= MAX_JOBS)
				throw new Error(`At most ${MAX_JOBS} cron jobs can be scheduled; delete an existing job first`);
			const id = this.uniqueId();
			const next: CronJob = {
				schemaVersion: 1,
				id,
				cron: normalizedCron,
				prompt: normalizedPrompt,
				recurring,
				durable,
				createdAt,
				nextFireAt: this.jitter(nominalNext, createdAt, id, recurring, expression),
				...(recurring ? { autoExpireAt: createdAt + AUTO_EXPIRE_MS } : {}),
			};
			this.jobs.set(id, next);
			return { ...next };
		});
		this.emit("cron_scheduled", { recurring });
		return { job, nextFireAt: job.nextFireAt };
	}

	list(): CronJob[] {
		this.refreshDurableNow();
		return [...this.jobs.values()]
			.sort((left, right) => left.nextFireAt - right.nextFireAt || left.id.localeCompare(right.id))
			.map((job) => ({ ...job }));
	}

	delete(id: string): boolean {
		const found = this.withLatestJobs(() => {
			if (!this.jobs.has(id)) return false;
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
				[...this.jobs.values()].some(
					(job) =>
						job.durable && (job.nextFireAt <= now || (job.autoExpireAt !== undefined && job.autoExpireAt <= now)),
				)
			) {
				this.withLatestJobs(() => {
					// Import the complete file before any delivery can change persisted state.
					for (const job of [...this.jobs.values()]) {
						if (!job.durable) continue;
						if (job.autoExpireAt !== undefined && job.autoExpireAt <= now) {
							if (job.nextFireAt <= now) {
								if (this.isIdle()) this.fire(job, now);
								else this.defer(job);
							} else {
								this.removeJob(job.id);
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
								job.nextFireAt = this.jitter(expression.next(now), now, job.id, true, expression);
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
			if (this.isExpiredBeforeDelivery(job, now)) {
				this.removeJob(job.id);
				this.emit("cron_expired", { id: job.id, recurring: job.recurring });
				continue;
			}
			if (!this.isDue(job, now)) continue;
			if (!this.isIdle()) {
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

	/** Reached its expiry before the next occurrence, so it leaves without a final delivery. */
	private isExpiredBeforeDelivery(job: CronJob, now: number): boolean {
		return job.autoExpireAt !== undefined && now >= job.autoExpireAt && job.nextFireAt > now;
	}

	/**
	 * Only take the storage lock when `drain` can actually deliver or remove
	 * something. A busy host otherwise re-read and re-locked the shared file on
	 * every one-second tick just to re-mark the same jobs deferred.
	 */
	private needsLockedDrain(now: number): boolean {
		const idle = this.isIdle();
		if (idle && this.pendingMissed.size > 0) return true;
		for (const job of this.jobs.values()) {
			if (this.isExpiredBeforeDelivery(job, now)) return true;
			if (idle && this.isDue(job, now)) return true;
		}
		return false;
	}

	/** `drain`'s busy-host branch, which is in-memory bookkeeping only. */
	private deferDue(now: number): void {
		for (const job of this.jobs.values()) if (this.isDue(job, now)) this.defer(job);
	}

	private deliverMissed(): void {
		if (this.pendingMissed.size === 0 || !this.isIdle()) return;
		const jobs = [...this.pendingMissed].flatMap((id) => {
			const job = this.jobs.get(id);
			return job ? [{ ...job }] : [];
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
		for (const job of jobs) this.removeJob(job.id);
		this.failures.delete("missed");
	}

	private fire(job: CronJob, now: number): void {
		const expired = job.autoExpireAt !== undefined && now >= job.autoExpireAt;
		let nextFireAt: number | undefined;
		try {
			if (job.recurring && !expired) {
				const expression = SimpleCronExpression.parse(job.cron);
				nextFireAt = this.jitter(expression.next(now), now, job.id, true, expression);
			}
			this.sendMessage({ kind: "fire", job: { ...job } });
		} catch (error) {
			this.reportFailure(
				`delivery:${job.id}`,
				`Unable to deliver cron ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		this.failures.delete(`delivery:${job.id}`);
		this.deferred.delete(job.id);
		if (nextFireAt === undefined) this.removeJob(job.id);
		else {
			job.lastFiredAt = now;
			job.nextFireAt = nextFireAt;
		}
		this.emit("cron_fired", { recurring: job.recurring });
		if (job.recurring && expired) this.emit("cron_expired", { id: job.id, recurring: true });
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
	): number {
		if (this.jitterRatio === 0) return timestamp;
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

export interface StepCronExtensionOptions {
	telemetry?: StepTelemetryReporter;
	enabled?: boolean;
	runtime?: StepCronRuntime;
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

/** Register expression-based Cron tools; this extension has no Loop dependency. */
export function createStepCronExtension(options: StepCronExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		if (options.enabled === false || envFlagEnabled(process.env.STEP_DISABLE_CRON)) return;
		let currentContext: ExtensionContext | undefined;
		const runtime =
			options.runtime ??
			new StepCronRuntime({
				telemetry: options.telemetry,
				isIdle: () => Boolean(currentContext?.isIdle() && !currentContext.hasPendingMessages()),
				warn: (message) => currentContext?.ui.notify(message, "warning"),
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
				currentContext = ctx;
				runtime.setContext(ctx.cwd);
				const found = runtime.delete(params.id);
				return jsonResult({ id: params.id, found });
			},
		});

		pi.registerCommand("cron", {
			description: "Inspect or delete cron jobs",
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				currentContext = ctx;
				runtime.setContext(ctx.cwd);
				const tokens = args.trim().split(/\s+/u).filter(Boolean);
				try {
					if (tokens[0] === "delete" || tokens[0] === "remove") {
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
