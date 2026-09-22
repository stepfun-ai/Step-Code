import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { stderr } from "node:process";
import { StringDecoder } from "node:string_decoder";
import { createBoundedSecretRedactor, hasTrailingSensitiveLabel, redactSecretString } from "./secret-redaction.ts";

const DEV_LOG_DIR_SEGMENT = "logs";
const DEV_LOG_FILE_PREFIX = "dev";
const DEV_LOG_RETENTION_DAYS = 7;
const MAX_PENDING_LINE_CHARACTERS = 64 * 1024;
const REDACTED_SECRET = "<redacted:secret>";
const PRIVATE_KEY_BEGIN_PATTERN = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----/u;

type QueuedAppend = {
	storageRootDir: string;
	text: string;
	at: Date;
	state: "pending" | "writing" | "finished";
};

type PendingPrivateKey = {
	endMarker: string;
	prefix: string;
	fallbackNewline: string;
	placeholderPersisted: boolean;
	currentLineMaterialOffset: number;
};

export type StderrMirrorWrite = NodeJS.WriteStream["write"] & {
	flush(): Promise<void>;
	flushSync(): void;
};

let currentStorageRootDir = process.cwd();
let installedMirror: StderrMirrorWrite | undefined;
let directAppendPending = Promise.resolve();
const lastPrunedDateByDirectory = new Map<string, string>();

export function resolveStderrDevLogPath(storageRootDir: string, at: Date = new Date()): string {
	return path.join(
		path.resolve(storageRootDir),
		DEV_LOG_DIR_SEGMENT,
		`${DEV_LOG_FILE_PREFIX}-${localDateSegment(at)}.log`,
	);
}

export function setStderrDevLogStorageRootDirectory(storageRootDir: string): void {
	currentStorageRootDir = path.resolve(storageRootDir);
}

export async function appendStderrDevLog(text: string, storageRootDir = currentStorageRootDir): Promise<void> {
	if (text.length === 0) return;
	const persistedText = redactForPersistence(text);
	const at = new Date();
	directAppendPending = directAppendPending
		.then(() => appendToDailyDevLog(storageRootDir, persistedText, at))
		.catch(() => undefined);
	await directAppendPending;
}

export function installProcessStderrDevLogCapture(): StderrMirrorWrite {
	if (installedMirror) return installedMirror;

	installedMirror = createStderrMirrorWrite({
		baseWrite: stderr.write.bind(stderr),
		getStorageRootDir: () => currentStorageRootDir,
	});
	stderr.write = installedMirror as typeof stderr.write;
	process.prependListener("exit", () => {
		installedMirror?.flushSync();
	});
	return installedMirror;
}

export async function flushStderrDevLog(): Promise<void> {
	while (true) {
		await installedMirror?.flush();
		const observed = directAppendPending;
		await observed;
		await installedMirror?.flush();
		if (observed === directAppendPending) return;
	}
}

export function createStderrMirrorWrite(input: {
	baseWrite: NodeJS.WriteStream["write"];
	getStorageRootDir: () => string;
}): StderrMirrorWrite {
	let decoder = new StringDecoder("utf8");
	let pendingLine = "";
	let pendingSensitiveLabel = false;
	let pendingPrivateKey: PendingPrivateKey | undefined;
	let overlongLineTail = "";
	let discardOverlongLine = false;
	let discardFlushedLineRemainder = false;
	let flushedLineSensitiveValue = false;
	let exiting = false;
	let writeRevision = 0;
	let pending = Promise.resolve();
	const queuedAppends = new Set<QueuedAppend>();
	const streamRedactor = createBoundedSecretRedactor();

	const appendRedacted = (text: string): void => {
		if (text.length === 0) return;
		let queued: QueuedAppend;
		try {
			const redacted = streamRedactor.redact(text);
			queued = {
				storageRootDir: input.getStorageRootDir(),
				text: redacted.status === "ready" ? redacted.value : failClosedRedaction(text),
				at: new Date(),
				state: "pending",
			};
		} catch {
			return;
		}

		if (exiting) {
			try {
				appendToDailyDevLogSync(queued.storageRootDir, queued.text, queued.at);
			} catch {
				// Stderr itself has already been written. The mirror is best-effort.
			}
			return;
		}

		queuedAppends.add(queued);
		pending = pending
			.then(() => {
				if (queued.state !== "pending") return;
				queued.state = "writing";
				try {
					appendToDailyDevLogSync(queued.storageRootDir, queued.text, queued.at);
				} finally {
					queued.state = "finished";
					queuedAppends.delete(queued);
				}
			})
			.catch(() => undefined);
	};

	const beginPrivateKey = (line: string, newline: string): void => {
		let output = "";
		let remaining = line;
		while (true) {
			const begin = PRIVATE_KEY_BEGIN_PATTERN.exec(remaining);
			const label = begin?.[1];
			if (!begin || !label) {
				appendRedacted(`${output}${remaining}${newline}`);
				pendingSensitiveLabel = hasTrailingSensitiveLabel(remaining);
				return;
			}

			const endMarker = `-----END ${label}-----`;
			const afterBegin = begin.index + begin[0].length;
			const endIndex = remaining.indexOf(endMarker, afterBegin);
			output += remaining.slice(0, begin.index);
			if (endIndex < 0) {
				pendingPrivateKey = {
					endMarker,
					prefix: output,
					fallbackNewline: newline,
					placeholderPersisted: false,
					currentLineMaterialOffset: 0,
				};
				observePrivateKeyMaterial(remaining.slice(afterBegin));
				return;
			}

			observePrivateKeyMaterial(remaining.slice(afterBegin, endIndex));
			output += REDACTED_SECRET;
			remaining = remaining.slice(endIndex + endMarker.length);
		}
	};

	const persistPrivateKeyPlaceholder = (): void => {
		if (!pendingPrivateKey || pendingPrivateKey.placeholderPersisted) return;
		appendRedacted(`${pendingPrivateKey.prefix}${REDACTED_SECRET}${pendingPrivateKey.fallbackNewline}`);
		pendingPrivateKey.prefix = "";
		pendingPrivateKey.fallbackNewline = "";
		pendingPrivateKey.placeholderPersisted = true;
	};

	const observePrivateKeyMaterial = (material: string): void => {
		if (PRIVATE_KEY_BEGIN_PATTERN.test(material)) {
			streamRedactor.invalidate();
			return;
		}
		if (material.trim().length > 0) streamRedactor.observeSensitive(material);
	};

	const finishLine = (newline: string): void => {
		const flushedLineSensitiveLabel = discardFlushedLineRemainder
			? hasTrailingSensitiveLabel(overlongLineTail)
			: false;
		if (discardFlushedLineRemainder && overlongLineTail.length > 0) {
			if (pendingPrivateKey) {
				observePrivateKeyMaterial(overlongLineTail.slice(pendingPrivateKey.currentLineMaterialOffset));
				pendingPrivateKey.currentLineMaterialOffset = 0;
			} else if (flushedLineSensitiveValue) streamRedactor.observeSensitive(overlongLineTail);
			else streamRedactor.redact(overlongLineTail);
		}
		overlongLineTail = "";
		if (discardFlushedLineRemainder) {
			pendingLine = "";
			pendingSensitiveLabel = !flushedLineSensitiveValue && flushedLineSensitiveLabel;
			discardOverlongLine = false;
			discardFlushedLineRemainder = false;
			flushedLineSensitiveValue = false;
			appendRedacted(newline);
			return;
		}

		if (discardOverlongLine) {
			pendingLine = "";
			pendingSensitiveLabel = false;
			discardOverlongLine = false;
			if (pendingPrivateKey) {
				persistPrivateKeyPlaceholder();
				return;
			}
			appendRedacted(`${REDACTED_SECRET}${newline}`);
			return;
		}

		if (!pendingPrivateKey) {
			const line = pendingLine;
			pendingLine = "";
			if (pendingSensitiveLabel) {
				pendingSensitiveLabel = false;
				streamRedactor.observeSensitive(line);
				detectUnterminatedPrivateKey(line, true, false);
				appendRedacted(`${REDACTED_SECRET}${newline}`);
				return;
			}
			beginPrivateKey(line, newline);
			return;
		}

		const endIndex = pendingLine.indexOf(pendingPrivateKey.endMarker, pendingPrivateKey.currentLineMaterialOffset);
		if (endIndex < 0) {
			observePrivateKeyMaterial(pendingLine.slice(pendingPrivateKey.currentLineMaterialOffset));
			pendingPrivateKey.currentLineMaterialOffset = 0;
			pendingLine = "";
			return;
		}

		observePrivateKeyMaterial(pendingLine.slice(pendingPrivateKey.currentLineMaterialOffset, endIndex));
		const suffix = pendingLine.slice(endIndex + pendingPrivateKey.endMarker.length);
		const prefix = pendingPrivateKey.placeholderPersisted ? "" : `${pendingPrivateKey.prefix}${REDACTED_SECRET}`;
		pendingPrivateKey = undefined;
		pendingLine = "";
		beginPrivateKey(`${prefix}${suffix}`, newline);
	};

	const detectUnterminatedPrivateKey = (
		text: string,
		placeholderPersisted = false,
		retainCurrentLine = true,
	): void => {
		if (pendingPrivateKey) return;
		let remaining = text;
		let consumedCharacters = 0;
		while (true) {
			const begin = PRIVATE_KEY_BEGIN_PATTERN.exec(remaining);
			const label = begin?.[1];
			if (!begin || !label) return;
			const endMarker = `-----END ${label}-----`;
			const materialStart = begin.index + begin[0].length;
			const endIndex = remaining.indexOf(endMarker, materialStart);
			if (endIndex < 0) {
				if (!retainCurrentLine) observePrivateKeyMaterial(remaining.slice(materialStart));
				pendingPrivateKey = {
					endMarker,
					prefix: "",
					fallbackNewline: "",
					placeholderPersisted,
					currentLineMaterialOffset: retainCurrentLine ? consumedCharacters + materialStart : 0,
				};
				return;
			}
			observePrivateKeyMaterial(remaining.slice(materialStart, endIndex));
			consumedCharacters += endIndex + endMarker.length;
			remaining = remaining.slice(endIndex + endMarker.length);
		}
	};

	const scanFlushedLineRemainder = (fragment: string): void => {
		if (overlongLineTail.length + fragment.length > MAX_PENDING_LINE_CHARACTERS) {
			streamRedactor.invalidate();
			overlongLineTail = "";
			if (pendingPrivateKey) pendingPrivateKey.currentLineMaterialOffset = 0;
			return;
		}
		let scanText = `${overlongLineTail}${fragment}`;
		if (pendingPrivateKey) {
			const endIndex = scanText.indexOf(pendingPrivateKey.endMarker, pendingPrivateKey.currentLineMaterialOffset);
			if (endIndex < 0) {
				overlongLineTail = scanText.slice(-MAX_PENDING_LINE_CHARACTERS);
				return;
			}
			observePrivateKeyMaterial(scanText.slice(pendingPrivateKey.currentLineMaterialOffset, endIndex));
			scanText = scanText.slice(endIndex + pendingPrivateKey.endMarker.length);
			pendingPrivateKey = undefined;
		}
		detectUnterminatedPrivateKey(scanText, true);
		overlongLineTail = scanText.slice(-MAX_PENDING_LINE_CHARACTERS);
	};

	const appendLineFragment = (fragment: string): void => {
		if (fragment.length === 0) return;
		if (discardFlushedLineRemainder) {
			scanFlushedLineRemainder(fragment);
			return;
		}
		if (discardOverlongLine) {
			return;
		}
		if (pendingLine.length + fragment.length > MAX_PENDING_LINE_CHARACTERS) {
			streamRedactor.invalidate();
			overlongLineTail = "";
			pendingLine = "";
			discardOverlongLine = true;
			return;
		}
		pendingLine += fragment;
	};

	const consumeDecodedText = (text: string): void => {
		let start = 0;
		let newlineIndex = text.indexOf("\n", start);
		while (newlineIndex >= 0) {
			appendLineFragment(text.slice(start, newlineIndex));
			finishLine("\n");
			start = newlineIndex + 1;
			newlineIndex = text.indexOf("\n", start);
		}
		appendLineFragment(text.slice(start));
	};

	const resetDecoder = (): string => {
		const tail = decoder.end();
		decoder = new StringDecoder("utf8");
		if (tail.includes("\ufffd")) streamRedactor.invalidate();
		return tail;
	};

	const decodeChunk = (chunk: string | Uint8Array): string => {
		if (typeof chunk !== "string") return decoder.write(Buffer.from(chunk));
		return `${resetDecoder()}${chunk}`;
	};

	const finalizeBufferedInput = (): void => {
		if (pendingPrivateKey) {
			const endIndex = discardOverlongLine
				? -1
				: pendingLine.indexOf(pendingPrivateKey.endMarker, pendingPrivateKey.currentLineMaterialOffset);
			if (endIndex < 0) {
				persistPrivateKeyPlaceholder();
				if (discardOverlongLine) {
					pendingLine = "";
					overlongLineTail = "";
					discardOverlongLine = false;
				}
				return;
			}

			observePrivateKeyMaterial(pendingLine.slice(pendingPrivateKey.currentLineMaterialOffset, endIndex));
			const suffix = pendingLine.slice(endIndex + pendingPrivateKey.endMarker.length);
			persistPrivateKeyPlaceholder();
			pendingPrivateKey = undefined;
			pendingLine = "";
			discardOverlongLine = false;
			detectUnterminatedPrivateKey(suffix, true);
			overlongLineTail = suffix.slice(-MAX_PENDING_LINE_CHARACTERS);
			discardFlushedLineRemainder = true;
			flushedLineSensitiveValue = false;
			return;
		}

		if (discardOverlongLine || pendingLine.length > 0) {
			const scanText = discardOverlongLine ? overlongLineTail : pendingLine;
			const sensitiveValue = pendingSensitiveLabel;
			if (sensitiveValue) streamRedactor.observeSensitive(scanText);
			else streamRedactor.redact(scanText);
			detectUnterminatedPrivateKey(scanText, true);
			appendRedacted(REDACTED_SECRET);
			pendingLine = "";
			pendingSensitiveLabel = false;
			overlongLineTail = scanText.slice(-MAX_PENDING_LINE_CHARACTERS);
			discardOverlongLine = false;
			discardFlushedLineRemainder = true;
			flushedLineSensitiveValue = sensitiveValue;
		}
	};

	const drainQueuedAppendsSync = (): void => {
		for (const queued of queuedAppends) {
			if (queued.state === "finished") continue;
			try {
				appendToDailyDevLogSync(queued.storageRootDir, queued.text, queued.at);
			} catch {
				// Stderr itself has already been written. The mirror is best-effort.
			}
			queued.state = "finished";
			queuedAppends.delete(queued);
		}
	};

	const mirror = ((
		chunk: string | Uint8Array,
		encoding?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		let result: boolean;
		if (typeof encoding === "function") {
			result = input.baseWrite(chunk, encoding);
		} else if (callback) {
			result = input.baseWrite(chunk, encoding, callback);
		} else if (encoding) {
			result = input.baseWrite(chunk, encoding);
		} else {
			result = input.baseWrite(chunk);
		}

		try {
			writeRevision += 1;
			consumeDecodedText(decodeChunk(chunk));
			if (exiting) finalizeBufferedInput();
		} catch {
			// Mirroring must never alter the original stderr write.
		}
		return result;
	}) as StderrMirrorWrite;

	mirror.flush = async () => {
		if (!exiting) finalizeBufferedInput();
		while (true) {
			const observedRevision = writeRevision;
			const observedPending = pending;
			await observedPending;
			if (exiting) {
				drainQueuedAppendsSync();
				return;
			}
			if (observedRevision === writeRevision && observedPending === pending) return;
			finalizeBufferedInput();
		}
	};

	mirror.flushSync = () => {
		if (!exiting) {
			exiting = true;
			drainQueuedAppendsSync();
			finalizeBufferedInput();
			return;
		}
		drainQueuedAppendsSync();
		finalizeBufferedInput();
	};

	return mirror;
}

async function appendToDailyDevLog(storageRootDir: string, text: string, at: Date): Promise<void> {
	const logPath = resolveStderrDevLogPath(storageRootDir, at);
	const directory = path.dirname(logPath);
	await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
	await fsPromises.chmod(directory, 0o700).catch(() => undefined);
	await ensureRegularLogTarget(logPath);
	await fsPromises.appendFile(logPath, text, { encoding: "utf8", mode: 0o600 });
	await fsPromises.chmod(logPath, 0o600).catch(() => undefined);
	await pruneExpiredDevLogsOnce(directory, at);
}

function appendToDailyDevLogSync(storageRootDir: string, text: string, at: Date): void {
	const logPath = resolveStderrDevLogPath(storageRootDir, at);
	const directory = path.dirname(logPath);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(directory, 0o700);
	} catch {
		// The append may still work for a directory whose mode cannot be changed.
	}
	ensureRegularLogTargetSync(logPath);
	fs.appendFileSync(logPath, text, { encoding: "utf8", mode: 0o600 });
	try {
		fs.chmodSync(logPath, 0o600);
	} catch {
		// The diagnostic write succeeded, so a chmod failure is non-fatal.
	}
	pruneExpiredDevLogsOnceSync(directory, at);
}

async function ensureRegularLogTarget(logPath: string): Promise<void> {
	try {
		const stats = await fsPromises.lstat(logPath);
		if (!stats.isFile()) throw new Error("refusing to append through a non-regular log path");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function ensureRegularLogTargetSync(logPath: string): void {
	try {
		const stats = fs.lstatSync(logPath);
		if (!stats.isFile()) throw new Error("refusing to append through a non-regular log path");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function pruneExpiredDevLogsOnce(directory: string, at: Date): Promise<void> {
	const dateSegment = localDateSegment(at);
	if (lastPrunedDateByDirectory.get(directory) === dateSegment) return;
	lastPrunedDateByDirectory.set(directory, dateSegment);
	await pruneExpiredDevLogs(directory, at).catch(() => undefined);
}

function pruneExpiredDevLogsOnceSync(directory: string, at: Date): void {
	const dateSegment = localDateSegment(at);
	if (lastPrunedDateByDirectory.get(directory) === dateSegment) return;
	lastPrunedDateByDirectory.set(directory, dateSegment);
	try {
		pruneExpiredDevLogsSync(directory, at);
	} catch {
		// Retention is best-effort and must not prevent the diagnostic append.
	}
}

async function pruneExpiredDevLogs(directory: string, at: Date): Promise<void> {
	const oldestRetainedSegment = oldestRetainedDateSegment(at);
	const entries = await fsPromises.readdir(directory).catch(() => [] as string[]);
	await Promise.all(
		entries.map(async (entry) => {
			const segment = parseDevLogDateSegment(entry);
			if (!segment || segment >= oldestRetainedSegment) return;
			await fsPromises.unlink(path.join(directory, entry)).catch(() => undefined);
		}),
	);
}

function pruneExpiredDevLogsSync(directory: string, at: Date): void {
	const oldestRetainedSegment = oldestRetainedDateSegment(at);
	for (const entry of fs.readdirSync(directory)) {
		const segment = parseDevLogDateSegment(entry);
		if (!segment || segment >= oldestRetainedSegment) continue;
		try {
			fs.unlinkSync(path.join(directory, entry));
		} catch {
			// Retention is best-effort.
		}
	}
}

function oldestRetainedDateSegment(at: Date): string {
	return localDateSegment(new Date(at.getFullYear(), at.getMonth(), at.getDate() - (DEV_LOG_RETENTION_DAYS - 1)));
}

function parseDevLogDateSegment(fileName: string): string | undefined {
	return new RegExp(`^${DEV_LOG_FILE_PREFIX}-(\\d{4}-\\d{2}-\\d{2})\\.log$`, "u").exec(fileName)?.[1];
}

function localDateSegment(at: Date): string {
	const year = at.getFullYear();
	const month = String(at.getMonth() + 1).padStart(2, "0");
	const day = String(at.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function redactForPersistence(text: string): string {
	try {
		return redactSecretString(text);
	} catch {
		return failClosedRedaction(text);
	}
}

function failClosedRedaction(text: string): string {
	return text.endsWith("\n") ? `${REDACTED_SECRET}\n` : REDACTED_SECRET;
}
