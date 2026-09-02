import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { normalizeStepDeviceId, normalizeStepUid, normalizeStepWireSessionId } from "../build-identity.ts";
import { redactSecretString } from "../secret-redaction.ts";
import {
	FEEDBACK_BUNDLE_MAX_BYTES,
	FEEDBACK_CATEGORIES,
	FEEDBACK_COMMENT_MAX_RUNES,
	FEEDBACK_DIAGNOSTICS_MAX_BYTES,
	FEEDBACK_DIAGNOSTICS_MAX_LINE_CHARS,
	FEEDBACK_DIAGNOSTICS_MAX_LINES,
	type FeedbackSubmission,
} from "./types.ts";
import { redactFeedbackDiagnostics } from "./validate.ts";

const gzip = promisify(zlib.gzip);

const PENDING_DIR = "feedback";
const BODY_SUFFIX = ".json";
const BUNDLE_SUFFIX = ".tar.gz";
// UUID v7 is now emitted by some hosts. Keep the canonical group/variant
// boundary while accepting every version nibble rather than rejecting a
// perfectly valid newer id.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PENDING_BODY_MAX_BYTES = 1 * 1024 * 1024;
const MAX_CONTEXT_VALUE_LENGTH = 256;
const MAX_AT_LENGTH = 64;
const MAX_DIAGNOSTIC_SOURCE_LENGTH = 32;
const MAX_DIAGNOSTIC_LINE_BYTES = 16 * 1024;
const MAX_MANIFEST_NOTE_LENGTH = 1024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const TAR_BLOCK_BYTES = 512;
const TAR_MAX_BYTES = 48 * 1024 * 1024;
const LEGACY_SESSION_ENTRY = "session.jsonl";
const LEGACY_MANIFEST_ENTRY = "manifest.json";
const BUNDLE_MANIFEST_ENTRY = "bundle.json";
const BUNDLE_ENTRY_LIMITS: Readonly<Record<string, number>> = {
	[BUNDLE_MANIFEST_ENTRY]: 1024 * 1024,
	"session.json": 8 * 1024 * 1024,
	"events.jsonl": 24 * 1024 * 1024,
	"resume.json": 8 * 1024 * 1024,
	"dev.log": 512 * 1024,
};

export interface PendingFeedbackEntry {
	feedbackId: string;
	body?: { path: string; submission: FeedbackSubmission };
	/** A body-shaped file that failed strict validation. It is exposed only
	 * when paired with a bundle so retry cannot accidentally upload the bundle
	 * without the report it belongs to. Standalone invalid bodies remain hidden
	 * from the retry listing for backward-compatible discovery semantics. */
	bodyInvalidPath?: string;
	bundlePath?: string;
}

export function resolveFeedbackDirectory(storageRootDir: string): string {
	return path.join(path.resolve(storageRootDir), PENDING_DIR);
}

export function resolveFeedbackPendingPath(storageRootDir: string, feedbackId: string): string {
	return resolveSibling(storageRootDir, feedbackId, BODY_SUFFIX);
}

export function resolveFeedbackPendingBundlePath(storageRootDir: string, feedbackId: string): string {
	return resolveSibling(storageRootDir, feedbackId, BUNDLE_SUFFIX);
}

function resolveSibling(storageRootDir: string, feedbackId: string, suffix: string): string {
	if (!UUID.test(feedbackId)) throw new Error("feedback pending path requires a UUID feedbackId");
	return path.join(resolveFeedbackDirectory(storageRootDir), `pending-${feedbackId}${suffix}`);
}

export async function writePendingFeedback(input: {
	storageRootDir: string;
	submission: FeedbackSubmission;
}): Promise<string> {
	const target = resolveFeedbackPendingPath(input.storageRootDir, input.submission.feedbackId);
	await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	await rejectSymbolicLink(target);
	await fs.writeFile(target, `${JSON.stringify(input.submission, null, 2)}\n`, { mode: 0o600 });
	await fs.chmod(target, 0o600).catch(() => undefined);
	return target;
}

export async function writePendingFeedbackBundle(input: {
	storageRootDir: string;
	feedbackId: string;
	data: Uint8Array;
}): Promise<string> {
	const target = resolveFeedbackPendingBundlePath(input.storageRootDir, input.feedbackId);
	await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
	await rejectSymbolicLink(target);
	await fs.writeFile(target, input.data, { mode: 0o600 });
	await fs.chmod(target, 0o600).catch(() => undefined);
	return target;
}

export type PendingFeedbackBundleReadResult =
	| { status: "ready"; data: Buffer }
	| { status: "too-large" }
	| { status: "unreadable" };

/** Reads a pending archive while preserving the reason a local read failed. */
export async function readPendingFeedbackBundleResult(bundlePath: string): Promise<PendingFeedbackBundleReadResult> {
	try {
		const info = await fs.lstat(bundlePath);
		if (!info.isFile()) return { status: "unreadable" };
		if (info.size > FEEDBACK_BUNDLE_MAX_BYTES) return { status: "too-large" };
		const data = await fs.readFile(bundlePath);
		return data.byteLength <= FEEDBACK_BUNDLE_MAX_BYTES ? { status: "ready", data } : { status: "too-large" };
	} catch {
		return { status: "unreadable" };
	}
}

export async function readPendingFeedbackBundle(bundlePath: string): Promise<Buffer | undefined> {
	const result = await readPendingFeedbackBundleResult(bundlePath);
	return result.status === "ready" ? result.data : undefined;
}

/**
 * Accepts current collector-compatible bundles unchanged and upgrades only the
 * exact legacy harness shape. Invalid or unfamiliar archives are never uploaded.
 */
export async function normalizePendingFeedbackBundle(data: Buffer): Promise<Buffer | undefined> {
	if (data.byteLength === 0 || data.byteLength > FEEDBACK_BUNDLE_MAX_BYTES) return undefined;
	const tar = await decompressSingleGzipMember(data);
	if (!tar) return undefined;
	const entries = readTarEntries(tar);
	if (!entries) return undefined;

	const names = new Set(entries.map((entry) => entry.name));
	if (names.has(BUNDLE_MANIFEST_ENTRY)) {
		if (entries.some((entry) => BUNDLE_ENTRY_LIMITS[entry.name] === undefined)) return undefined;
		const manifest = entries.find((entry) => entry.name === BUNDLE_MANIFEST_ENTRY);
		const createdAt = manifest ? validCurrentBundleManifest(manifest.content, entries) : undefined;
		if (!createdAt) return undefined;
		const canonicalTar = writeTar(entries, new Date(createdAt));
		if (!canonicalTar.equals(tar)) return undefined;
		return data;
	}
	if (entries.length !== 2 || !names.has(LEGACY_SESSION_ENTRY) || !names.has(LEGACY_MANIFEST_ENTRY)) {
		return undefined;
	}

	const session = entries.find((entry) => entry.name === LEGACY_SESSION_ENTRY);
	const legacyManifest = entries.find((entry) => entry.name === LEGACY_MANIFEST_ENTRY);
	if (!session || !legacyManifest || session.content.byteLength > BUNDLE_ENTRY_LIMITS["events.jsonl"]!) {
		return undefined;
	}
	const manifest = parseLegacyManifest(legacyManifest.content, session.content.byteLength);
	if (!manifest) return undefined;
	if (!writeTar(entries, new Date(manifest.createdAt)).equals(tar)) return undefined;
	const files = [
		{
			name: "events.jsonl",
			bytes: session.content.byteLength,
			...(manifest.note ? { note: manifest.note } : {}),
		},
	];
	const bundleManifest = {
		sessionId: manifest.sessionId,
		createdAt: manifest.createdAt,
		lastActivityAt: manifest.lastActivityAt,
		files,
	};
	const migrated = await gzip(
		writeTar(
			[
				{ name: "events.jsonl", content: session.content },
				{
					name: BUNDLE_MANIFEST_ENTRY,
					content: Buffer.from(`${JSON.stringify(bundleManifest, null, 2)}\n`, "utf8"),
				},
			],
			new Date(manifest.createdAt),
		),
	);
	return migrated.byteLength <= FEEDBACK_BUNDLE_MAX_BYTES ? migrated : undefined;
}

export async function removePendingFeedback(filePath: string): Promise<void> {
	await fs.unlink(filePath).catch((error: unknown) => {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	});
}

export async function listPendingFeedback(storageRootDir: string): Promise<PendingFeedbackEntry[]> {
	const directory = resolveFeedbackDirectory(storageRootDir);
	const names = await fs.readdir(directory).catch(() => [] as string[]);
	const slots = new Map<string, { body?: string; bundlePath?: string }>();
	for (const name of names.sort()) {
		const parsed = parsePendingName(name);
		if (!parsed) continue;
		const slot = slots.get(parsed.feedbackId) ?? {};
		slot[parsed.kind] = path.join(directory, name);
		slots.set(parsed.feedbackId, slot);
	}

	const entries: PendingFeedbackEntry[] = [];
	for (const [feedbackId, slot] of slots) {
		const submissionResult = slot.body ? await readSubmission(slot.body, feedbackId) : undefined;
		if (!submissionResult && !slot.bundlePath) continue;
		entries.push({
			feedbackId,
			...(submissionResult?.submission && slot.body
				? { body: { path: slot.body, submission: submissionResult.submission } }
				: {}),
			...(submissionResult?.submission || !slot.body ? {} : { bodyInvalidPath: slot.body }),
			...(slot.bundlePath ? { bundlePath: slot.bundlePath } : {}),
		});
	}
	return entries;
}

function parsePendingName(name: string): { feedbackId: string; kind: "body" | "bundlePath" } | undefined {
	if (!name.startsWith("pending-")) return undefined;
	const body = name.endsWith(BODY_SUFFIX);
	const suffix = body ? BODY_SUFFIX : BUNDLE_SUFFIX;
	if (!name.endsWith(suffix)) return undefined;
	const feedbackId = name.slice("pending-".length, -suffix.length);
	return UUID.test(feedbackId) ? { feedbackId, kind: body ? "body" : "bundlePath" } : undefined;
}

async function readSubmission(
	filePath: string,
	expectedFeedbackId: string,
): Promise<{ submission: FeedbackSubmission } | undefined> {
	try {
		const info = await fs.lstat(filePath);
		if (!info.isFile() || info.size > PENDING_BODY_MAX_BYTES) return undefined;
		const raw = await fs.readFile(filePath);
		if (raw.byteLength > PENDING_BODY_MAX_BYTES) return undefined;
		const value: unknown = JSON.parse(raw.toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const submission = value as Record<string, unknown>;
		if (
			Object.keys(submission).some(
				(key) => !["feedbackId", "category", "comment", "at", "context", "diagnostics"].includes(key),
			)
		) {
			return undefined;
		}
		if (
			typeof submission.feedbackId !== "string" ||
			!UUID.test(submission.feedbackId) ||
			submission.feedbackId !== expectedFeedbackId ||
			(submission.category !== undefined &&
				(typeof submission.category !== "string" ||
					!FEEDBACK_CATEGORIES.some((category) => category === submission.category))) ||
			typeof submission.comment !== "string" ||
			submission.comment !== submission.comment.trim() ||
			[...submission.comment].length > FEEDBACK_COMMENT_MAX_RUNES ||
			redactSecretString(submission.comment) !== submission.comment ||
			typeof submission.at !== "string" ||
			submission.at.length > MAX_AT_LENGTH ||
			CONTROL_CHARACTERS.test(submission.at) ||
			!Number.isFinite(Date.parse(submission.at)) ||
			!isStrictContext(submission.context) ||
			!isStrictDiagnostics(submission.diagnostics)
		) {
			return undefined;
		}
		return { submission: value as FeedbackSubmission };
	} catch {
		return undefined;
	}
}

async function rejectSymbolicLink(filePath: string): Promise<void> {
	const stats = await fs.lstat(filePath).catch(() => undefined);
	if (stats?.isSymbolicLink()) throw new Error("refusing to write through a symbolic link");
}

function isStrictContext(value: unknown): value is FeedbackSubmission["context"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const context = value as Record<string, unknown>;
	const allowed = new Set(["channel", "version", "platform", "commit", "sessionId", "deviceId", "uid", "username"]);
	if (Object.keys(context).some((key) => !allowed.has(key))) return false;
	for (const key of ["channel", "version", "platform"] as const) {
		const field = context[key];
		if (!isSafeContextString(field, MAX_CONTEXT_VALUE_LENGTH)) return false;
	}
	if (context.commit !== undefined && normalizeStepCommitForPending(context.commit) !== context.commit) return false;
	if (context.deviceId !== undefined && normalizeStepDeviceId(context.deviceId) !== context.deviceId) return false;
	if (context.sessionId !== undefined && normalizeStepWireSessionId(context.sessionId) !== context.sessionId)
		return false;
	if (context.uid !== undefined && normalizeStepUid(context.uid) !== context.uid) return false;
	if (context.username !== undefined && !isSafeContextString(context.username, MAX_CONTEXT_VALUE_LENGTH)) return false;
	return true;
}

function normalizeStepCommitForPending(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed &&
		trimmed.length <= 40 &&
		!CONTROL_CHARACTERS.test(trimmed) &&
		redactSecretString(trimmed) === trimmed
		? trimmed
		: undefined;
}

function isSafeContextString(value: unknown, maxLength: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maxLength &&
		value === value.trim() &&
		!CONTROL_CHARACTERS.test(value) &&
		redactSecretString(value) === value
	);
}

function isStrictDiagnostics(value: unknown): value is NonNullable<FeedbackSubmission["diagnostics"]> | undefined {
	if (value === undefined) return true;
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const diagnostics = value as Record<string, unknown>;
	if (Object.keys(diagnostics).some((key) => !["source", "lines", "truncated"].includes(key))) return false;
	if (
		typeof diagnostics.source !== "string" ||
		diagnostics.source.length > MAX_DIAGNOSTIC_SOURCE_LENGTH ||
		(diagnostics.source !== "stderr_dev_log" && diagnostics.source !== "input_trace") ||
		typeof diagnostics.truncated !== "boolean" ||
		!Array.isArray(diagnostics.lines) ||
		diagnostics.lines.length > FEEDBACK_DIAGNOSTICS_MAX_LINES
	) {
		return false;
	}
	let totalBytes = 0;
	for (const line of diagnostics.lines) {
		if (
			typeof line !== "string" ||
			(line.length > 0 && [...line].length > FEEDBACK_DIAGNOSTICS_MAX_LINE_CHARS) ||
			CONTROL_CHARACTERS.test(line) ||
			redactSecretString(line) !== line
		) {
			return false;
		}
		totalBytes += Buffer.byteLength(line, "utf8") + 1;
		if (
			totalBytes > FEEDBACK_DIAGNOSTICS_MAX_BYTES ||
			totalBytes > MAX_DIAGNOSTIC_LINE_BYTES * FEEDBACK_DIAGNOSTICS_MAX_LINES
		) {
			return false;
		}
	}
	try {
		const normalized = redactFeedbackDiagnostics({
			source: diagnostics.source,
			lines: diagnostics.lines,
			truncated: diagnostics.truncated,
		});
		return (
			normalized.source === diagnostics.source &&
			normalized.truncated === diagnostics.truncated &&
			JSON.stringify(normalized.lines) === JSON.stringify(diagnostics.lines)
		);
	} catch {
		return false;
	}
}

async function decompressSingleGzipMember(data: Buffer): Promise<Buffer | undefined> {
	const payloadOffset = readGzipPayloadOffset(data);
	if (payloadOffset === undefined) return undefined;
	let inflated: { buffer: Buffer; bytesWritten: number };
	try {
		inflated = await inflateRawWithInfo(data.subarray(payloadOffset));
	} catch {
		return undefined;
	}
	const footerOffset = payloadOffset + inflated.bytesWritten;
	if (footerOffset + 8 !== data.byteLength) return undefined;
	if (data.readUInt32LE(footerOffset) !== zlib.crc32(inflated.buffer)) return undefined;
	if (data.readUInt32LE(footerOffset + 4) !== inflated.buffer.byteLength >>> 0) return undefined;
	return inflated.buffer;
}

function inflateRawWithInfo(data: Buffer): Promise<{ buffer: Buffer; bytesWritten: number }> {
	return new Promise((resolve, reject) => {
		zlib.inflateRaw(data, { info: true, maxOutputLength: TAR_MAX_BYTES }, (error, result) => {
			if (error) {
				reject(error);
				return;
			}
			const info = result as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
			resolve({ buffer: info.buffer, bytesWritten: info.engine.bytesWritten });
		});
	});
}

function readGzipPayloadOffset(data: Buffer): number | undefined {
	if (data.byteLength < 18 || data[0] !== 0x1f || data[1] !== 0x8b || data[2] !== 8) return undefined;
	// The bundle builder emits a zero MTIME. A non-zero value is metadata that
	// was not part of the consented manifest, so edited members stay local.
	if (data.readUInt32LE(4) !== 0) return undefined;
	const flags = data[3] ?? 0;
	// Current bundles never use metadata-bearing gzip headers. Accepting them
	// would upload bytes that are absent from bundle.json and were never shown
	// during consent, so pending normalization rejects them rather than passing
	// the original member through unchanged.
	if ((flags & 0xe0) !== 0 || (flags & 0x1c) !== 0) return undefined;
	const footerOffset = data.byteLength - 8;
	let offset = 10;
	if ((flags & 0x02) !== 0) {
		if (offset + 2 > footerOffset) return undefined;
		if (data.readUInt16LE(offset) !== (zlib.crc32(data.subarray(0, offset)) & 0xffff)) return undefined;
		offset += 2;
	}
	return offset < footerOffset ? offset : undefined;
}

interface TarEntry {
	name: string;
	content: Buffer;
}

function validCurrentBundleManifest(content: Buffer, entries: readonly TarEntry[]): string | undefined {
	try {
		const value: unknown = JSON.parse(content.toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const manifest = value as Record<string, unknown>;
		const rootKeys = new Set(["sessionId", "createdAt", "lastActivityAt", "files"]);
		if (
			Object.keys(manifest).some((key) => !rootKeys.has(key)) ||
			typeof manifest.sessionId !== "string" ||
			normalizeStepWireSessionId(manifest.sessionId) !== manifest.sessionId ||
			typeof manifest.createdAt !== "string" ||
			manifest.createdAt.length > MAX_AT_LENGTH ||
			CONTROL_CHARACTERS.test(manifest.createdAt) ||
			!Number.isFinite(Date.parse(manifest.createdAt)) ||
			typeof manifest.lastActivityAt !== "string" ||
			manifest.lastActivityAt.length > MAX_AT_LENGTH ||
			CONTROL_CHARACTERS.test(manifest.lastActivityAt) ||
			!Number.isFinite(Date.parse(manifest.lastActivityAt)) ||
			!Array.isArray(manifest.files)
		) {
			return undefined;
		}

		const payloadEntries = new Map(
			entries.filter((entry) => entry.name !== BUNDLE_MANIFEST_ENTRY).map((entry) => [entry.name, entry] as const),
		);
		// A collector-compatible archive always carries the session event stream.
		// A manifest-only tar is self-consistent but has no report context and must
		// not become an uploadable pending bundle.
		if (!payloadEntries.has("events.jsonl")) return undefined;
		if (manifest.files.length !== payloadEntries.size) return undefined;
		const describedNames = new Set<string>();
		const descriptorKeys = new Set(["name", "bytes", "note"]);
		for (const file of manifest.files) {
			if (!file || typeof file !== "object" || Array.isArray(file)) return undefined;
			const descriptor = file as Record<string, unknown>;
			if (Object.keys(descriptor).some((key) => !descriptorKeys.has(key))) return undefined;
			if (typeof descriptor.name !== "string" || describedNames.has(descriptor.name)) return undefined;
			if (BUNDLE_ENTRY_LIMITS[descriptor.name] === undefined) return undefined;
			const entry = payloadEntries.get(descriptor.name);
			if (
				!entry ||
				typeof descriptor.bytes !== "number" ||
				!Number.isSafeInteger(descriptor.bytes) ||
				descriptor.bytes < 0 ||
				descriptor.bytes !== entry.content.byteLength
			) {
				return undefined;
			}
			if (
				Object.hasOwn(descriptor, "note") &&
				(typeof descriptor.note !== "string" || !isSafeManifestNote(descriptor.note))
			)
				return undefined;
			describedNames.add(descriptor.name);
		}
		return describedNames.size === payloadEntries.size ? manifest.createdAt : undefined;
	} catch {
		return undefined;
	}
}

function readTarEntries(tar: Buffer): TarEntry[] | undefined {
	const entries: TarEntry[] = [];
	const names = new Set<string>();
	let offset = 0;
	while (offset + TAR_BLOCK_BYTES <= tar.byteLength) {
		const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
		if (header.every((byte) => byte === 0)) {
			if (offset + TAR_BLOCK_BYTES * 2 > tar.byteLength) return undefined;
			if (!tar.subarray(offset).every((byte) => byte === 0)) return undefined;
			return entries;
		}
		if (entries.length >= Object.keys(BUNDLE_ENTRY_LIMITS).length) return undefined;
		if (!validTarChecksum(header)) return undefined;
		const name = readTarString(header, 0, 100);
		if (!name || name.includes("/") || readTarString(header, 345, 155) !== "" || names.has(name)) {
			return undefined;
		}
		const typeFlag = header[156];
		if (typeFlag !== 0 && typeFlag !== 0x30) return undefined;
		const size = readTarOctal(header, 124, 12);
		if (size === undefined) return undefined;
		const knownLimit =
			BUNDLE_ENTRY_LIMITS[name] ??
			(name === LEGACY_SESSION_ENTRY
				? BUNDLE_ENTRY_LIMITS["events.jsonl"]
				: name === LEGACY_MANIFEST_ENTRY
					? BUNDLE_ENTRY_LIMITS[BUNDLE_MANIFEST_ENTRY]
					: undefined);
		if (knownLimit === undefined || size > knownLimit) return undefined;
		const contentStart = offset + TAR_BLOCK_BYTES;
		const contentEnd = contentStart + size;
		if (contentEnd > tar.byteLength) return undefined;
		entries.push({ name, content: Buffer.from(tar.subarray(contentStart, contentEnd)) });
		names.add(name);
		offset = contentStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
	}
	return undefined;
}

function validTarChecksum(header: Buffer): boolean {
	const expected = readTarOctal(header, 148, 8);
	if (expected === undefined) return false;
	let actual = 0;
	for (let index = 0; index < header.byteLength; index += 1) {
		actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
	}
	return actual === expected;
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
	return buffer
		.subarray(offset, offset + length)
		.toString("utf8")
		.replace(/\0.*$/u, "");
}

function readTarOctal(buffer: Buffer, offset: number, length: number): number | undefined {
	const value = readTarString(buffer, offset, length).trim();
	if (!/^[0-7]+$/u.test(value)) return undefined;
	const parsed = Number.parseInt(value, 8);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseLegacyManifest(
	content: Buffer,
	sessionBytes: number,
): { sessionId: string; createdAt: string; lastActivityAt: string; note?: string } | undefined {
	try {
		const value: unknown = JSON.parse(content.toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const manifest = value as Record<string, unknown>;
		const rootKeys = new Set(["sessionId", "createdAt", "lastActivityAt", "files"]);
		if (
			Object.keys(manifest).some((key) => !rootKeys.has(key)) ||
			typeof manifest.sessionId !== "string" ||
			normalizeStepWireSessionId(manifest.sessionId) !== manifest.sessionId ||
			typeof manifest.createdAt !== "string" ||
			manifest.createdAt.length > MAX_AT_LENGTH ||
			CONTROL_CHARACTERS.test(manifest.createdAt) ||
			!Number.isFinite(Date.parse(manifest.createdAt)) ||
			typeof manifest.lastActivityAt !== "string" ||
			manifest.lastActivityAt.length > MAX_AT_LENGTH ||
			CONTROL_CHARACTERS.test(manifest.lastActivityAt) ||
			!Number.isFinite(Date.parse(manifest.lastActivityAt)) ||
			!Array.isArray(manifest.files) ||
			manifest.files.length !== 1
		) {
			return undefined;
		}
		const file = manifest.files[0];
		if (!file || typeof file !== "object" || Array.isArray(file)) return undefined;
		const descriptor = file as Record<string, unknown>;
		const descriptorKeys = new Set(["name", "bytes", "note"]);
		if (
			Object.keys(descriptor).some((key) => !descriptorKeys.has(key)) ||
			descriptor.name !== LEGACY_SESSION_ENTRY ||
			descriptor.bytes !== sessionBytes
		) {
			return undefined;
		}
		const hasNote = Object.hasOwn(descriptor, "note");
		const note = hasNote ? parseSafeLegacyFileNote(descriptor.note) : undefined;
		// A legacy note explains whether the session entry is partial or omitted.
		// If its shape is unfamiliar, preserving the original archive is safer than
		// converting it into a manifest that incorrectly presents the entry as full.
		if (hasNote && note === undefined) return undefined;
		return {
			sessionId: manifest.sessionId,
			createdAt: manifest.createdAt,
			lastActivityAt: manifest.lastActivityAt,
			...(note ? { note } : {}),
		};
	} catch {
		return undefined;
	}
}

function parseSafeLegacyFileNote(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return isSafeManifestNote(value) &&
		/^(?:tail only, \d+(?:\.\d)? (?:B|KB|MB) on disk|omitted, a single line exceeds \d+(?:\.\d)? (?:B|KB|MB))$/u.test(
			value,
		)
		? value
		: undefined;
}

function isSafeManifestNote(value: string): boolean {
	return (
		value.length <= MAX_MANIFEST_NOTE_LENGTH &&
		value === value.trim() &&
		!CONTROL_CHARACTERS.test(value) &&
		redactSecretString(value) === value
	);
}

function writeTar(entries: readonly TarEntry[], at: Date): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const header = Buffer.alloc(TAR_BLOCK_BYTES);
		Buffer.from(entry.name, "ascii").copy(header, 0, 0, 100);
		writeTarOctal(header, 100, 8, 0o600);
		writeTarOctal(header, 108, 8, 0);
		writeTarOctal(header, 116, 8, 0);
		writeTarOctal(header, 124, 12, entry.content.byteLength);
		writeTarOctal(header, 136, 12, Math.floor(at.getTime() / 1000));
		header.fill(0x20, 148, 156);
		header[156] = 0x30;
		Buffer.from("ustar\0", "ascii").copy(header, 257);
		Buffer.from("00", "ascii").copy(header, 263);
		let checksum = 0;
		for (const byte of header) checksum += byte;
		writeTarOctal(header, 148, 8, checksum);
		blocks.push(header, entry.content);
		const padding = (TAR_BLOCK_BYTES - (entry.content.byteLength % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
		if (padding) blocks.push(Buffer.alloc(padding));
	}
	blocks.push(Buffer.alloc(TAR_BLOCK_BYTES * 2));
	return Buffer.concat(blocks);
}

function writeTarOctal(target: Buffer, offset: number, length: number, value: number): void {
	const text = `${value.toString(8)}\0`.padStart(length, "0").slice(-length);
	Buffer.from(text, "ascii").copy(target, offset, 0, length);
}
