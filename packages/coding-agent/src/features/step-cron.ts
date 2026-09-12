/** Durable and session-only five-field cron scheduling for Step. */

import { randomUUID } from "node:crypto";
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

const TICK_INTERVAL_MS = 30_000;
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
		const cursor = new Date(afterMs);
		cursor.setSeconds(0, 0);
		for (let offset = 1; offset <= MAX_SEARCH_MINUTES; offset++) {
			const candidate = new Date(cursor.getTime());
			candidate.setMinutes(candidate.getMinutes() + offset);
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
		if (rawPart.includes("/") && rawStep === undefined) throw new Error(`Cron ${name} step is missing`);
		const step = rawStep === undefined ? 1 : Number.parseInt(rawStep, 10);
		if (!Number.isInteger(step) || step < 1) throw new Error(`Cron ${name} step must be a positive integer`);
		let start: number;
		let end: number;
		if (rawBase === "*") {
			start = min;
			end = max;
		} else if (rawBase?.includes("-")) {
			const [rawStart, rawEnd] = rawBase.split("-", 2);
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

	constructor(filePath: string, options: CronFileStoreOptions = {}) {
		this.filePath = path.resolve(filePath);
		this.lockMaxAgeMs = options.lockMaxAgeMs ?? MAX_LOCK_AGE_MS;
		this.warn = options.warn ?? ((message) => console.warn(`[step-cron] ${message}`));
	}

	load(): CronJob[] {
		let content: string;
		try {
			content = readFileSync(this.filePath, "utf8");
		} catch {
			return [];
		}
		const jobs: CronJob[] = [];
		for (const [index, line] of content.split(/\r?\n/u).entries()) {
			if (!line.trim()) continue;
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				this.warn(`Skipping malformed cron record at line ${index + 1}`);
				continue;
			}
			const job = parsePersistedJob(value);
			if (!job) {
				this.warn(`Skipping invalid cron record at line ${index + 1}`);
				continue;
			}
			jobs.push(job);
		}
		return jobs;
	}

	save(jobs: readonly CronJob[]): void {
		const directory = path.dirname(this.filePath);
		mkdirSync(directory, { recursive: true });
		const lockPath = `${this.filePath}.lock`;
		const lockFd = this.acquireLock(lockPath);
		const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			const data = jobs.map((job) => JSON.stringify(job)).join("\n");
			writeFileSync(temporaryPath, data ? `${data}\n` : "", { encoding: "utf8", mode: 0o600 });
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
		} catch {
			// A missing file has nothing to back up.
		}
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
		typeof candidate.cron !== "string" ||
		typeof candidate.prompt !== "string" ||
		typeof candidate.recurring !== "boolean" ||
		typeof candidate.createdAt !== "number" ||
		typeof candidate.nextFireAt !== "number"
	) {
		return undefined;
	}
	try {
		SimpleCronExpression.parse(candidate.cron);
	} catch {
		return undefined;
	}
	return {
		schemaVersion: 1,
		id: candidate.id,
		cron: candidate.cron,
		prompt: candidate.prompt.slice(0, MAX_PROMPT_LENGTH),
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
	random?: () => number;
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
	private readonly random: () => number;
	private readonly jitterRatio: number;
	private readonly storagePath?: string;
	private readonly storeFactory: (filePath: string) => CronFileStore;
	private readonly isIdle: () => boolean;
	private readonly sendMessage: (message: CronDelivery) => void;
	private readonly telemetry?: StepTelemetryReporter;
	private readonly warn?: (message: string) => void;
	private readonly jobs = new Map<string, CronJob>();
	private readonly deferred = new Set<string>();
	private pendingMissed: CronJob[] = [];
	private interval: TimerHandle | undefined;
	private currentStore: CronFileStore | undefined;
	private currentCwd: string | undefined;
	private loaded = false;

	constructor(options: StepCronRuntimeOptions = {}) {
		this.now = options.now ?? Date.now;
		this.startInterval = options.setInterval ?? ((callback, delayMs) => setInterval(callback, delayMs));
		this.stopInterval = options.clearInterval ?? ((timer) => clearInterval(timer));
		this.idFactory = options.idFactory ?? (() => randomUUID().slice(0, 8));
		this.random = options.random ?? Math.random;
		this.jitterRatio = Math.max(0, Math.min(0.1, options.jitterRatio ?? 0.1));
		this.storagePath = options.storagePath;
		this.storeFactory = options.storeFactory ?? ((filePath) => new CronFileStore(filePath, { warn: options.warn }));
		this.isIdle = options.isIdle ?? (() => true);
		this.sendMessage = options.sendMessage ?? (() => {});
		this.telemetry = options.telemetry;
		this.warn = options.warn;
	}

	start(cwd: string, trusted: boolean): void {
		this.currentCwd = path.resolve(cwd);
		if (!this.loaded) this.loadDurable(trusted);
		if (!this.interval) this.interval = this.startInterval(() => this.tick(), TICK_INTERVAL_MS);
	}

	setContext(cwd: string): void {
		this.currentCwd = path.resolve(cwd);
	}

	create(cron: string, prompt: string, recurring = true, durable = false, trusted = true): CronCreateResult {
		const trimmedCron = cron.trim();
		if (trimmedCron.length > MAX_CRON_LENGTH)
			throw new Error(`Cron expression exceeds ${MAX_CRON_LENGTH} characters`);
		const normalizedCron = trimmedCron;
		const expression = SimpleCronExpression.parse(normalizedCron);
		const normalizedPrompt = prompt.trim().slice(0, MAX_PROMPT_LENGTH);
		if (!normalizedPrompt) throw new Error("cron_create requires a non-empty prompt");
		if (durable && !trusted) throw new Error("Durable cron jobs require a trusted project");
		if (durable && !this.currentCwd && !this.storagePath)
			throw new Error("No project directory is available for durable cron storage");
		if (durable && !this.currentStore) {
			const filePath = this.resolveStoragePath();
			if (!filePath) throw new Error("No project directory is available for durable cron storage");
			this.currentStore = this.storeFactory(filePath);
		}
		const createdAt = this.readNow();
		const id = this.uniqueId();
		const nominalNext = expression.next(createdAt);
		const job: CronJob = {
			schemaVersion: 1,
			id,
			cron: normalizedCron,
			prompt: normalizedPrompt,
			recurring,
			durable,
			createdAt,
			nextFireAt: this.jitter(nominalNext, createdAt),
			...(recurring ? { autoExpireAt: createdAt + AUTO_EXPIRE_MS } : {}),
		};
		this.jobs.set(id, job);
		this.persist();
		this.emit("cron_scheduled", { recurring });
		return { job: { ...job }, nextFireAt: job.nextFireAt };
	}

	list(): CronJob[] {
		return [...this.jobs.values()]
			.sort((left, right) => left.nextFireAt - right.nextFireAt || left.id.localeCompare(right.id))
			.map((job) => ({ ...job }));
	}

	delete(id: string): boolean {
		const job = this.jobs.get(id);
		if (!job) {
			this.emit("cron_deleted", { found: false });
			return false;
		}
		this.jobs.delete(id);
		this.deferred.delete(id);
		this.persist();
		this.emit("cron_deleted", { found: true });
		return true;
	}

	tick(): void {
		const now = this.readNow();
		for (const job of [...this.jobs.values()]) {
			if (job.autoExpireAt !== undefined && now >= job.autoExpireAt && job.nextFireAt > now) {
				this.jobs.delete(job.id);
				this.deferred.delete(job.id);
				this.persist();
				this.emit("cron_expired", { id: job.id, recurring: job.recurring });
				continue;
			}
			if (job.nextFireAt > now) continue;
			if (!this.isIdle()) {
				if (!this.deferred.has(job.id)) {
					this.deferred.add(job.id);
					this.emit("cron_deferred", { id: job.id, defer_count: 1 });
				}
				continue;
			}
			this.fire(job, now);
		}
	}

	onTurnEnd(): void {
		if (!this.isIdle()) return;
		this.tick();
		if (this.pendingMissed.length > 0) {
			const jobs = this.pendingMissed;
			this.pendingMissed = [];
			try {
				this.sendMessage({ kind: "missed", jobs: jobs.map((job) => ({ ...job })) });
			} catch (error) {
				this.warn?.(
					`Unable to deliver missed cron notice: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	stop(): void {
		if (this.interval) this.stopInterval(this.interval);
		this.interval = undefined;
		this.jobs.clear();
		this.deferred.clear();
		this.pendingMissed = [];
		this.currentStore = undefined;
		this.currentCwd = undefined;
		this.loaded = false;
	}

	private loadDurable(trusted: boolean): void {
		this.loaded = true;
		if (!trusted) return;
		const filePath = this.resolveStoragePath();
		if (!filePath) return;
		this.currentStore = this.storeFactory(filePath);
		const now = this.readNow();
		let changed = false;
		for (const loadedJob of this.currentStore.load()) {
			if (loadedJob.autoExpireAt !== undefined && loadedJob.autoExpireAt <= now && loadedJob.nextFireAt <= now) {
				this.jobs.set(loadedJob.id, loadedJob);
				if (this.isIdle()) this.fire(loadedJob, now);
				else {
					this.deferred.add(loadedJob.id);
					this.emit("cron_deferred", { id: loadedJob.id, defer_count: 1 });
				}
				changed = true;
				continue;
			}
			if (loadedJob.autoExpireAt !== undefined && loadedJob.autoExpireAt <= now) {
				this.emit("cron_expired", { id: loadedJob.id, recurring: loadedJob.recurring });
				changed = true;
				continue;
			}
			if (!loadedJob.recurring && loadedJob.nextFireAt <= now) {
				this.pendingMissed.push(loadedJob);
				this.emit("cron_missed", { trigger_count: 1 });
				changed = true;
				continue;
			}
			if (loadedJob.recurring && loadedJob.nextFireAt <= now) {
				try {
					loadedJob.lastFiredAt = now;
					loadedJob.nextFireAt = this.jitter(SimpleCronExpression.parse(loadedJob.cron).next(now), now);
					this.emit("cron_missed", { trigger_count: 1 });
					changed = true;
				} catch (error) {
					this.warn?.(
						`Unable to advance missed cron ${loadedJob.id}: ${error instanceof Error ? error.message : String(error)}`,
					);
					continue;
				}
			}
			this.jobs.set(loadedJob.id, loadedJob);
		}
		if (changed) this.persist();
		if (this.pendingMissed.length > 0 && this.isIdle()) {
			const jobs = this.pendingMissed;
			this.pendingMissed = [];
			try {
				this.sendMessage({ kind: "missed", jobs: jobs.map((job) => ({ ...job })) });
			} catch (error) {
				this.warn?.(
					`Unable to deliver missed cron notice: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	private fire(job: CronJob, now: number): void {
		this.deferred.delete(job.id);
		try {
			this.sendMessage({ kind: "fire", job: { ...job } });
		} catch (error) {
			this.warn?.(`Unable to deliver cron ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!job.recurring) {
			this.jobs.delete(job.id);
			this.persist();
			this.emit("cron_fired", { recurring: false });
			return;
		}
		if (job.autoExpireAt !== undefined && now >= job.autoExpireAt) {
			this.jobs.delete(job.id);
			this.persist();
			this.emit("cron_fired", { recurring: true });
			this.emit("cron_expired", { id: job.id, recurring: true });
			return;
		}
		try {
			job.lastFiredAt = now;
			job.nextFireAt = this.jitter(SimpleCronExpression.parse(job.cron).next(now), now);
			this.persist();
			this.emit("cron_fired", { recurring: true });
		} catch (error) {
			this.jobs.delete(job.id);
			this.persist();
			this.warn?.(
				`Removing invalid recurring cron ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private persist(): void {
		if (!this.currentStore) return;
		this.currentStore.save([...this.jobs.values()].filter((job) => job.durable));
	}

	private resolveStoragePath(): string | undefined {
		if (this.storagePath) return path.resolve(this.storagePath);
		if (!this.currentCwd) return undefined;
		return path.join(this.currentCwd, ".step-cli", "cron", "tasks.json");
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

	private jitter(timestamp: number, base: number): number {
		if (this.jitterRatio === 0) return timestamp;
		const span = Math.max(1_000, timestamp - base) * this.jitterRatio;
		const offset = (this.random() * 2 - 1) * span;
		return Math.max(base + 1, Math.round(timestamp + offset));
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
	durable: Type.Optional(Type.Boolean({ description: "Persist under .step-cli/cron (default false)" })),
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
				`${job.id} ${job.cron} next=${new Date(job.nextFireAt).toISOString()} ${job.recurring ? "recurring" : "one-shot"}${job.durable ? " durable" : " session"}`,
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
				isIdle: () => currentContext?.isIdle() ?? true,
				sendMessage: (delivery) => {
					if (delivery.kind === "missed") {
						const count = delivery.jobs?.length ?? 0;
						pi.sendMessage(
							{
								customType: "step-cron",
								content: `[cron] Missed ${count} one-shot job${count === 1 ? "" : "s"} while the session was offline.`,
								display: true,
								details: { kind: "missed", count },
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
		pi.on("session_shutdown", () => {
			runtime.stop();
			currentContext = undefined;
		});

		pi.registerTool({
			name: "cron_create",
			label: "Create cron job",
			description: `Schedule a five-field local-time cron job. Durable jobs (durable:true) persist under .step-cli/cron and survive session restarts; session jobs die with the process. Recurring jobs (recurring:true, default) expire after seven days as a runaway guard. Invalid expressions are rejected before the tool records anything.

When NOT to use: cron_create is for calendar or expression-based triggers that repeat or must survive a restart. For fanning work out to many subagents on schedule, cron_create only injects a follow-up prompt on trigger; the subsequent turn is where you would call workflow (with its own opt-in). For a multi-turn objective that should persist without a fixed calendar, use create_goal instead.

Scheduling: the runtime adds ~0–10% jitter to fire times to spread load. Prefer an off-minute over :00 or :30 when the fire time is not user-critical. Missed one-shot durable jobs are surfaced as a single batched message when the session returns; missed recurring jobs advance to the next matching minute and emit cron_missed telemetry.`,
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
				if (tokens[0] === "delete" || tokens[0] === "remove") {
					const id = tokens[1];
					if (!id) {
						ctx.ui.notify("Usage: /cron delete <id>", "warning");
						return;
					}
					ctx.ui.notify(runtime.delete(id) ? `Deleted cron job ${id}.` : `No cron job with id ${id}.`, "info");
					return;
				}
				ctx.ui.notify(formatCronStatus(runtime.list()), "info");
			},
		});
	};
}

export const stepCronExtensionInline = {
	name: "Step cron",
	factory: createStepCronExtension(),
	hidden: true,
} as const;
