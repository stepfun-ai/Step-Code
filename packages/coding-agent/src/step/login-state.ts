/**
 * Account session stored beside the API key.
 *
 * `step login` redeems two independent things: an API key that authorizes model
 * requests, and an account session that lets a host act as the signed-in user
 * (account lookups) and renew itself. The API key lives in `auth.json` with the
 * other provider credentials; this session lives here, because the two have
 * different lifetimes, different owners, and different failure modes — a dead
 * session must never take the API key down with it.
 *
 * Nothing in the CLI needs the session today. It is stored and refreshed so
 * that hosts which do need an identity (the web and desktop clients) can read
 * it, and so a user who never signs in again keeps working exactly as before.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { StepCliLoginState } from "@step-harness/providers/step-provider";
import { refreshStepLoginState, StepLoginRefreshError } from "@step-harness/providers/step-provider";
import { acquireSettingsLockSync } from "../core/settings-manager.ts";
import { resolveStepConfigRoot } from "./environment.ts";
import { resolveStepLoginProfiles, type StepLoginProfileId } from "./onboarding.ts";

/** Bump when the on-disk shape changes incompatibly. */
const LOGIN_STATE_VERSION = 1;

/** Refresh this long before the access token actually expires. */
export const STEP_LOGIN_REFRESH_MARGIN_SEC = 5 * 60;

/** Fallback when neither the server nor the token states a lifetime. */
const DEFAULT_ACCESS_TOKEN_TTL_SEC = 30 * 60;

const LOGIN_STATE_FILE_NAME = "step-login.json";

export interface StepLoginState {
	readonly version: number;
	/** Login region; decides which developer center refreshes this session. */
	readonly profile: StepLoginProfileId;
	readonly appId: string;
	readonly deviceId: string;
	readonly accessToken: string;
	readonly refreshToken: string;
	/** Unix seconds. */
	readonly accessExpiresAt: number;
	/** Unix seconds, when the refresh token carries one. Past this, re-login. */
	readonly refreshExpiresAt?: number;
}

/** Where the session lives. Overridable so hosts can isolate their resources. */
export function getStepLoginStatePath(env: Record<string, string | undefined> = process.env): string {
	const explicit = env.STEPCODE_LOGIN_STATE_PATH?.trim();
	if (explicit) return explicit;
	// Follow the credential path: a host that isolates `auth.json` isolates the
	// session too. Falling back to the shared default would let two isolated
	// instances overwrite each other's identity.
	const authPath = env.STEPCODE_AUTH_PATH?.trim();
	if (authPath) return join(dirname(resolve(authPath)), LOGIN_STATE_FILE_NAME);
	return join(resolveStepConfigRoot(env), LOGIN_STATE_FILE_NAME);
}

/**
 * Read the stored session.
 *
 * A missing, unreadable or wrongly shaped file means "no session" rather than an
 * error: the CLI must keep working for users who only ever had an API key.
 */
export function readStepLoginState(env: Record<string, string | undefined> = process.env): StepLoginState | undefined {
	const path = getStepLoginStatePath(env);
	if (!existsSync(path)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
	return parseStepLoginState(parsed);
}

function parseStepLoginState(value: unknown): StepLoginState | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	// A newer shape must not be read as an older one: the required fields below
	// would otherwise either pass by luck or silently degrade to "no session".
	if (typeof record.version === "number" && record.version > LOGIN_STATE_VERSION) return undefined;
	const accessToken = readToken(record.accessToken);
	const refreshToken = readToken(record.refreshToken);
	const deviceId = readToken(record.deviceId);
	const appId = readToken(record.appId);
	const profile = readToken(record.profile);
	const accessExpiresAt = readTimestamp(record.accessExpiresAt);
	if (!accessToken || !refreshToken || !deviceId || !appId || !profile || accessExpiresAt === undefined) {
		return undefined;
	}
	const refreshExpiresAt = readTimestamp(record.refreshExpiresAt);
	return {
		version: typeof record.version === "number" ? record.version : LOGIN_STATE_VERSION,
		profile: profile as StepLoginProfileId,
		appId,
		deviceId,
		accessToken,
		refreshToken,
		accessExpiresAt,
		...(refreshExpiresAt === undefined ? {} : { refreshExpiresAt }),
	};
}

/** Build the stored shape from what the login flow redeemed. */
export function buildStepLoginState(
	login: StepCliLoginState,
	profile: StepLoginProfileId,
	now: number = Date.now(),
): StepLoginState {
	const nowSec = Math.floor(now / 1000);
	const accessTtl = login.expiresIn && login.expiresIn > 0 ? login.expiresIn : DEFAULT_ACCESS_TOKEN_TTL_SEC;
	const refreshExpiresAt = readJwtExpiresAt(login.refreshToken);
	return {
		version: LOGIN_STATE_VERSION,
		profile,
		appId: login.appId,
		deviceId: login.deviceId,
		accessToken: login.accessToken,
		refreshToken: login.refreshToken,
		accessExpiresAt: nowSec + accessTtl,
		...(refreshExpiresAt === undefined ? {} : { refreshExpiresAt }),
	};
}

/**
 * Persist the session.
 *
 * Takes the cross-process lock, so a sign-in that lands while another process
 * is committing a refresh cannot be overwritten by that refresh's result.
 *
 * Written atomically and owner-only: it holds a long-lived refresh token, so a
 * partially written or world-readable file is a credential leak.
 */
export async function saveStepLoginState(
	state: StepLoginState,
	env: Record<string, string | undefined> = process.env,
): Promise<void> {
	const path = await ensureLoginStateFile(env);
	let release: (() => void) | undefined;
	try {
		release = acquireSettingsLockSync(path);
	} catch {
		// Another process holds it. It re-reads before committing, so letting it
		// win is safe and avoids interleaved writes.
		return;
	}
	try {
		await writeLoginStateFile(state, env);
	} finally {
		release();
	}
}

/** Write without locking; callers must already hold the lock. */
async function writeLoginStateFile(state: StepLoginState, env: Record<string, string | undefined>): Promise<void> {
	const path = getStepLoginStatePath(env);
	await mkdir(dirname(path), { recursive: true });
	// A fixed name would let two concurrent writers in one process share a
	// temporary file, and a crash mid-write would leave a credential behind.
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
	// `rename` keeps the temporary file's mode, but a pre-existing file may have
	// been created with wider permissions by an older release.
	await chmod(path, 0o600);
}

/** The lock needs a file to lock, so create an inert one when there is none. */
async function ensureLoginStateFile(env: Record<string, string | undefined>): Promise<string> {
	const path = getStepLoginStatePath(env);
	if (!existsSync(path)) {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, "", { encoding: "utf8", mode: 0o600 });
	}
	return path;
}

/**
 * Drop the session. The API key in `auth.json` is deliberately left alone.
 *
 * Takes the lock so a sign-out cannot land between a committer's re-read and
 * its write, which would resurrect a session the user just signed out of.
 *
 * Errors other than "already gone" are surfaced: reporting a successful sign-out
 * while a long-lived refresh token is still on disk is worse than failing.
 */
export async function clearStepLoginState(env: Record<string, string | undefined> = process.env): Promise<void> {
	const path = getStepLoginStatePath(env);
	if (!existsSync(path)) return;
	let release: (() => void) | undefined;
	try {
		release = acquireSettingsLockSync(path);
	} catch {
		// Not lockable: another process owns it, so removing it could delete a
		// session that was just written. Leave it for that process to settle.
		return;
	}
	try {
		await rm(path, { force: true });
	} finally {
		release();
	}
}

/**
 * Delete the session, but only while it is still the one that was examined.
 *
 * A sign-in with another account, or a sign-out, can land while a refresh is in
 * flight. Deleting unconditionally would then remove a session the user just
 * created, so the stored refresh token has to match before anything is removed.
 *
 * The lock matters for the same reason: without it a delete can land between a
 * committer's re-read and its write, resurrecting a session that was signed out.
 */
async function discardLoginState(
	env: Record<string, string | undefined>,
	expectedRefreshToken: string,
): Promise<boolean> {
	const path = getStepLoginStatePath(env);
	if (!existsSync(path)) return false;
	let release: (() => void) | undefined;
	try {
		release = acquireSettingsLockSync(path);
	} catch {
		// Not lockable: it either vanished or another process owns it. Leaving it
		// is safer than deleting something that may already have been replaced.
		return false;
	}
	try {
		const latest = readStepLoginState(env);
		if (!latest || latest.refreshToken !== expectedRefreshToken) return false;
		await rm(path, { force: true });
		return true;
	} finally {
		release();
	}
}

export type StepLoginTokenOutcome =
	| {
			readonly status: "ready";
			readonly accessToken: string;
			readonly deviceId: string;
			readonly appId: string;
			readonly profile: StepLoginProfileId;
	  }
	| { readonly status: "missing" }
	/** The refresh token is gone; only a new sign-in can recover. */
	| { readonly status: "expired"; readonly reason: string }
	/** Transient failure; the session is still on disk and may refresh later. */
	| { readonly status: "unavailable"; readonly reason: string };

export interface StepLoginTokenOptions {
	readonly env?: Record<string, string | undefined>;
	readonly signal?: AbortSignal;
	readonly fetch?: typeof fetch;
}

/**
 * Return a usable access token, refreshing it first when it is close to expiry.
 *
 * This is the entry point for anything that needs an identity: the web and
 * desktop hosts, and account lookups. Callers get an explicit outcome instead
 * of a token that may be stale, so "not signed in" is never mistaken for
 * "signed in as nobody".
 */
export async function getStepLoginToken(options: StepLoginTokenOptions = {}): Promise<StepLoginTokenOutcome> {
	const env = options.env ?? process.env;
	const current = readStepLoginState(env);
	if (!current) return { status: "missing" };
	// A refresh token past its own expiry cannot be renewed at all, so there is
	// nothing to wait for: drop it now rather than let every caller rediscover it.
	if (isRefreshTokenExpired(current, Date.now())) {
		await discardLoginState(env, current.refreshToken);
		return { status: "expired", reason: "the account session has expired" };
	}
	if (!needsRefresh(current, Date.now())) return ready(current);

	try {
		const result = await refreshAndCommit(env, options);
		if (result.kind === "refreshed") return ready(result.state);
		if (result.kind === "discarded") {
			return { status: "expired", reason: "the account session is no longer signed in" };
		}
		const latest = result.state ?? readStepLoginState(env);
		if (!latest) return { status: "missing" };
		if (isRefreshTokenExpired(latest, Date.now()))
			return { status: "expired", reason: "the account session has expired" };
		if (!needsRefresh(latest, Date.now())) return ready(latest);
		// Another process is mid-refresh. The stored token may still be valid
		// inside the refresh margin, and handing it back beats reporting no
		// identity while a concurrent refresh is still in flight.
		if (latest.accessExpiresAt > Math.floor(Date.now() / 1000)) return ready(latest);
		return { status: "unavailable", reason: "another process is refreshing the session" };
	} catch (error) {
		// A transient failure keeps the session. The access token may still be
		// valid for a while inside the refresh margin, and handing that back is
		// strictly better than reporting no identity at all.
		const latest = readStepLoginState(env);
		if (latest && latest.accessExpiresAt > Math.floor(Date.now() / 1000)) return ready(latest);
		return { status: "unavailable", reason: describe(error) };
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRefreshTokenExpired(state: StepLoginState, nowMs: number): boolean {
	return state.refreshExpiresAt !== undefined && state.refreshExpiresAt <= Math.floor(nowMs / 1000);
}

function ready(state: StepLoginState): StepLoginTokenOutcome {
	return {
		status: "ready",
		accessToken: state.accessToken,
		deviceId: state.deviceId,
		appId: state.appId,
		profile: state.profile,
	};
}

function needsRefresh(state: StepLoginState, nowMs: number): boolean {
	return state.accessExpiresAt - STEP_LOGIN_REFRESH_MARGIN_SEC <= Math.floor(nowMs / 1000);
}

/**
 * Outcome of a refresh attempt.
 *
 * `discarded` means the session was positively dead and has been removed;
 * `unchanged` means nothing was written, and `state` carries whatever is on disk
 * now when there is something.
 */
type RefreshCommitResult =
	| { readonly kind: "refreshed"; readonly state: StepLoginState }
	| { readonly kind: "discarded" }
	| { readonly kind: "unchanged"; readonly state?: StepLoginState };

/**
 * Refresh the session, then commit the result under the cross-process lock.
 *
 * The network call deliberately runs *outside* the lock: holding it for up to
 * `REFRESH_TIMEOUT_MS` would let a slow refresh block sign-out for that long,
 * and would let a stolen lock (proper-lockfile's 10s stale window) corrupt a
 * session once refresh tokens start rotating. The lock only guards the
 * read-modify-write, which is where a lost update would actually matter.
 *
 * Committing re-reads the file, so a sign-out or a sign-in with another account
 * that landed while the request was in flight discards this result instead of
 * writing a session the user has already replaced. A session that turns out to
 * be unredeemable is dropped the same way — only while it is still the session
 * that failed.
 */
async function refreshAndCommit(
	env: Record<string, string | undefined>,
	options: StepLoginTokenOptions,
): Promise<RefreshCommitResult> {
	const path = getStepLoginStatePath(env);
	const before = readStepLoginState(env);
	if (!before) return { kind: "unchanged" };

	let refreshed: StepCliLoginState;
	try {
		refreshed = await refreshStepLoginState({
			authBaseUrl: resolveAuthBaseUrl(before.profile, env),
			state: {
				accessToken: before.accessToken,
				refreshToken: before.refreshToken,
				deviceId: before.deviceId,
				appId: before.appId,
			},
			...(options.signal ? { signal: options.signal } : {}),
			...(options.fetch ? { fetch: options.fetch } : {}),
		});
	} catch (error) {
		if (error instanceof StepLoginRefreshError && error.failure === "unredeemable") {
			return (await discardLoginState(env, before.refreshToken)) ? { kind: "discarded" } : { kind: "unchanged" };
		}
		throw error;
	}

	if (!existsSync(path)) return { kind: "unchanged" };
	let release: (() => void) | undefined;
	try {
		release = acquireSettingsLockSync(path);
	} catch {
		// Another process is committing; it re-reads the same way, so letting it
		// win is safe and avoids a second write.
		return { kind: "unchanged" };
	}
	try {
		const latest = readStepLoginState(env);
		// Signed out, or signed in as someone else, while the request was running.
		if (!latest || latest.refreshToken !== before.refreshToken) {
			return { kind: "unchanged", ...(latest ? { state: latest } : {}) };
		}
		const { refreshExpiresAt: _inherited, ...rest } = latest;
		const committed: StepLoginState = {
			...rest,
			accessToken: refreshed.accessToken,
			refreshToken: refreshed.refreshToken,
			accessExpiresAt: Math.floor(Date.now() / 1000) + (refreshed.expiresIn ?? DEFAULT_ACCESS_TOKEN_TTL_SEC),
			// Recomputed rather than inherited from the token being replaced: the
			// response carries a refresh token, and once rotation starts its
			// deadline is the previous token's, which would discard a live session.
			...(readJwtExpiresAt(refreshed.refreshToken) === undefined
				? {}
				: { refreshExpiresAt: readJwtExpiresAt(refreshed.refreshToken) }),
		};
		await writeLoginStateFile(committed, env);
		return { kind: "refreshed", state: committed };
	} finally {
		release();
	}
}

/** The developer center that issued the session is the one that refreshes it. */
function resolveAuthBaseUrl(profile: StepLoginProfileId, env: Record<string, string | undefined>): string {
	const resolved = resolveStepLoginProfiles(env).find((candidate) => candidate.id === profile);
	return resolved?.authBaseUrl ?? "https://platform.stepfun.com";
}

/**
 * Read `exp` out of a JWT without verifying it.
 *
 * Only the expiry is used, and only to schedule a refresh; a wrong value costs
 * one extra refresh or one failed request, never a wrong credential.
 */
function readJwtExpiresAt(token: string): number | undefined {
	const parts = token.split(".");
	if (parts.length < 2) return undefined;
	try {
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
		return readTimestamp(payload.exp);
	} catch {
		return undefined;
	}
}

function readTimestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function readToken(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
