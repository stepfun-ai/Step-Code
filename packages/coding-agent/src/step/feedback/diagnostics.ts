import fs from "node:fs/promises";
import path from "node:path";
import type { FeedbackDiagnostics } from "./types.ts";
import { excerptFeedbackDiagnostics } from "./validate.ts";

export interface FeedbackDiagnosticsSelection {
	diagnostics: FeedbackDiagnostics;
	displayPath: string;
}

/**
 * Bytes read from the end of the file. A byte budget rather than a line budget:
 * one 10MB line must cost the same as ten thousand short ones, so a 3KB log and
 * a 176MB log are the same amount of work.
 */
const TAIL_WINDOW_BYTES = 64 * 1024;

export async function readFeedbackDiagnostics(input: {
	storageRootDir: string;
	at?: Date;
}): Promise<FeedbackDiagnosticsSelection | undefined> {
	const root = path.resolve(input.storageRootDir);
	const trace = await newestFile(path.join(root, "diagnostics"), "input-trace-", ".jsonl");
	if (trace) {
		const diagnostics = await readDiagnosticFile(trace, "input_trace");
		if (diagnostics) return { diagnostics, displayPath: path.relative(root, trace) };
	}
	const date = input.at ?? new Date();
	const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	const log = path.join(root, "logs", `dev-${day}.log`);
	const diagnostics = await readDiagnosticFile(log, "stderr_dev_log");
	return diagnostics ? { diagnostics, displayPath: path.relative(root, log) } : undefined;
}

async function readDiagnosticFile(
	filePath: string,
	source: FeedbackDiagnostics["source"],
): Promise<FeedbackDiagnostics | undefined> {
	const tail = await readTailWindow(filePath);
	if (!tail) return undefined;
	const rawLines = tail.text.split(/\r?\n/u);
	// A trailing newline leaves an empty final element that is not a line.
	if (rawLines.at(-1) === "") rawLines.pop();
	const bounded = excerptFeedbackDiagnostics({ lines: rawLines, source, startsMidStream: tail.startsMidStream });
	if (bounded.lines.length === 0) return undefined;
	return { source, lines: bounded.lines, truncated: bounded.truncated || tail.truncated };
}

/**
 * Positional read of the last window only, so the file is never loaded whole and
 * a directory or unreadable device fails into `undefined` rather than throwing.
 */
async function readTailWindow(
	logPath: string,
): Promise<{ text: string; skippedBytes: number; startsMidStream: boolean; truncated: boolean } | undefined> {
	// Diagnostics are copied into a user-consented report. Do not follow a
	// candidate file link into an unrelated path outside the storage root.
	const linkStats = await fs.lstat(logPath).catch(() => undefined);
	if (!linkStats?.isFile()) return undefined;
	const handle = await fs.open(logPath, "r").catch(() => undefined);
	if (!handle) return undefined;
	try {
		const { size } = await handle.stat();
		if (size === 0) return undefined;
		const length = Math.min(size, TAIL_WINDOW_BYTES);
		const position = size - length;
		let startsMidStream = position > 0;
		if (startsMidStream) {
			const previousByte = Buffer.alloc(1);
			const { bytesRead } = await handle.read(previousByte, 0, 1, position - 1);
			startsMidStream = bytesRead !== 1 || previousByte[0] !== 0x0a;
		}
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, position);
		return {
			text: buffer.subarray(0, bytesRead).toString("utf8"),
			skippedBytes: position,
			startsMidStream,
			truncated: position > 0,
		};
	} catch {
		return undefined;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

async function newestFile(directory: string, prefix: string, suffix: string): Promise<string | undefined> {
	let names: string[];
	try {
		names = await fs.readdir(directory);
	} catch {
		return undefined;
	}
	let newest: { path: string; mtime: number } | undefined;
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
		const filePath = path.join(directory, name);
		const stats = await fs.lstat(filePath).catch(() => undefined);
		if (!stats?.isFile() || stats.size === 0) continue;
		if (!newest || stats.mtimeMs > newest.mtime) newest = { path: filePath, mtime: stats.mtimeMs };
	}
	return newest?.path;
}
