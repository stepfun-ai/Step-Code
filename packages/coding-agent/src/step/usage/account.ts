import { createHash } from "node:crypto";
import { readStoredCredential } from "../../core/auth-storage.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { resolveStepLoginProfiles } from "../onboarding.ts";
import type { AccountUsageState, LocalPlanAccount, PlanAccountContext, PlanUsageSnapshot } from "./types.ts";

export function resolvePlanUsageAccount(
	authPath: string,
	env: Record<string, string | undefined> = process.env,
	explicitKey = false,
): PlanAccountContext {
	const stored = readStoredCredential("step", authPath) as
		| { type?: string; access?: unknown; key?: unknown; uid?: unknown; profile?: unknown }
		| undefined;
	const key = stored?.type === "oauth" && typeof stored.access === "string" ? stored.access.trim() : "";
	const profile = typeof stored?.profile === "string" && stored.profile ? stored.profile : "step_plan";
	const uid = typeof stored?.uid === "string" && /^\d+$/u.test(stored.uid) ? stored.uid : undefined;
	let projection: LocalPlanAccount = {
		presence:
			key ||
			(stored?.type === "api_key" && typeof stored.key === "string" && stored.key.trim()) ||
			env.STEP_API_KEY?.trim() ||
			explicitKey
				? "present"
				: "missing",
		eligible: false,
		source: "stored",
		profile,
		accountId: uid,
	};
	if (explicitKey || env.STEP_API_KEY?.trim())
		projection = {
			...projection,
			source: "gateway",
			accountId: undefined,
			profile: undefined,
			reason: "Current API key is a gateway/model credential. Sign in with a personal Plan profile to query usage.",
		};
	else if (!key) projection = { ...projection, reason: "Sign in with step login to query account usage." };
	else if (!["step_plan", "step_plan_oversea"].includes(profile))
		projection = { ...projection, reason: "This login profile does not support personal Plan usage." };
	else {
		const login = resolveStepLoginProfiles(env).find((p) => p.id === profile);
		try {
			const base = new URL(login?.baseUrl ?? "");
			if (
				base.username ||
				base.password ||
				base.search ||
				base.hash ||
				!["https:", "http:"].includes(base.protocol) ||
				(base.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
			)
				throw new Error("endpoint");
			const path = base.pathname.replace(/\/+$/u, "");
			base.pathname = `${path}${path.endsWith("/v1") ? "" : "/v1"}/usage`;
			projection = {
				...projection,
				eligible: true,
				source: "plan",
				region: profile === "step_plan_oversea" ? "Global" : "CN",
				endpoint: base.href,
			};
		} catch {
			projection = { ...projection, reason: "Account endpoint is not valid for usage queries." };
		}
	}
	const identity = createHash("sha256")
		.update(
			JSON.stringify([projection.source, profile, uid, projection.endpoint, key, env.STEP_API_KEY, explicitKey]),
		)
		.digest("hex");
	return { projection, identity, ...(projection.eligible ? { key } : {}) };
}

export function usageText(value: string): string {
	return stripAnsi(value)
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, "")
		.slice(0, 256);
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid usage snapshot");
	return value as Record<string, unknown>;
}
function decimal(value: unknown, positive = false): string {
	if (
		typeof value !== "string" ||
		!/^\d{1,19}$/u.test(value) ||
		BigInt(value) > 9223372036854775807n ||
		(positive && BigInt(value) === 0n)
	)
		throw new Error("Invalid usage snapshot");
	return value;
}
function time(value: unknown): number | null {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 8640000000000000)
		throw new Error("Invalid usage snapshot");
	return value;
}
function percent(value: unknown): number | null {
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)
		throw new Error("Invalid usage snapshot");
	return value;
}
function text(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || value.length > 1024) throw new Error("Invalid usage snapshot");
	return usageText(value);
}

export function decodePlanUsage(value: unknown, now = Date.now()): PlanUsageSnapshot {
	const raw = record(value),
		account = record(raw.account),
		plan = record(raw.plan),
		quota = record(raw.quota);
	if (
		raw.schema_version !== 1 ||
		raw.scope !== "personal_account" ||
		typeof raw.observed_at_ms !== "number" ||
		!Number.isSafeInteger(raw.observed_at_ms) ||
		raw.observed_at_ms <= 0 ||
		raw.observed_at_ms > now + 120000 ||
		!["known", "unavailable"].includes(String(plan.state)) ||
		!["coding", "token", "none"].includes(String(plan.family)) ||
		!["known", "partial"].includes(String(quota.state)) ||
		typeof quota.allowed !== "boolean" ||
		!Array.isArray(quota.windows)
	)
		throw new Error("Invalid usage snapshot");
	const windows = quota.windows.map((v) => {
		const w = record(v);
		if (!["five_hour", "weekly"].includes(String(w.id)) || typeof w.limited !== "boolean")
			throw new Error("Invalid usage snapshot");
		const p = percent(w.used_percent);
		if ((w.limited && p === null) || (!w.limited && p !== null)) throw new Error("Invalid usage snapshot");
		return {
			id: w.id as "five_hour" | "weekly",
			limited: w.limited,
			used_percent: p,
			resets_at_ms: time(w.resets_at_ms),
		};
	});
	if (
		(plan.family === "coding" && (windows.length !== 2 || new Set(windows.map((w) => w.id)).size !== 2)) ||
		(plan.family !== "coding" && windows.length > 0) ||
		(quota.state === "partial" && plan.family !== "token")
	)
		throw new Error("Invalid usage snapshot");
	let buckets: PlanUsageSnapshot["quota"]["credit_buckets"] = null;
	if (quota.credit_buckets !== null) {
		if (!Array.isArray(quota.credit_buckets) || quota.credit_buckets.length > 256)
			throw new Error("Invalid usage snapshot");
		buckets = quota.credit_buckets.map((v) => {
			const b = record(v);
			if (typeof b.type !== "string" || b.type.length > 128) throw new Error("Invalid usage snapshot");
			if (!["subscription", "topup"].includes(b.type))
				return {
					type: usageText(b.type),
					unsupported: true,
					total: "0",
					remaining: "0",
					used_percent: null,
					resets_at_ms: null,
					expires_at_ms: null,
				};
			return {
				type: b.type,
				total: decimal(b.total),
				remaining: decimal(b.remaining),
				used_percent: percent(b.used_percent),
				resets_at_ms: time(b.resets_at_ms),
				expires_at_ms: time(b.expires_at_ms),
			};
		});
	}
	if (
		(quota.state === "partial" && buckets !== null) ||
		(quota.state === "known" && buckets === null) ||
		(plan.family !== "token" && buckets?.length)
	)
		throw new Error("Invalid usage snapshot");
	let subscription: PlanUsageSnapshot["plan"]["subscription"] = null;
	if (plan.subscription !== null) {
		const s = record(plan.subscription);
		subscription = { id: decimal(s.id, true), expires_at_ms: time(s.expires_at_ms) };
	}
	if (
		(plan.state === "unavailable" && (plan.name !== null || subscription !== null)) ||
		(plan.family === "none" && (subscription !== null || quota.allowed))
	)
		throw new Error("Invalid usage snapshot");
	return {
		schema_version: 1,
		observed_at_ms: raw.observed_at_ms,
		scope: "personal_account",
		account: { id: decimal(account.id, true) },
		plan: {
			state: plan.state as "known" | "unavailable",
			family: plan.family as "coding" | "token" | "none",
			name: text(plan.name),
			subscription,
		},
		quota: {
			state: quota.state as "known" | "partial",
			allowed: quota.allowed,
			reason: text(quota.reason),
			windows,
			credit_buckets: buckets,
		},
	};
}

async function readUsageBody(response: Response): Promise<unknown> {
	if (!response.body) throw new Error("Invalid usage snapshot");
	const reader = response.body.getReader(),
		decoder = new TextDecoder("utf-8", { fatal: true });
	let bytes = 0,
		body = "";
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > 256 * 1024) throw new Error("Invalid usage snapshot");
			body += decoder.decode(next.value, { stream: true });
		}
		body += decoder.decode();
		return JSON.parse(body);
	} catch (error) {
		void reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}

function crossedSnapshotBoundary(state: AccountUsageState, now: number): boolean {
	const snapshot = state.snapshot;
	if (!snapshot || state.receivedAt === undefined) return false;
	const crossed = (value: number | null): boolean => value !== null && value <= now && state.receivedAt! < value;
	return (
		snapshot.quota.windows.some((window) => crossed(window.resets_at_ms)) ||
		(snapshot.quota.credit_buckets ?? []).some(
			(bucket) => crossed(bucket.resets_at_ms) || crossed(bucket.expires_at_ms),
		) ||
		(snapshot.plan.subscription !== null && crossed(snapshot.plan.subscription.expires_at_ms))
	);
}

export class PlanUsageController {
	private readonly resolve: () => PlanAccountContext;
	private readonly fetchFn: typeof fetch;
	private readonly clock: () => number;
	private readonly timeoutMS: number;
	private readonly monotonic: () => number;
	private receivedTick?: number;
	private retryTick?: number;
	private identity = "";
	private generation = 0;
	private abort?: AbortController;
	private pending?: Promise<AccountUsageState>;
	private current: AccountUsageState = {
		status: "idle",
		account: { presence: "missing", eligible: false, source: "none" },
	};
	constructor(
		resolve: () => PlanAccountContext,
		fetchFn: typeof fetch = fetch,
		clock: () => number = Date.now,
		timeoutMS = 12000,
		monotonic: () => number = clock === Date.now ? () => performance.now() : clock,
	) {
		this.monotonic = monotonic;
		this.resolve = resolve;
		this.fetchFn = fetchFn;
		this.clock = clock;
		this.timeoutMS = timeoutMS;
	}
	readCached(): AccountUsageState {
		const context = this.resolve();
		if (context.identity !== this.identity) {
			this.cancel();
			this.receivedTick = undefined;
			this.retryTick = undefined;
			this.identity = context.identity;
			this.current = {
				status: context.projection.eligible ? "idle" : "unsupported",
				account: context.projection,
				message: context.projection.reason,
			};
		}
		if (this.current.snapshot && this.monotonic() - (this.receivedTick ?? -Infinity) > 300000)
			this.current = {
				...this.current,
				status: "error",
				snapshot: undefined,
				message: "Account snapshot expired. Open /usage account to refresh.",
			};
		if (
			this.current.snapshot &&
			this.current.status === "ready" &&
			(this.monotonic() - (this.receivedTick ?? -Infinity) >= 30000 ||
				crossedSnapshotBoundary(this.current, this.clock()))
		)
			this.current = { ...this.current, status: "stale" };
		return { ...this.current, account: context.projection };
	}
	cancel(): void {
		this.generation++;
		this.abort?.abort();
		this.abort = undefined;
		this.pending = undefined;
		if (this.current.status === "loading")
			this.current = { ...this.current, status: this.current.snapshot ? "stale" : "idle" };
	}
	query(force = false): Promise<AccountUsageState> {
		const state = this.readCached(),
			context = this.resolve();
		if (!context.projection.eligible || !context.key || !context.projection.endpoint) return Promise.resolve(state);
		if (this.pending) return this.pending;
		if (this.retryTick !== undefined && this.retryTick > this.monotonic()) return Promise.resolve(state);
		if (
			!force &&
			state.snapshot &&
			this.monotonic() - (this.receivedTick ?? -Infinity) < 30000 &&
			!crossedSnapshotBoundary(state, this.clock())
		)
			return Promise.resolve(state);
		const attempt = ++this.generation,
			identity = context.identity,
			controller = new AbortController();
		this.abort = controller;
		this.current = { ...state, status: "loading", message: undefined };
		const valid = () =>
			attempt === this.generation && this.resolve().identity === identity && !controller.signal.aborted;
		const work = async (): Promise<AccountUsageState> => {
			const response = await this.fetchFn(context.projection.endpoint!, {
				method: "GET",
				headers: { accept: "application/json", authorization: `Bearer ${context.key}` },
				redirect: "error",
				signal: controller.signal,
			});
			if (!valid()) return this.readCached();
			if (!response.ok) {
				void response.body?.cancel().catch(() => {});
				let retryAt: number | undefined;
				if (response.status === 429) {
					const header = response.headers.get("Retry-After") ?? "1";
					const seconds = /^\d+$/u.test(header) ? Number(header) : (Date.parse(header) - this.clock()) / 1000;
					const duration = Math.max(1, Number.isFinite(seconds) ? seconds : 1) * 1000;
					retryAt = this.clock() + duration;
					this.retryTick = this.monotonic() + duration;
				}
				const clear = response.status === 401 || response.status === 403;
				if (clear) {
					this.receivedTick = undefined;
					this.retryTick = undefined;
				}
				const messages: Record<number, string> = {
					401: "Authentication could not be verified. Retry or check your key.",
					403: "Personal Plan usage does not support this credential scope.",
					404: "Usage API is not available on this platform yet.",
					429: "Too many queries. Retry after the cooldown.",
				};
				if (valid())
					this.current = {
						...state,
						status: !clear && state.snapshot ? "stale" : "error",
						snapshot: clear ? undefined : state.snapshot,
						retryAt,
						message: messages[response.status] ?? "Account quota temporarily unavailable.",
					};
				return this.readCached();
			}
			const snapshot = decodePlanUsage(await readUsageBody(response), this.clock());
			if (!valid()) return this.readCached();
			if (context.projection.accountId && BigInt(snapshot.account.id) !== BigInt(context.projection.accountId)) {
				this.current = {
					status: "error",
					account: state.account,
					message: "Account identity mismatch. Sign in again.",
				};
				return this.readCached();
			}
			this.receivedTick = this.monotonic();
			this.retryTick = undefined;
			this.current = { status: "ready", account: state.account, snapshot, receivedAt: this.clock() };
			return this.readCached();
		};
		let timer!: ReturnType<typeof setTimeout>;
		let onAbort: () => void;
		const cancelled = new Promise<never>((_, reject) => {
			onAbort = () => reject(new Error("Usage cancelled"));
			controller.signal.addEventListener("abort", onAbort, { once: true });
		});
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new Error("Usage timeout"));
			}, this.timeoutMS);
		});
		this.pending = Promise.race([work(), timeout, cancelled])
			.catch(() => {
				if (attempt === this.generation && this.resolve().identity === identity)
					this.current = {
						...state,
						status: state.snapshot ? "stale" : "error",
						message: "Account quota unavailable. Retry when online.",
					};
				return this.readCached();
			})
			.finally(() => {
				clearTimeout(timer);
				controller.signal.removeEventListener("abort", onAbort);
				if (attempt === this.generation) {
					this.pending = undefined;
					this.abort = undefined;
				}
			});
		return this.pending;
	}
}
