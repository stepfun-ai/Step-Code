import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { normalizeStepWireSessionId } from "../build-identity.ts";
import { resolveStepSessionDir } from "../environment.ts";
import { createSecretRedactionCollector, redactSecretString } from "../secret-redaction.ts";
import { resolveStderrDevLogPath } from "../stderr-dev-log.ts";
import { collapseHomePaths } from "./redact-home.ts";
import { annotateTranscriptRows } from "./row-metrics.ts";
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
/** Full tool output a tool call referenced: these are the files the model was shown a preview of. */
const TOOL_OUTPUT_DIR = "tool-output";
const TOOL_OUTPUT_NAME = /^tool-[0-9a-f]{32}\.txt$/u;
const TOOL_OUTPUT_MAX_FILES = 10;
const TOOL_OUTPUT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const TOOL_OUTPUT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export type FeedbackBundleResult =
	| { status: "ready"; bundle: FeedbackBundle }
	| { status: "skipped"; reason: "no-session" | "empty" | "too-large" | "stale" | "unsafe" };

interface BundleEntry {
	name: string;
	content: Buffer;
	note?: string;
}

export interface SelectedSession {
	filePath: string;
	sessionId: string;
}

type SessionEntryResult =
	| { status: "ready"; entry: BundleEntry; text: string }
	| { status: "missing" }
	| { status: "unsafe" };

/**
 * The session a report is about, as a file on disk.
 *
 * Exported so the summary and the bundle resolve the same session: two
 * independent guesses could describe one conversation and attach another.
 */
export async function resolveFeedbackSession(input: {
	sessionFile?: string;
	sessionId?: string;
	sessionDir?: string;
	env?: NodeJS.ProcessEnv;
	/** Project the user is filing from; a guess never leaves this folder. */
	cwd?: string;
}): Promise<SelectedSession | undefined> {
	if (input.sessionFile) return resolveExplicitSessionFile(input.sessionFile, input.sessionId);
	const sessionRoot = path.resolve(input.sessionDir ?? resolveStepSessionDir(input.env));
	if (input.sessionId) return findSessionFile(sessionRoot, input.sessionId);
	return findNewestSessionFile(sessionRoot, input.cwd ?? process.cwd());
}

export async function buildFeedbackSessionBundle(input: {
	sessionFile?: string;
	sessionId?: string;
	sessionDir?: string;
	storageRootDir: string;
	env?: NodeJS.ProcessEnv;
	at?: Date;
	now?: Date;
	/** Project the report is filed from; a guessed session never leaves it. */
	cwd?: string;
	/**
	 * The caller resolved the session itself because the user named none. The
	 * recency rule still applies: a conversation nobody used recently is not
	 * what the report is about, and attaching the wrong one is a privacy
	 * incident rather than a degraded report.
	 */
	guessedSession?: boolean;
}): Promise<FeedbackBundleResult> {
	const guessed = input.guessedSession ?? (!input.sessionFile && !input.sessionId);
	const selectedSession = await resolveFeedbackSession(input);
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
	// A tool call's full output is the one thing the model itself only saw a
	// preview of, and the preview names a path that does not exist on the
	// receiver's machine. Attach the files this session referenced.
	let toolOutputs = await readToolOutputEntries(sessionFile, eventsResult.text);

	const entries = (): BundleEntry[] => [events, ...toolOutputs, ...(devLog ? [devLog] : [])];
	let archive = await compressArchive({
		at,
		sessionId,
		lastActivityAt: stats.mtime,
		entries: entries(),
	});
	if (archive.byteLength > FEEDBACK_BUNDLE_MAX_BYTES) {
		events = limitRedactedSessionEntry(events, EVENTS_FALLBACK_BYTES);
		toolOutputs = toolOutputs.slice(0, 3).map((entry) => limitRedactedSessionEntry(entry, 512 * 1024));
		archive = await compressArchive({
			at,
			sessionId,
			lastActivityAt: stats.mtime,
			entries: entries(),
		});
	}
	if (archive.byteLength > FEEDBACK_BUNDLE_MAX_BYTES) return { status: "skipped", reason: "too-large" };

	return {
		status: "ready",
		bundle: {
			data: archive,
			files: describeEntries(entries()),
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
		"It contains the conversation itself: your prompts, the model's replies, tool calls and their output,",
		"the full output files those calls referenced, and the tail of the host log. Credentials are removed",
		"and your home directory is written as ~.",
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
	const linkStats = await fs.lstat(filePath).catch(() => undefined);
	if (!linkStats?.isFile()) return { status: "unsafe" };
	const handle = await fs.open(filePath, "r").catch(() => undefined);
	if (!handle) return { status: "unsafe" };
	try {
		const { size } = await handle.stat();
		if (size === 0) return { status: "missing" };
		// The archived excerpt is read first and becomes the redaction target: the
		// collector rewrites exactly this text, so a target smaller than the file
		// would silently drop the rest of the conversation.
		const excerpt =
			size <= maxBytes ? await readBytes(handle, 0, size) : await readHeadTailBytes(handle, size, maxBytes);
		if (excerpt.byteLength === 0) return { status: "missing" };
		const collector = createSecretRedactionCollector(excerpt.toString("utf8"));
		// The whole file is still scanned, so a credential written once early and
		// echoed later in the excerpt is recognised in both places.
		const decoder = new StringDecoder("utf8");
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let position = 0;
		while (position < size) {
			const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.byteLength, size - position), position);
			if (bytesRead === 0) break;
			position += bytesRead;
			collector.write(decoder.write(chunk.subarray(0, bytesRead)));
		}
		collector.write(decoder.end());
		const result = collector.finish();
		if (result.status === "unsafe") return { status: "unsafe" };
		const text = collapseHomePaths(result.value);
		const redacted = Buffer.from(text, "utf8");
		const bounded =
			redacted.byteLength <= maxBytes ? redacted : headAndTailAtLineBoundary(redacted, maxBytes).content;
		// Every row keeps the plain transcript it had, plus a `feedback` object
		// with that row's own usage, cache hit rate, and timing. Only this copy is
		// annotated; the session file on disk is never rewritten.
		const annotated = Buffer.from(annotateTranscriptRows(bounded.toString("utf8")), "utf8");
		const content =
			annotated.byteLength <= maxBytes ? annotated : headAndTailAtLineBoundary(annotated, maxBytes).content;
		if (content.byteLength === 0) {
			return {
				status: "ready",
				text,
				entry: {
					name: EVENTS_ENTRY,
					content,
					note: `omitted after redaction, a single line exceeds ${formatBytes(maxBytes)}`,
				},
			};
		}
		const trimmed = redacted.byteLength > maxBytes;
		const annotatedTrimmed = annotated.byteLength > maxBytes;
		const note = trimmed
			? `head and tail of ${formatBytes(size)}, re-limited after redaction`
			: annotatedTrimmed
				? `head and tail of ${formatBytes(size)}, re-limited after per-row metrics`
				: size > maxBytes
					? `head and tail of ${formatBytes(size)}`
					: undefined;
		return {
			status: "ready",
			text,
			entry: { name: EVENTS_ENTRY, content, ...(note ? { note } : {}) },
		};
	} catch {
		return { status: "unsafe" };
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function readBytes(
	handle: Awaited<ReturnType<typeof fs.open>>,
	position: number,
	length: number,
): Promise<Buffer> {
	const buffer = Buffer.alloc(length);
	const { bytesRead } = await handle.read(buffer, 0, length, position);
	return buffer.subarray(0, bytesRead);
}

/**
 * Both ends of an oversized file, cut at line boundaries on each inner edge and
 * separated by a marker: a reader must be able to tell that the middle is
 * missing rather than assume the conversation skipped a turn.
 */
async function readHeadTailBytes(
	handle: Awaited<ReturnType<typeof fs.open>>,
	size: number,
	maxBytes: number,
): Promise<Buffer> {
	const marker = Buffer.from(`\n… [middle of this session omitted, ${formatBytes(size)} on disk] …\n`, "utf8");
	const budget = Math.max(0, maxBytes - marker.byteLength);
	const headBudget = Math.floor(budget / 2);
	const head = await readBytes(handle, 0, headBudget);
	const headEnd = head.lastIndexOf(0x0a);
	const tailBudget = budget - headBudget;
	const tail = await readBytes(handle, size - tailBudget, tailBudget);
	const tailStart = tail.indexOf(0x0a);
	const headPart = headEnd <= 0 ? Buffer.alloc(0) : head.subarray(0, headEnd + 1);
	const tailPart = tailStart === -1 ? Buffer.alloc(0) : tail.subarray(tailStart + 1);
	// The marker only makes sense between two kept parts.
	if (headPart.byteLength === 0 || tailPart.byteLength === 0) return Buffer.concat([headPart, tailPart]);
	return Buffer.concat([headPart, marker, tailPart]);
}

/**
 * Attach the full output of tool calls the transcript referenced.
 *
 * Only names are taken from the transcript, and they are resolved inside this
 * session's own `tool-output` directory: a transcript is untrusted input, so it
 * must not be able to name an arbitrary file.
 */
async function readToolOutputEntries(sessionFile: string, transcript: string): Promise<BundleEntry[]> {
	const names = new Set<string>();
	for (const match of transcript.matchAll(/tool-[0-9a-f]{32}\.txt/gu)) names.add(match[0]);
	if (names.size === 0) return [];
	const directory = path.join(path.dirname(path.resolve(sessionFile)), TOOL_OUTPUT_DIR);
	const entries: BundleEntry[] = [];
	let total = 0;
	for (const name of [...names].slice(0, TOOL_OUTPUT_MAX_FILES)) {
		if (!TOOL_OUTPUT_NAME.test(name)) continue;
		const filePath = path.join(directory, name);
		const stats = await fs.lstat(filePath).catch(() => undefined);
		if (!stats?.isFile() || stats.size === 0) continue;
		if (total + Math.min(stats.size, TOOL_OUTPUT_MAX_FILE_BYTES) > TOOL_OUTPUT_MAX_TOTAL_BYTES) break;
		const read = await readHeadEntry(filePath, `${TOOL_OUTPUT_DIR}/${name}`, TOOL_OUTPUT_MAX_FILE_BYTES);
		if (!read) continue;
		const redacted = Buffer.from(collapseHomePaths(redactSecretString(read.content.toString("utf8"))), "utf8");
		const bounded = limitRedactedSessionEntry({ ...read, content: redacted }, TOOL_OUTPUT_MAX_FILE_BYTES);
		total += bounded.content.byteLength;
		const complete = stats.size <= TOOL_OUTPUT_MAX_FILE_BYTES;
		entries.push({
			...bounded,
			note: `${bounded.note ? `${bounded.note}; ` : ""}${complete ? "full tool output" : "tool output, head only"}`,
		});
	}
	return entries;
}

function limitRedactedSessionEntry(entry: BundleEntry, maxBytes: number): BundleEntry {
	if (entry.content.byteLength <= maxBytes) return entry;
	const content = headAndTailAtLineBoundary(entry.content, maxBytes).content;
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
	// The dev log is raw host stderr and routinely names absolute paths; the
	// consent text promises the home directory is collapsed in every attachment.
	const redacted = Buffer.from(collapseHomePaths(redactSecretString(`${kept.join("\n")}\n`)), "utf8");
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

/** Keep both ends of an oversized file; the middle is the part a reader can infer is missing. */
function headAndTailAtLineBoundary(content: Buffer, maxBytes: number): { content: Buffer } {
	if (content.byteLength <= maxBytes) return { content };
	const marker = Buffer.from("\n… [middle of this file omitted] …\n", "utf8");
	const budget = Math.max(0, maxBytes - marker.byteLength);
	const headWindow = content.subarray(0, Math.floor(budget / 2));
	const headEnd = headWindow.lastIndexOf(0x0a);
	const head = headEnd <= 0 ? Buffer.alloc(0) : headWindow.subarray(0, headEnd + 1);
	const tailBudget = Math.max(0, budget - head.byteLength);
	const tailWindow = content.subarray(content.byteLength - tailBudget);
	const tailStart = tailWindow.indexOf(0x0a);
	const tail = tailStart === -1 ? Buffer.alloc(0) : tailWindow.subarray(tailStart + 1);
	const combined = Buffer.concat([head, marker, tail]);
	return { content: combined.byteLength <= maxBytes ? combined : combined.subarray(0, maxBytes) };
}

async function readHeadEntry(filePath: string, name: string, maxBytes = 64 * 1024): Promise<BundleEntry | undefined> {
	const linkStats = await fs.lstat(filePath).catch(() => undefined);
	if (!linkStats?.isFile()) return undefined;
	const handle = await fs.open(filePath, "r").catch(() => undefined);
	if (!handle) return undefined;
	try {
		const { size } = await handle.stat();
		if (size === 0) return undefined;
		const length = Math.min(size, maxBytes);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, 0);
		const read = buffer.subarray(0, bytesRead);
		// A truncated read must not end mid-record, so prefer whole lines. A file
		// that is one long line has none to cut at; keep the window, which is all
		// a caller can use anyway (the session scan re-reads the file itself).
		const lastNewline = read.lastIndexOf(0x0a);
		const content = bytesRead < size && lastNewline > 0 ? read.subarray(0, lastNewline + 1) : read;
		if (content.byteLength === 0) return undefined;
		return { name, content };
	} catch {
		return undefined;
	} finally {
		await handle.close().catch(() => undefined);
	}
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

/**
 * The newest session **of the project the user is in**.
 *
 * Walking every project directory and taking the newest file would attach a
 * conversation from another project — possibly one they are not thinking
 * about — as the context of this report. A guess therefore stays inside this
 * cwd's own session folder; an explicit `--session` is the only way out.
 *
 * Two layouts exist: the manager's per-project folders, and a flat directory
 * (an explicit `--session-dir` or a test fixture). A flat directory is only
 * guessed from when it has no project folders at all, so an ordinary install
 * can never pick another project's conversation.
 */
async function findNewestSessionFile(storageRootDir: string, cwd: string): Promise<SelectedSession | undefined> {
	const projectDir = path.join(storageRootDir, sessionFolderName(cwd));
	const hasProjectDir = await isDirectory(projectDir);
	if (!hasProjectDir && (await hasProjectFolders(storageRootDir))) return undefined;
	const files = await collectJsonlFiles(hasProjectDir ? projectDir : storageRootDir);
	let newest: { session: SelectedSession; mtime: number } | undefined;
	for (const filePath of files) {
		const stats = await fs.stat(filePath).catch(() => undefined);
		if (!stats?.isFile() || (newest && stats.mtimeMs <= newest.mtime)) continue;
		const sessionId = await readSessionHeaderId(filePath);
		if (sessionId) newest = { session: { filePath, sessionId }, mtime: stats.mtimeMs };
	}
	return newest?.session;
}

async function isDirectory(target: string): Promise<boolean> {
	const stats = await fs.stat(target).catch(() => undefined);
	return stats?.isDirectory() === true;
}

/** Any `--project--` folder means the sessions are partitioned; do not cross them. */
async function hasProjectFolders(storageRootDir: string): Promise<boolean> {
	const names = await fs.readdir(storageRootDir).catch(() => [] as string[]);
	return names.some((name) => name.startsWith("--") && name.endsWith("--"));
}

/** Session folders are named after the project path, mirroring the manager. */
function sessionFolderName(cwd: string): string {
	const resolved = path.resolve(cwd);
	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/gu, "-")}--`;
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
