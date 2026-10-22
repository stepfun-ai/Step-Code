/**
 * Room codes: the short number one person reads out so the other's agent can find them.
 *
 * A code is a rendezvous token, not an authorization. It earns its safety entirely from being
 * short-lived, single-use and attempt-limited; everything else about joining a room is confirmed
 * separately by the two people.
 *
 * Codes are issued with a minimum length and an explicit timeout so a caller cannot quietly
 * weaken them.
 */

export interface RoomCodeOptions {
	/** Codes fewer than this many digits are refused. */
	minLength?: number;
	/** How long an issued code stays valid. */
	ttlMs?: number;
	/** Wrong attempts tolerated before the code is burned. */
	maxFailedAttempts?: number;
	/** Injectable clock, so tests do not sleep. */
	now?: () => number;
	/** Injectable randomness, so tests can pin codes. */
	randomDigits?: (length: number) => string;
}

export type RoomCodeClaim =
	| { status: "accepted"; roomId: string }
	| { status: "expired" }
	| { status: "not-found" }
	| { status: "already-used" }
	| { status: "too-many-attempts" };

interface Entry {
	roomId: string;
	createdAt: number;
	failedAttempts: number;
	used: boolean;
}

const DEFAULT_MIN_LENGTH = 6;
const DEFAULT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_FAILED_ATTEMPTS = 3;

function defaultRandomDigits(length: number): string {
	let digits = "";
	for (let index = 0; index < length; index++) digits += Math.floor(Math.random() * 10).toString();
	return digits;
}

/**
 * In-memory issuer. The host decides where the code is published for the other side; this type only
 * enforces the lifetime rules and keeps the attempt counter that makes a short code safe.
 */
export class RoomCodeBook {
	private readonly entries = new Map<string, Entry>();
	private readonly minLength: number;
	private readonly ttlMs: number;
	private readonly maxFailedAttempts: number;
	private readonly now: () => number;
	private readonly randomDigits: (length: number) => string;

	constructor(options: RoomCodeOptions = {}) {
		this.minLength = options.minLength ?? DEFAULT_MIN_LENGTH;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.maxFailedAttempts = options.maxFailedAttempts ?? DEFAULT_MAX_FAILED_ATTEMPTS;
		this.now = options.now ?? Date.now;
		this.randomDigits = options.randomDigits ?? defaultRandomDigits;
		if (!Number.isInteger(this.minLength) || this.minLength < 6) {
			throw new Error("room codes must be at least six digits");
		}
		if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new Error("room code ttl must be positive");
	}

	/** Issue a code for `roomId`, replacing any code this room already had. */
	issue(roomId: string, length = 8): string {
		if (!roomId) throw new Error("roomId is required");
		if (!Number.isInteger(length) || length < this.minLength) {
			throw new Error(`room codes must be at least ${this.minLength} digits`);
		}
		this.prune();
		// Re-issuing for the same room supersedes its earlier code instead of colliding with it.
		this.revoke(roomId);
		let code = this.randomDigits(length);
		// Collisions inside one process are rare but cheap to rule out; the loop is bounded so a bad
		// random source fails loudly instead of spinning.
		for (let attempt = 0; attempt < 32 && this.entries.has(code); attempt++) code = this.randomDigits(length);
		if (this.entries.has(code)) throw new Error("could not allocate a unique room code");
		this.entries.set(code, { roomId, createdAt: this.now(), failedAttempts: 0, used: false });
		return code;
	}

	/** The newcomer presents a code; a wrong guess burns one attempt, never the room's own state. */
	claim(code: string): RoomCodeClaim {
		const entry = this.entries.get(code);
		if (!entry) return { status: "not-found" };
		if (entry.used) return { status: "already-used" };
		if (this.isExpired(entry)) {
			this.entries.delete(code);
			return { status: "expired" };
		}
		if (entry.failedAttempts >= this.maxFailedAttempts) {
			this.entries.delete(code);
			return { status: "too-many-attempts" };
		}
		entry.used = true;
		return { status: "accepted", roomId: entry.roomId };
	}

	/**
	 * Record a wrong code presented by someone, scoped to the room they were trying to join.
	 *
	 * Attempts are tracked per room rather than per presented string: a stranger typing random digits
	 * must not be able to burn every outstanding room by guessing.
	 */
	recordFailure(roomId: string): void {
		for (const [code, entry] of this.entries) {
			if (entry.roomId !== roomId || entry.used) continue;
			entry.failedAttempts++;
			// Burn the code as soon as the budget is gone, so it cannot be guessed again later.
			if (entry.failedAttempts >= this.maxFailedAttempts) this.entries.delete(code);
		}
	}

	/** Whether a room's code is still claimable: unused, unexpired and not out of attempts. */
	isPending(code: string): boolean {
		const entry = this.entries.get(code);
		if (!entry || entry.used || this.isExpired(entry)) return false;
		return entry.failedAttempts < this.maxFailedAttempts;
	}

	revoke(roomId: string): void {
		for (const [code, entry] of this.entries) if (entry.roomId === roomId) this.entries.delete(code);
	}

	private isExpired(entry: Entry): boolean {
		return this.now() - entry.createdAt > this.ttlMs;
	}

	private prune(): void {
		for (const [code, entry] of this.entries) {
			if (this.isExpired(entry) || entry.used) this.entries.delete(code);
		}
	}
}
