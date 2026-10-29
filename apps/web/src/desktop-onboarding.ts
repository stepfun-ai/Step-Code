import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type DesktopOnboardingStatus = "unseen" | "offered" | "in_progress" | "completed" | "skipped";
export interface DesktopOnboardingState {
	schemaVersion: 1;
	flowVersion: 1;
	revision: number;
	status: DesktopOnboardingStatus;
	lastJobId?: string;
	updatedAt: string;
}
export interface DesktopOnboardingPatch {
	expectedRevision: number;
	status: DesktopOnboardingStatus;
	lastJobId?: string;
}
export class DesktopOnboardingError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, status = 400) {
		super(code);
		this.name = "DesktopOnboardingError";
		this.code = code;
		this.status = status;
	}
}
const STATUSES: DesktopOnboardingStatus[] = ["unseen", "offered", "in_progress", "completed", "skipped"];
const MAX_BYTES = 4096;
function fail(code: string, status = 400): never {
	throw new DesktopOnboardingError(code, status);
}
function code(error: unknown): unknown {
	return error && typeof error === "object" && "code" in error ? error.code : undefined;
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-onboarding-data");
	const result = value as Record<string, unknown>;
	if (Object.keys(result).some((key) => !keys.includes(key))) fail("invalid-onboarding-data");
	return result;
}
function revision(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("invalid-onboarding-data");
	return value;
}
function status(value: unknown): DesktopOnboardingStatus {
	if (typeof value !== "string" || !STATUSES.includes(value as DesktopOnboardingStatus))
		fail("invalid-onboarding-data");
	return value as DesktopOnboardingStatus;
}
function jobId(value: unknown): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) fail("invalid-onboarding-job-id");
	return value;
}
function absent(path: string): boolean {
	try {
		lstatSync(path);
		return false;
	} catch (error) {
		if (code(error) === "ENOENT") return true;
		throw error;
	}
}

/**
 * Host-owned state, independent of credentials, sessions and browser storage.
 * Missing state is a read-only revision-zero snapshot; firstRun is the caller's decision.
 * Completed/skipped states are sticky for flowVersion 1, across restart, upgrade and logout.
 * Writes use an owner-only exclusive lock and atomic rename. A leftover lock is reported,
 * never stolen: the Host owner must resolve an interrupted writer before retrying.
 */
export class DesktopOnboardingStore {
	private readonly agentDir: string;
	private readonly parent: string;
	private readonly parentIdentity: { dev: number; ino: number };
	private readonly path: string;
	private readonly lockPath: string;
	private directoryIdentity?: { dev: number; ino: number };
	constructor(options: { agentDir: string }) {
		if (
			typeof options.agentDir !== "string" ||
			!isAbsolute(options.agentDir) ||
			options.agentDir.includes("\0") ||
			options.agentDir.split(/[/\\]/).includes("..")
		)
			fail("invalid-onboarding-path");
		let requested = resolve(options.agentDir);
		try {
			// Canonicalize only the system-owned macOS aliases; user-directory links are refused.
			if (process.platform === "darwin") {
				for (const alias of ["/var", "/tmp"]) {
					if (requested.startsWith(`${alias}/`)) requested = join(realpathSync(alias), relative(alias, requested));
				}
			}
			let ancestor = dirname(requested);
			while (absent(ancestor)) ancestor = dirname(ancestor);
			let current = ancestor;
			while (true) {
				const info = lstatSync(current);
				if (info.isSymbolicLink() || !info.isDirectory()) fail("unsafe-onboarding-path", 409);
				if (dirname(current) === current) break;
				current = dirname(current);
			}
			const info = lstatSync(ancestor);
			this.parent = realpathSync(ancestor);
			this.parentIdentity = { dev: info.dev, ino: info.ino };
			this.agentDir = join(this.parent, relative(ancestor, requested));
		} catch (error) {
			if (error instanceof DesktopOnboardingError) throw error;
			fail("onboarding-directory-unavailable", 503);
		}
		this.path = join(this.agentDir, "desktop-onboarding.json");
		this.lockPath = `${this.path}.lock`;
	}
	private checkDirectory(create = false): boolean {
		const parentInfo = lstatSync(this.parent);
		if (
			parentInfo.isSymbolicLink() ||
			parentInfo.dev !== this.parentIdentity.dev ||
			parentInfo.ino !== this.parentIdentity.ino
		)
			fail("unsafe-onboarding-path", 409);
		let path = this.parent;
		for (const part of relative(this.parent, this.agentDir).split(sep)) {
			path = join(path, part);
			if (absent(path)) {
				if (this.directoryIdentity) fail("unsafe-onboarding-path", 409);
				if (!create) return false;
				mkdirSync(path, { mode: 0o700 });
			}
			const info = lstatSync(path);
			if (info.isSymbolicLink() || !info.isDirectory()) fail("unsafe-onboarding-path", 409);
		}
		const info = lstatSync(this.agentDir);
		if (
			this.directoryIdentity &&
			(info.dev !== this.directoryIdentity.dev || info.ino !== this.directoryIdentity.ino)
		)
			fail("unsafe-onboarding-path", 409);
		this.directoryIdentity ??= { dev: info.dev, ino: info.ino };
		return true;
	}
	private read(): DesktopOnboardingState {
		if (!this.checkDirectory() || absent(this.path))
			return {
				schemaVersion: 1,
				flowVersion: 1,
				revision: 0,
				status: "unseen",
				updatedAt: new Date(0).toISOString(),
			};
		const info = lstatSync(this.path);
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail("unsafe-onboarding-path", 409);
		const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
		let value: unknown;
		try {
			const opened = fstatSync(fd);
			if (opened.ino !== info.ino || opened.dev !== info.dev || opened.size > MAX_BYTES)
				fail("invalid-onboarding-file", 409);
			const buffer = Buffer.alloc(MAX_BYTES + 1);
			let size = 0;
			while (size < buffer.length) {
				const count = readSync(fd, buffer, size, buffer.length - size, null);
				if (!count) break;
				size += count;
			}
			if (size > MAX_BYTES) fail("invalid-onboarding-file", 409);
			value = JSON.parse(buffer.subarray(0, size).toString("utf8"));
		} finally {
			closeSync(fd);
		}
		try {
			const input = record(value, ["schemaVersion", "flowVersion", "revision", "status", "lastJobId", "updatedAt"]);
			if (
				input.schemaVersion !== 1 ||
				input.flowVersion !== 1 ||
				typeof input.updatedAt !== "string" ||
				!Number.isFinite(Date.parse(input.updatedAt)) ||
				new Date(input.updatedAt).toISOString() !== input.updatedAt
			)
				fail("invalid-onboarding-file", 409);
			return {
				schemaVersion: 1,
				flowVersion: 1,
				revision: revision(input.revision),
				status: status(input.status),
				...(input.lastJobId === undefined ? {} : { lastJobId: jobId(input.lastJobId) }),
				updatedAt: input.updatedAt,
			};
		} catch {
			fail("invalid-onboarding-file", 409);
		}
	}
	get(): DesktopOnboardingState {
		try {
			return this.read();
		} catch (error) {
			if (error instanceof DesktopOnboardingError) throw error;
			fail(error instanceof SyntaxError ? "invalid-onboarding-file" : "onboarding-read-failed", 409);
		}
	}
	update(patch: DesktopOnboardingPatch): DesktopOnboardingState {
		try {
			return this.write(patch);
		} catch (error) {
			if (error instanceof DesktopOnboardingError) throw error;
			throw new DesktopOnboardingError("onboarding-write-failed", 503);
		}
	}
	private write(patch: DesktopOnboardingPatch): DesktopOnboardingState {
		const input = record(patch, ["expectedRevision", "status", "lastJobId"]);
		const expected = revision(input.expectedRevision);
		const nextStatus = status(input.status);
		const lastJobId = "lastJobId" in input ? jobId(input.lastJobId) : undefined;
		let lock: number | undefined;
		let stage: string | undefined;
		try {
			this.checkDirectory(true);
			try {
				lock = openSync(this.lockPath, "wx", 0o600);
			} catch (error) {
				if (code(error) === "EEXIST") fail("onboarding-locked", 409);
				throw error;
			}
			const current = this.get();
			if (current.revision !== expected) fail("onboarding-revision-conflict", 409);
			if ((current.status === "completed" || current.status === "skipped") && nextStatus !== current.status)
				fail("onboarding-flow-finished", 409);
			if (current.revision >= Number.MAX_SAFE_INTEGER) fail("onboarding-revision-exhausted", 409);
			const next: DesktopOnboardingState = {
				...current,
				status: nextStatus,
				revision: current.revision + 1,
				...(lastJobId === undefined ? {} : { lastJobId }),
				updatedAt: new Date().toISOString(),
			};
			stage = join(this.agentDir, `.desktop-onboarding-${randomUUID()}.tmp`);
			const fd = openSync(stage, "wx", 0o600);
			try {
				fchmodSync(fd, 0o600);
				writeFileSync(fd, `${JSON.stringify(next)}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			this.checkDirectory();
			// Recheck the destination before rename; never follow a substituted file link.
			this.get();
			renameSync(stage, this.path);
			stage = undefined;
			const dir = openSync(this.agentDir, constants.O_RDONLY);
			try {
				fsyncSync(dir);
			} finally {
				closeSync(dir);
			}
			return next;
		} finally {
			const owned = lock === undefined ? undefined : fstatSync(lock);
			if (lock !== undefined) closeSync(lock);
			if (stage) {
				this.checkDirectory();
				unlinkSync(stage);
			}
			if (owned) {
				this.checkDirectory();
				const current = lstatSync(this.lockPath);
				if (current.ino !== owned.ino || current.dev !== owned.dev) fail("onboarding-lock-replaced", 409);
				unlinkSync(this.lockPath);
			}
		}
	}
}
