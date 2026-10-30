import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { FileEntry, SessionFilePersistedEvent } from "../session-manager.ts";
import { SessionImportError } from "./errors.ts";
import { record } from "./parsers.ts";
import type { ImportDocument, ImportPreview, ImportResult, ImportSelection } from "./types.ts";

export interface ReservedSessionImport {
	readonly candidate: ImportPreview;
	readonly cwd: string;
	readonly path: string;
	/** Hash of the frozen native bytes, or of a verified existing target at preparation. */
	readonly fingerprint: string;
	/** Updated after a publication race too; read after publish to report the actual target cwd. */
	readonly existing?: { sessionId: string; path: string; cwd: string };
	publish(): Promise<ImportResult>;
}

export interface ReservedSessionImports {
	readonly items: ReservedSessionImport[];
	/** Invalidate unpublished work immediately; await any atomic publication and its cleanup. */
	release(): Promise<void>;
}

const MAX_EXISTING_BYTES = 128 * 1024 * 1024;
const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function checkImportDirectory(path: string): Promise<void> {
	try {
		const info = await lstat(path);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new SessionImportError("Invalid import directory", 409);
	} catch (error) {
		if (record(error).code !== "ENOENT") throw error;
	}
}

/** Validate identity without opening a live session or following a target file link. */
async function readExisting(path: string, id: string, preview: ImportPreview) {
	let info: Stats;
	try {
		info = await lstat(path);
	} catch (error) {
		if (record(error).code === "ENOENT") return undefined;
		throw error;
	}
	if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_EXISTING_BYTES) {
		throw new SessionImportError("Existing import target cannot be verified", 409);
	}
	const handle = await open(path, "r");
	try {
		const opened = await handle.stat();
		if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) {
			throw new SessionImportError("Existing import target changed", 409);
		}
		const bytes = Buffer.alloc(info.size);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		const after = await lstat(path);
		if (
			offset !== bytes.length ||
			after.isSymbolicLink() ||
			after.dev !== info.dev ||
			after.ino !== info.ino ||
			after.size !== info.size ||
			after.mtimeMs !== info.mtimeMs
		) {
			throw new SessionImportError("Existing import target changed", 409);
		}
		let header: Record<string, unknown> | undefined;
		let provenance = false;
		try {
			for (const line of bytes.toString("utf8").split("\n")) {
				if (!line.trim()) continue;
				const entry = record(JSON.parse(line));
				if (!header) header = entry;
				if (entry.type !== "custom" || entry.customType !== "stepcode.session-import") continue;
				const data = record(entry.data);
				if (
					data.source === preview.source &&
					data.sourceSessionId === preview.sessionId &&
					data.fingerprint === preview.fingerprint
				) {
					provenance = true;
				}
			}
		} catch {
			throw new SessionImportError("Existing import target is not a valid session", 409);
		}
		if (
			!provenance ||
			header?.type !== "session" ||
			header.id !== id ||
			typeof header.cwd !== "string" ||
			!isAbsolute(header.cwd) ||
			header.cwd.includes("\0")
		) {
			throw new SessionImportError("Existing import target identity does not match", 409);
		}
		return { sessionId: id, path, cwd: header.cwd, fingerprint: digest(bytes) };
	} finally {
		await handle.close();
	}
}

// prepare freezes IDs and timestamps before any journal records a publication hash.
export async function prepareSessionPublication(options: {
	sessionRoot: string;
	selection: ImportSelection;
	document: ImportDocument;
	onPersisted?: (event: SessionFilePersistedEvent) => void;
	canPublish?: () => boolean;
}): Promise<ReservedSessionImport> {
	const { selection, document, onPersisted } = options;
	const { entries: reviewedEntries, preview } = document;
	const cwd = await realpath(selection.cwd);
	if (!(await stat(cwd)).isDirectory()) throw new SessionImportError("Project directory does not exist");
	const hash = digest(`session-import-v2\0${preview.source}\0${preview.sessionId}\0${preview.fingerprint}`);
	const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
	const dir = join(options.sessionRoot, "imported");
	await checkImportDirectory(dir);
	const path = join(dir, `${id}.jsonl`);
	let existing = await readExisting(path, id, preview);
	const last = reviewedEntries.at(-1);
	const timestamp = new Date().toISOString();
	const metadataId = randomUUID().slice(0, 8);
	const entries: FileEntry[] = [
		{ type: "session", version: 3, id, timestamp, cwd },
		...reviewedEntries,
		{
			type: "custom",
			id: metadataId,
			parentId: last && "id" in last ? last.id : null,
			timestamp,
			customType: "stepcode.session-import",
			data: {
				converterVersion: 2,
				source: preview.source,
				sourceSessionId: preview.sessionId,
				fingerprint: preview.fingerprint,
				version: preview.version,
				sourceCwd: preview.cwd,
				warnings: preview.warnings,
			},
		},
		{
			type: "session_info",
			id: randomUUID().slice(0, 8),
			parentId: metadataId,
			timestamp,
			name: `[${preview.source}] ${preview.title}`,
		},
	];
	const bytes = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
	const fingerprint = existing?.fingerprint ?? digest(bytes);
	let publication: Promise<ImportResult> | undefined;
	return {
		candidate: structuredClone(preview),
		cwd,
		path,
		fingerprint,
		get existing() {
			return existing && { sessionId: existing.sessionId, path, cwd: existing.cwd };
		},
		publish() {
			publication ??= publish();
			return publication.then((result) => structuredClone(result));
		},
	};

	function assertActive(): void {
		if (options.canPublish && !options.canPublish()) {
			throw new SessionImportError("Import reservation is no longer active", 409);
		}
	}

	async function publish(): Promise<ImportResult> {
		assertActive();
		await checkImportDirectory(dir);
		assertActive();
		let status: "imported" | "skipped" = "imported";
		if (existing) {
			const current = await readExisting(path, id, preview);
			assertActive();
			if (!current) throw new SessionImportError("Existing import was removed; preview again", 409);
			existing = current;
			status = "skipped";
		} else {
			await mkdir(dir, { recursive: true });
			await checkImportDirectory(dir);
			assertActive();
			const temporary = join(dir, `.${id}.${randomUUID()}.tmp`);
			const handle = await open(temporary, "wx", 0o600);
			try {
				assertActive();
				await handle.writeFile(bytes);
				await handle.sync();
				await handle.close();
				assertActive();
				try {
					// Once this syscall starts, finish recording the truthful result and cleanup before release settles.
					await link(temporary, path);
				} catch (error) {
					if (record(error).code !== "EEXIST") throw error;
					existing = await readExisting(path, id, preview);
					if (!existing) throw new SessionImportError("Import target changed during publication", 409);
					status = "skipped";
				}
			} finally {
				await handle.close();
				await unlink(temporary);
			}
		}
		let warning: string | undefined;
		try {
			onPersisted?.({ path, kind: "append" });
		} catch (error) {
			warning = `Session saved; search index notification failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		return {
			candidateId: selection.candidateId,
			source: preview.source,
			sourcePath: preview.sourcePath,
			title: preview.title,
			cwd: selection.cwd,
			status,
			sessionId: id,
			path,
			warning,
		};
	}
}
