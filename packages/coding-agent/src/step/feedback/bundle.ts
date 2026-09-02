import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { normalizeStepWireSessionId } from "../build-identity.ts";
import { resolveStepSessionDir } from "../environment.ts";
import { createSecretRedactionCollector, redactSecretString } from "../secret-redaction.ts";
import { resolveStderrDevLogPath } from "../stderr-dev-log.ts";
import type { FeedbackBundle } from "./types.ts";
import { FEEDBACK_BUNDLE_MAX_BYTES, FEEDBACK_SESSION_RECENCY_WINDOW_MS } from "./types.ts";
import { sanitizeTerminalText } from "./validate.ts";

const gzip = promisify(zlib.gzip);

const EVENTS_ENTRY = "events.jsonl";
const MANIFEST_ENTRY = "bundle.json";
const DEV_LOG_ENTRY = "dev.log";
const EVENTS_MAX_BYTES = 24 * 1024 * 1024;
const EVENTS_FALLBACK_BYTES = 2 * 1024 * 1024;
const DEV_LOG_WINDOW_BYTES = 5 * 1024 * 1024;
const DEV_LOG_CONTEXT_LINES = 30;
const DEV_LOG_MAX_LINES = 2000;
const DEV_LOG_MAX_BYTES = 512 * 1024;
const SESSION_HEADER_READ_CHUNK_BYTES = 4 * 1024;
const SESSION_HEADER_MAX_BYTES = 1024 * 1024;

export type FeedbackBundleResult =
	| { status: "ready"; bundle: FeedbackBundle }
	| { status: "skipped"; reason: "no-session" | "empty" | "too-large" | "stale" | "unsafe" };

interface BundleEntry {
	name: string;
	content: Buffer;
	note?: string;
}

interface SelectedSession {
	filePath: string;
	sessionId: string;
}

type SessionEntryResult = { status: "ready"; entry: BundleEntry } | { status: "missing" } | { status: "unsafe" };

export async function buildFeedbackSessionBundle(input: {
	sessionFile?: string;
	sessionId?: string;
	sessionDir?: string;
	storageRootDir: string;
	env?: NodeJS.ProcessEnv;
	at?: Date;
	now?: Date;
}): Promise<FeedbackBundleResult> {
	const sessionRoot = path.resolve(input.sessionDir ?? resolveStepSessionDir(input.env));
	const guessed = !input.sessionFile && !input.sessionId;
	const selectedSession = input.sessionFile
		? await resolveExplicitSessionFile(input.sessionFile, input.sessionId)
		: input.sessionId
			? await findSessionFile(sessionRoot, input.sessionId)
			: await findNewestSessionFile(sessionRoot);
	if (!selectedSession) return { status: "skipped", reason: "no-session" };
	const { filePath: sessionFile, sessionId } = selectedSession;

	const stats = await fs.stat(sessionFile).catch(() => undefined);
	if (!stats?.isFile()) return { status: "skipped", reason: "no-session" };
	if (stats.size === 0) return { status: "skipped", reason: "empty" };
	// A guessed session is attached only when it was demonstrably just in use.
	if (guessed) {
		const now = input.now ?? input.at ?? new Date();
		if (now.getTime() - stats.mtime.getTime() >= FEEDBACK_SESSION_RECENCY_WINDOW_MS) {
			return { status: "skipped", reason: "stale" };
		}
	}

	const at = input.at ?? new Date();
	const devLog = await readDevLogErrorLines(input.storageRootDir, at);
	const eventsResult = await readSessionEntry(sessionFile, EVENTS_MAX_BYTES);
	if (eventsResult.status === "missing") return { status: "skipped", reason: "no-session" };
	if (eventsResult.status === "unsafe") return { status: "skipped", reason: "unsafe" };
	let events = eventsResult.entry;

	let archive = await compressArchive({
		at,
		sessionId,
		lastActivityAt: stats.mtime,
		entries: [events, ...(devLog ? [devLog] : [])],
	});
	if (archive.byteLength > FEEDBACK_BUNDLE_MAX_BYTES) {
		events = limitRedactedSessionEntry(events, EVENTS_FALLBACK_BYTES);
		archive = await compressArchive({
			at,
			sessionId,
			lastActivityAt: stats.mtime,
			entries: [events, ...(devLog ? [devLog] : [])],
		});
	}
	if (archive.byteLength > FEEDBACK_BUNDLE_MAX_BYTES) return { status: "skipped", reason: "too-large" };

	return {
		status: "ready",
		bundle: {
			data: archive,
			files: describeEntries([events, ...(devLog ? [devLog] : [])]),
			sessionId,
			lastActivityAt: stats.mtime,
		},
	};
}

/** File manifest shown before the user consents to sending the conversation. */
export function describeFeedbackBundle(bundle: FeedbackBundle): string {
	return [
		...bundle.files.map((file) => `${file.name} (${file.bytes} bytes)${file.note ? ` - ${file.note}` : ""}`),
		`session ${bundle.sessionId}, last active ${bundle.lastActivityAt.toISOString()}.`,
		"It contains the conversation itself: your prompts, the model's replies, tool calls and their output.",
	].join("\n");
}

async function compressArchive(input: {
	at: Date;
	sessionId: string;
	lastActivityAt: Date;
	entries: BundleEntry[];
}): Promise<Buffer> {
	const manifest = {
		sessionId: input.sessionId,
		createdAt: input.at.toISOString(),
		lastActivityAt: input.lastActivityAt.toISOString(),
		files: describeEntries(input.entries),
	};
	return gzip(
		writeTar(
			[
				...input.entries,
				{
					name: MANIFEST_ENTRY,
					content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
				},
			],
			input.at,
		),
	);
}

function describeEntries(entries: readonly BundleEntry[]): Array<{ name: string; bytes: number; note?: string }> {
	return entries.map((entry) => ({
		name: entry.name,
		bytes: entry.content.byteLength,
		...(entry.note ? { note: entry.note } : {}),
	}));
}

async function readSessionEntry(filePath: string, maxBytes: number): Promise<SessionEntryResult> {
	const entry = await readTailEntry(filePath, EVENTS_ENTRY, maxBytes);
	if (!entry) return { status: "missing" };
	try {
		const target = entry.content.toString("utf8");
		const collector = createSecretRedactionCollector(target);
		const linkStats = await fs.lstat(filePath).catch(() => undefined);
		if (!linkStats?.isFile()) return { status: "unsafe" };
		const handle = await fs.open(filePath, "r");
		try {
			const decoder = new StringDecoder("utf8");
			const chunk = Buffer.allocUnsafe(64 * 1024);
			while (true) {
				const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
				if (bytesRead === 0) break;
				collector.write(decoder.write(chunk.subarray(0, bytesRead)));
			}
			collector.write(decoder.end());
		} finally {
			await handle.close().catch(() => undefined);
		}
		const result = collector.finish();
		if (result.status === "unsafe") return { status: "unsafe" };
		const redacted = Buffer.from(result.value, "utf8");
		if (redacted.byteLength <= maxBytes) {
			return { status: "ready", entry: { ...entry, content: redacted } };
		}

		const content = tailAtLineBoundary(redacted, maxBytes);
		const redactionNote =
			content.byteLength === 0
				? `omitted after redaction, a single line exceeds ${formatBytes(maxBytes)}`
				: `tail re-limited after redaction, ${formatBytes(redacted.byteLength)} before re-limit`;
		return {
			status: "ready",
			entry: {
				...entry,
				content,
				note: entry.note ? `${entry.note}; ${redactionNote}` : redactionNote,
			},
		};
	} catch {
		return { status: "unsafe" };
	}
}

function limitRedactedSessionEntry(entry: BundleEntry, maxBytes: number): BundleEntry {
	if (entry.content.byteLength <= maxBytes) return entry;
	const content = tailAtLineBoundary(entry.content, maxBytes);
	const note =
		content.byteLength === 0
			? `omitted in compressed-size fallback, a single line exceeds ${formatBytes(maxBytes)}`
			: `compressed-size fallback limited to ${formatBytes(maxBytes)}`;
	return {
		...entry,
		content,
		note: entry.note ? `${entry.note}; ${note}` : note,
	};
}

async function readDevLogErrorLines(storageRootDir: string, at: Date): Promise<BundleEntry | undefined> {
	const entry = await readTailEntry(resolveStderrDevLogPath(storageRootDir, at), DEV_LOG_ENTRY, DEV_LOG_WINDOW_BYTES);
	if (!entry || entry.content.byteLength === 0) return undefined;

	const lines = sanitizeTerminalText(entry.content.toString("utf8")).split("\n");
	if (lines.at(-1) === "") lines.pop();
	const sanitized = lines;
	const selected = new Uint8Array(sanitized.length);
	let errorCount = 0;
	for (let index = 0; index < sanitized.length; index += 1) {
		if (!/error/iu.test(sanitized[index] ?? "")) continue;
		errorCount += 1;
		selected.fill(
			1,
			Math.max(0, index - DEV_LOG_CONTEXT_LINES),
			Math.min(sanitized.length, index + DEV_LOG_CONTEXT_LINES + 1),
		);
	}
	if (errorCount === 0) return undefined;

	const selectedCount = selected.reduce((total, value) => total + value, 0);
	const kept: string[] = [];
	let bytes = 0;
	for (let index = sanitized.length - 1; index >= 0; index -= 1) {
		if (selected[index] === 0) continue;
		const line = sanitized[index] ?? "";
		const cost = Buffer.byteLength(line, "utf8") + 1;
		if (kept.length >= DEV_LOG_MAX_LINES || bytes + cost > DEV_LOG_MAX_BYTES) break;
		bytes += cost;
		kept.push(line);
	}
	if (kept.length === 0) return undefined;

	kept.reverse();
	const redacted = Buffer.from(redactSecretString(`${kept.join("\n")}\n`), "utf8");
	const content = tailAtLineBoundary(redacted, DEV_LOG_MAX_BYTES);
	if (content.byteLength === 0) return undefined;
	const redactionLimitDropped = countLines(redacted) - countLines(content);
	const keptCount = countLines(content);
	const dropped = selectedCount - kept.length + redactionLimitDropped;
	return {
		name: DEV_LOG_ENTRY,
		content,
		note: `${keptCount} context lines around ${errorCount} error${errorCount === 1 ? "" : "s"}${
			dropped > 0 ? `, ${dropped} more lines dropped` : ""
		}${redacted.byteLength > DEV_LOG_MAX_BYTES ? ", redacted output limited to 512 KB" : ""}`,
	};
}

function tailAtLineBoundary(content: Buffer, maxBytes: number): Buffer {
	if (content.byteLength <= maxBytes) return content;
	const window = content.subarray(content.byteLength - maxBytes);
	const firstNewline = window.indexOf(0x0a);
	return firstNewline === -1 ? Buffer.alloc(0) : window.subarray(firstNewline + 1);
}

function countLines(content: Buffer): number {
	if (content.byteLength === 0) return 0;
	let lines = 0;
	for (const byte of content) {
		if (byte === 0x0a) lines += 1;
	}
	return content.at(-1) === 0x0a ? lines : lines + 1;
}

async function readTailEntry(filePath: string, name: string, maxBytes: number): Promise<BundleEntry | undefined> {
	const linkStats = await fs.lstat(filePath).catch(() => undefined);
	if (!linkStats?.isFile()) return undefined;
	const handle = await fs.open(filePath, "r").catch(() => undefined);
	if (!handle) return undefined;
	try {
		const { size } = await handle.stat();
		if (size === 0) return undefined;
		const length = Math.min(size, maxBytes);
		const position = size - length;
		let startsMidLine = position > 0;
		if (startsMidLine) {
			const previousByte = Buffer.alloc(1);
			const { bytesRead } = await handle.read(previousByte, 0, 1, position - 1);
			startsMidLine = bytesRead !== 1 || previousByte[0] !== 0x0a;
		}
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, position);
		let content = buffer.subarray(0, bytesRead);
		if (position === 0) return { name, content };
		if (!startsMidLine) return { name, content, note: `tail only, ${formatBytes(size)} on disk` };
		const firstNewline = content.indexOf(0x0a);
		if (firstNewline === -1) {
			return { name, content: Buffer.alloc(0), note: `omitted, a single line exceeds ${formatBytes(maxBytes)}` };
		}
		content = content.subarray(firstNewline + 1);
		return { name, content, note: `tail only, ${formatBytes(size)} on disk` };
	} catch {
		return undefined;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function resolveExplicitSessionFile(
	filePath: string,
	fallbackSessionId?: string,
): Promise<SelectedSession | undefined> {
	const resolved = await validateSessionFile(filePath);
	if (!resolved) return undefined;
	const sessionId =
		(await readSessionHeaderId(resolved)) ?? safeSessionId(fallbackSessionId) ?? extractSessionId(resolved);
	return sessionId ? { filePath: resolved, sessionId } : undefined;
}

async function findSessionFile(storageRootDir: string, sessionId: string): Promise<SelectedSession | undefined> {
	if (path.isAbsolute(sessionId) || sessionId.endsWith(".jsonl")) {
		return resolveExplicitSessionFile(sessionId);
	}
	if (!safeSessionId(sessionId)) return undefined;
	const files = await collectJsonlFiles(storageRootDir);
	let match: SelectedSession | undefined;
	for (const filePath of files) {
		const headerSessionId = await readSessionHeaderId(filePath);
		if (headerSessionId !== sessionId) continue;
		if (match) return undefined;
		match = { filePath, sessionId: headerSessionId };
	}
	return match;
}

async function findNewestSessionFile(storageRootDir: string): Promise<SelectedSession | undefined> {
	const files = await collectJsonlFiles(storageRootDir);
	let newest: { session: SelectedSession; mtime: number } | undefined;
	for (const filePath of files) {
		const stats = await fs.stat(filePath).catch(() => undefined);
		if (!stats?.isFile() || (newest && stats.mtimeMs <= newest.mtime)) continue;
		const sessionId = await readSessionHeaderId(filePath);
		if (sessionId) newest = { session: { filePath, sessionId }, mtime: stats.mtimeMs };
	}
	return newest?.session;
}

async function validateSessionFile(filePath: string): Promise<string | undefined> {
	if (!filePath.endsWith(".jsonl")) return undefined;
	const resolved = path.resolve(filePath);
	const stats = await fs.lstat(resolved).catch(() => undefined);
	return stats?.isFile() ? resolved : undefined;
}

async function readSessionHeaderId(filePath: string): Promise<string | undefined> {
	const handle = await fs.open(filePath, "r").catch(() => undefined);
	if (!handle) return undefined;
	try {
		const lineChunks: Buffer[] = [];
		let scannedBytes = 0;
		while (scannedBytes <= SESSION_HEADER_MAX_BYTES) {
			const readLength = Math.min(SESSION_HEADER_READ_CHUNK_BYTES, SESSION_HEADER_MAX_BYTES + 1 - scannedBytes);
			const buffer = Buffer.allocUnsafe(readLength);
			const { bytesRead } = await handle.read(buffer, 0, readLength, scannedBytes);
			if (bytesRead === 0) break;
			scannedBytes += bytesRead;

			const chunk = buffer.subarray(0, bytesRead);
			let lineStart = 0;
			let newlineIndex = chunk.indexOf(0x0a, lineStart);
			while (newlineIndex !== -1) {
				lineChunks.push(chunk.subarray(lineStart, newlineIndex));
				const sessionId = parseSessionHeaderCandidate(Buffer.concat(lineChunks).toString("utf8"));
				if (sessionId !== undefined) return sessionId ?? undefined;
				lineChunks.length = 0;
				lineStart = newlineIndex + 1;
				newlineIndex = chunk.indexOf(0x0a, lineStart);
			}
			lineChunks.push(chunk.subarray(lineStart));
		}
		if (scannedBytes > SESSION_HEADER_MAX_BYTES) return undefined;
		return parseSessionHeaderCandidate(Buffer.concat(lineChunks).toString("utf8")) ?? undefined;
	} catch {
		return undefined;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

function parseSessionHeaderCandidate(line: string): string | null | undefined {
	if (!line.trim()) return undefined;
	try {
		const header: unknown = JSON.parse(line);
		if (typeof header !== "object" || header === null || Array.isArray(header)) return null;
		const record = header as Record<string, unknown>;
		return record.type === "session" ? (safeSessionId(record.id) ?? null) : null;
	} catch {
		return undefined;
	}
}

function extractSessionId(filePath: string): string | undefined {
	const stem = path.basename(filePath).replace(/\.jsonl$/u, "");
	const separator = stem.indexOf("_");
	return normalizeLocalSessionId(separator >= 0 ? stem.slice(separator + 1) : stem);
}

function safeSessionId(value: unknown): string | undefined {
	const normalized = normalizeStepWireSessionId(value);
	if (!normalized) return undefined;
	// Wire ids may contain benign legacy separators (for example
	// `team/agent one`), but a header must not be able to smuggle a path
	// traversal-looking identity into the manifest.
	if (/(?:^|[\\/])(?:\.{1,2})(?:$|[\\/])/u.test(normalized)) return undefined;
	if (/^(?:[A-Za-z]:[\\/]|[\\/])/u.test(normalized)) return undefined;
	return normalized;
}

/**
 * A filename-derived id has a narrower contract than a wire id.  The latter
 * may contain legacy path-like punctuation, but accepting that punctuation
 * from a basename would make the bundle manifest disagree with the local
 * session identity (and could produce path-looking metadata).
 */
function normalizeLocalSessionId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(trimmed) ? trimmed : undefined;
}

async function collectJsonlFiles(directory: string): Promise<string[]> {
	const found: string[] = [];
	const walk = async (current: string): Promise<void> => {
		const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const filePath = path.join(current, entry.name);
			if (entry.isDirectory()) await walk(filePath);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(filePath);
		}
	};
	await walk(directory);
	return found;
}

function writeTar(entries: readonly BundleEntry[], at: Date): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const header = Buffer.alloc(512);
		writeString(header, 0, 100, entry.name);
		writeOctal(header, 100, 8, 0o600);
		writeOctal(header, 108, 8, 0);
		writeOctal(header, 116, 8, 0);
		writeOctal(header, 124, 12, entry.content.byteLength);
		writeOctal(header, 136, 12, Math.floor(at.getTime() / 1000));
		header.fill(0x20, 148, 156);
		header[156] = 0x30;
		writeString(header, 257, 6, "ustar\0");
		writeString(header, 263, 2, "00");
		let checksum = 0;
		for (const byte of header) checksum += byte;
		writeOctal(header, 148, 8, checksum);
		blocks.push(header, entry.content);
		const padding = (512 - (entry.content.byteLength % 512)) % 512;
		if (padding) blocks.push(Buffer.alloc(padding));
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.concat(blocks);
}

function writeString(target: Buffer, offset: number, length: number, value: string): void {
	Buffer.from(value, "utf8").copy(target, offset, 0, length);
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
	const text = `${value.toString(8)}\0`.padStart(length, "0");
	writeString(target, offset, length, text.slice(-length));
}
