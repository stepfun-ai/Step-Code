import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Read-only access to session JSONL files. Nothing here writes to a session
 * file: SessionManager's loadEntriesFromFile() repairs a missing trailing
 * newline, so the indexer must never reuse it.
 */

const READ_CHUNK_BYTES = 1024 * 1024;

export interface FileFingerprint {
	size: number;
	mtimeMs: number;
	/** "dev:ino"; a secondary signal only, inode numbers are unreliable on some platforms. */
	devIno: string;
}

export function statSessionFile(path: string): FileFingerprint | null {
	try {
		const stats = statSync(path, { bigint: true });
		if (!stats.isFile()) return null;
		return {
			size: Number(stats.size),
			mtimeMs: Number(stats.mtimeMs),
			devIno: `${stats.dev}:${stats.ino}`,
		};
	} catch (error) {
		if (isMissingFileError(error)) return null;
		throw error;
	}
}

export function isMissingFileError(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

export interface RawLine {
	/** Byte offset of the line start. */
	start: number;
	/** Byte offset after the line, including its newline when present. */
	end: number;
	bytes: Buffer;
	/** False only for a final line with no trailing newline. */
	terminated: boolean;
}

/**
 * Read physical lines in [from, until). The final unterminated fragment is
 * returned with terminated=false so the caller can decide whether a writer is
 * still producing it.
 */
export function readLines(path: string, from: number, until: number): RawLine[] {
	const lines: RawLine[] = [];
	if (until <= from) return lines;
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
		let position = from;
		let pending: Buffer[] = [];
		let pendingStart = from;
		while (position < until) {
			const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, until - position), position);
			if (bytesRead === 0) break;
			const chunk = buffer.subarray(0, bytesRead);
			let lineStart = 0;
			let newline = chunk.indexOf(0x0a, lineStart);
			while (newline !== -1) {
				pending.push(chunk.subarray(lineStart, newline));
				const end = position + newline + 1;
				lines.push({ start: pendingStart, end, bytes: Buffer.concat(pending), terminated: true });
				pending = [];
				pendingStart = end;
				lineStart = newline + 1;
				newline = chunk.indexOf(0x0a, lineStart);
			}
			if (lineStart < chunk.length) pending.push(Buffer.from(chunk.subarray(lineStart)));
			position += bytesRead;
		}
		if (pending.length > 0) {
			const bytes = Buffer.concat(pending);
			lines.push({ start: pendingStart, end: pendingStart + bytes.length, bytes, terminated: false });
		}
	} finally {
		closeSync(fd);
	}
	return lines;
}

export function hashBytes(bytes: Buffer): string {
	return `sha1:${createHash("sha1").update(bytes).digest("hex")}`;
}

/** Hash the bytes in [start, end); null when the file is shorter than end. */
export function hashFileRange(path: string, start: number, end: number): string | null {
	const length = end - start;
	if (length < 0) return null;
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(length);
		let offset = 0;
		while (offset < length) {
			const bytesRead = readSync(fd, buffer, offset, length - offset, start + offset);
			if (bytesRead === 0) return null;
			offset += bytesRead;
		}
		return hashBytes(buffer);
	} finally {
		closeSync(fd);
	}
}

/** Parse one physical line into a JSON object, or null when it is blank or malformed. */
export function parseJsonObjectLine(bytes: Buffer): Record<string, unknown> | null {
	const text = bytes.toString("utf8");
	if (!text.trim()) return null;
	try {
		const value: unknown = JSON.parse(text);
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

export interface SessionRootScan {
	files: string[];
	/** mtime of the root and of each listed subdirectory, taken before listing it. */
	directories: Map<string, number>;
}

/**
 * Session files under one root: *.jsonl directly in the root and in its
 * immediate subdirectories (the default root keeps one directory per cwd),
 * plus the directory mtimes a later freshness check compares against.
 * A missing root yields an empty scan; other directory errors are thrown so
 * the caller does not mistake an unreadable root for deleted sessions.
 */
export function scanSessionRoot(root: string): SessionRootScan {
	const scan: SessionRootScan = { files: [], directories: new Map() };
	const rootMtime = statDirectoryMtime(root);
	if (rootMtime === null) return scan;
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch (error) {
		if (isMissingFileError(error)) return scan;
		throw error;
	}
	scan.directories.set(root, rootMtime);
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			scan.files.push(path);
		} else if (entry.isDirectory() || entry.isSymbolicLink()) {
			const mtime = statDirectoryMtime(path);
			// A symlink to a file or a vanished directory is not a session folder.
			if (mtime === null) continue;
			const children = listJsonlFiles(path);
			if (children === null) continue;
			scan.directories.set(path, mtime);
			scan.files.push(...children);
		}
	}
	return scan;
}

/** *.jsonl files directly inside one directory; null when it is missing or not a directory. */
export function listJsonlFiles(directory: string): string[] | null {
	let children: string[];
	try {
		children = readdirSync(directory);
	} catch (error) {
		if (isMissingFileError(error)) return null;
		throw error;
	}
	return children.filter((child) => child.endsWith(".jsonl")).map((child) => join(directory, child));
}

/** Immediate subdirectories of a root, following symlinks. */
export function listSubdirectories(root: string): string[] {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch (error) {
		if (isMissingFileError(error)) return [];
		throw error;
	}
	return entries
		.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
		.map((entry) => join(root, entry.name))
		.filter((path) => statDirectoryMtime(path) !== null);
}

export function statDirectoryMtime(path: string): number | null {
	try {
		const stats = statSync(path);
		return stats.isDirectory() ? stats.mtimeMs : null;
	} catch (error) {
		if (isMissingFileError(error)) return null;
		throw error;
	}
}
