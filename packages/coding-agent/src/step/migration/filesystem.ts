import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export class MigrationError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(code: string, status = 400) {
		super(code);
		this.name = "MigrationError";
		this.code = code;
		this.status = status;
	}
}

export function fail(code: string, status = 400): never {
	throw new MigrationError(code, status);
}
export function diagnosticCode(error: unknown): string {
	return error instanceof MigrationError ? error.code : "migration-io-error";
}
export function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-document");
	return value as Record<string, unknown>;
}
export function hash(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
export function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
export function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export function info(path: string): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if (missing(error)) return undefined;
		throw error;
	}
}
/** Canonicalize host-selected anchors, including macOS system-level /var and /tmp aliases. */
export function anchor(path: string): string {
	if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) fail("invalid-path");
	const parent = dirname(path);
	try {
		return realpathSync(path);
	} catch (error) {
		if (!missing(error) || parent === path) throw error;
		return join(anchor(parent), relative(parent, path));
	}
}
export function safePath(path: string): void {
	if (!isAbsolute(path) || path.includes("\0")) fail("invalid-path");
	let current = parse(path).root;
	for (const part of relative(current, resolve(path)).split(sep).filter(Boolean)) {
		current = join(current, part);
		const entry = info(current);
		if (!entry) return;
		if (entry.isSymbolicLink()) fail("unsafe-link");
	}
}
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export function bytes(path: string, optional = false, limit = MAX_FILE_BYTES): Buffer | undefined {
	safePath(path);
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (optional && missing(error)) return undefined;
		throw error;
	}
	try {
		const before = fstatSync(fd);
		if (!before.isFile() || before.size > limit) fail("unsafe-file-size-or-type");
		const buffer = Buffer.alloc(before.size + 1);
		let count = 0;
		while (count < buffer.length) {
			const read = readSync(fd, buffer, count, buffer.length - count, count);
			if (!read) break;
			count += read;
		}
		const value = buffer.subarray(0, count);
		const after = fstatSync(fd);
		safePath(path);
		const linked = lstatSync(path);
		if (
			value.length !== before.size ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			linked.ino !== before.ino ||
			linked.dev !== before.dev
		)
			fail("source-changed", 409);
		return value;
	} finally {
		closeSync(fd);
	}
}
export function text(path: string, optional = false): string | undefined {
	return bytes(path, optional)?.toString("utf8");
}
export interface PackageFile {
	path: string;
	data: Buffer;
}
export function tree(root: string): PackageFile[] {
	const files: PackageFile[] = [];
	let size = 0;
	const visit = (dir: string, depth: number): void => {
		if (depth > 12) fail("resource-limit");
		safePath(dir);
		const entries = readdirSync(dir, { withFileTypes: true });
		if (entries.length > 1024) fail("resource-limit");
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(dir, entry.name);
			if (entry.isSymbolicLink()) fail("unsafe-link");
			if (entry.isDirectory()) visit(path, depth + 1);
			else {
				const data = bytes(path)!;
				size += data.length;
				if (files.length >= 512 || size > 32 * 1024 * 1024) fail("resource-limit");
				files.push({ path: relative(root, path), data });
			}
		}
	};
	visit(root, 0);
	return files;
}
export function treeHash(files: PackageFile[]): string {
	return hash(stable(files.map((f) => [f.path, hash(f.data)])));
}
export function durableWrite(path: string, data: string | Buffer, exclusive = true): void {
	safePath(path);
	const fd = openSync(path, exclusive ? "wx" : "w", 0o600);
	try {
		writeFileSync(fd, data);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
export function privateDir(path: string, restricted = false): void {
	safePath(path);
	mkdirSync(path, { recursive: true, mode: 0o700 });
	safePath(path);
	const entry = lstatSync(path);
	if (!entry.isDirectory() || (restricted && process.platform !== "win32" && (entry.mode & 0o077) !== 0))
		fail("unsafe-state-directory");
}
export function syncFile(path: string): void {
	safePath(path);
	// Windows flushes only through a writable handle (a read-only one fails with EPERM) and has no
	// O_NOFOLLOW; safePath above has already refused links on the way to this file.
	const fd = openSync(path, process.platform === "win32" ? "r+" : constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
export function syncDir(path: string): void {
	// Windows cannot fsync a directory handle (EPERM); NTFS journals the rename or create itself.
	// Throwing here would report a write that already took place as failed.
	if (process.platform === "win32") return;
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
