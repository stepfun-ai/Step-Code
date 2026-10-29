import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
	type FileHandle,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionFilePersistedEvent } from "../session-manager.ts";
import { stripImportedUserControls } from "./content.ts";
import { SessionImportError } from "./errors.ts";
import { prepareSessionPublication, type ReservedSessionImport, type ReservedSessionImports } from "./publication.ts";

export { SessionImportError } from "./errors.ts";
export type { ReservedSessionImport, ReservedSessionImports } from "./publication.ts";

import { parseForeignSession, record } from "./parsers.ts";
import type {
	ImportCandidate,
	ImportDocument,
	ImportJob,
	ImportPreview,
	ImportResult,
	ImportSelection,
	ImportSource,
	ParsedImport,
} from "./types.ts";
import { isImportProvenance, isImportSource } from "./types.ts";

const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const HEADER_BYTES = 1024 * 1024;

function readableTitle(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, 120) : "";
}

function userTitle(content: unknown): string {
	if (typeof content === "string") return readableTitle(stripImportedUserControls(content).text);
	if (!Array.isArray(content)) return "";
	return readableTitle(
		content
			.filter((block) => ["text", "input_text"].includes(String(record(block).type)))
			.map((block) => {
				const value = record(block).text;
				return typeof value === "string" ? stripImportedUserControls(value).text : "";
			})
			.filter((text) => typeof text === "string")
			.join(" "),
	);
}

function within(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
const MAX_CANDIDATES = 5000;
const MAX_DEPTH = 16;
const MAX_PREVIEW_BYTES = 256 * 1024 * 1024;
const PREVIEW_TTL_MS = 15 * 60 * 1000;

async function sourceAttachments(input: string, root: string): Promise<{ input: string; digest: string }> {
	const fingerprints: string[] = [];
	let total = 0;
	const localImage = async (value: string): Promise<{ data: string; mime: string } | undefined> => {
		if (!value || /^data:|^https?:/u.test(value)) return undefined;
		try {
			const path = await realpath(
				value.startsWith("file:") ? fileURLToPath(value) : isAbsolute(value) ? value : join(root, value),
			);
			const rel = relative(root, path);
			if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
			const info = await stat(path);
			if (!info.isFile() || info.size > 20 * 1024 * 1024 || total + info.size > 32 * 1024 * 1024) return undefined;
			const data = await readFile(path);
			const after = await stat(path);
			if (info.size !== after.size || info.mtimeMs !== after.mtimeMs)
				throw new SessionImportError("Attachment changed; preview again", 409);
			const mime = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
				? "image/png"
				: data[0] === 255 && data[1] === 216
					? "image/jpeg"
					: data.subarray(0, 3).toString() === "GIF"
						? "image/gif"
						: data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP"
							? "image/webp"
							: undefined;
			if (!mime) return undefined;
			total += data.length;
			fingerprints.push(`${rel}:${createHash("sha256").update(data).digest("hex")}`);
			return { data: data.toString("base64"), mime };
		} catch (error) {
			if (error instanceof SessionImportError) throw error;
			if (["ENOENT", "EACCES", "EPERM", "EINVAL"].includes(String(record(error).code))) return undefined;
			throw error;
		}
	};
	const visit = async (value: unknown, depth: number): Promise<void> => {
		if (depth > 32) throw new SessionImportError("Source content nesting limit exceeded");
		if (Array.isArray(value)) {
			for (const child of value) await visit(child, depth + 1);
			return;
		}
		const r = record(value);
		if (r.type === "input_image" && typeof r.image_url === "string" && !r.image_url.startsWith("data:")) {
			const image = await localImage(r.image_url);
			if (image) r.image_url = `data:${image.mime};base64,${image.data}`;
		}
		if (r.type === "image" && record(r.source).type === "file" && typeof record(r.source).path === "string") {
			const image = await localImage(String(record(r.source).path));
			if (image) r.source = { type: "base64", media_type: image.mime, data: image.data };
		}
		for (const child of Object.values(r)) if (child && typeof child === "object") await visit(child, depth + 1);
	};
	const lines: string[] = [];
	for (const line of input.split(/\r?\n/u)) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new SessionImportError("Invalid JSONL snapshot; wait for the source to finish writing");
		}
		await visit(value, 0);
		lines.push(JSON.stringify(value));
	}
	return { input: lines.join("\n"), digest: fingerprints.join("\n") };
}

/** Counts non-empty JSONL records up to a per-file cap; a capped count is a lower bound. */
async function countRecords(
	handle: FileHandle,
	from: number,
	size: number,
	cap = 4 * 1024 * 1024,
): Promise<{ count: number; capped: boolean }> {
	const end = Math.min(size, from + cap);
	let position = from;
	let count = 0;
	let trailing = false;
	while (position < end) {
		const buffer = Buffer.alloc(Math.min(64 * 1024, end - position));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
		if (!bytesRead) break;
		position += bytesRead;
		for (const byte of buffer.subarray(0, bytesRead)) {
			if (byte === 10) {
				if (trailing) count += 1;
				trailing = false;
			} else trailing = true;
		}
	}
	if (trailing) count += 1;
	return { count, capped: end < size };
}

interface CandidateFile {
	candidate: ImportCandidate;
	path: string;
	root: string;
}

interface ReviewedSnapshot {
	data: string;
	bytes: number;
	expires: number;
	users: number;
}

export interface ImportScanOptions {
	customRoot?: string;
	workbuddyRoot?: string;
	qoderRoot?: string;
	codexRoot?: string;
	claudeRoot?: string;
	includeArchived?: boolean;
	/** Source file modification cutoff; evaluated before reading discovery records. */
	modifiedSince?: number;
}

/**
 * WorkBuddy moved its transcripts from `~/.workbuddy/projects` to `~/.workbuddy-ai/projects`;
 * prefer the current layout and fall back to the legacy one only when it is absent.
 */
export function workbuddyProjectsRoot(home: string): string {
	const current = join(home, ".workbuddy-ai", "projects");
	return existsSync(current) ? current : join(home, ".workbuddy", "projects");
}

export interface ImportScanResult {
	existingCount: number;
	roots: Partial<Record<ImportSource, string>>;
	candidates: ImportCandidate[];
	errors: { source: ImportSource; message: string }[];
}

/** A local, offline migration service. Source files are opened read-only, never as live sessions. */
export class SessionImportService {
	private readonly agentDir: string;
	private readonly sessionRoot: string;
	private readonly onPersisted?: (event: SessionFilePersistedEvent) => void;
	private readonly candidates = new Map<string, CandidateFile>();
	private readonly explicitTitles = new WeakSet<ImportCandidate>();
	private readonly jobs = new Map<string, ImportJob>();
	private readonly running = new Map<string, Promise<void>>();
	private readonly cancelled = new Set<string>();
	private readonly previews = new Map<string, ReviewedSnapshot>();
	private queue: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(options: {
		agentDir: string;
		sessionRoot?: string;
		onPersisted?: (event: SessionFilePersistedEvent) => void;
	}) {
		this.agentDir = resolve(options.agentDir);
		this.sessionRoot = resolve(options.sessionRoot ?? join(this.agentDir, "sessions"));
		this.onPersisted = options.onPersisted;
	}

	async scan(options: ImportScanOptions = {}): Promise<ImportScanResult> {
		if (this.closed) throw new SessionImportError("Importer is closed", 503);
		const result: ImportScanResult = { existingCount: 0, roots: {}, candidates: [], errors: [] };
		const roots: [ImportSource, string][] = [
			["workbuddy", options.customRoot?.trim() || options.workbuddyRoot?.trim() || workbuddyProjectsRoot(homedir())],
			["qoder", options.customRoot?.trim() || options.qoderRoot?.trim() || join(homedir(), ".qoder", "projects")],
			[
				"codex",
				options.customRoot?.trim() ||
					options.codexRoot?.trim() ||
					process.env.CODEX_HOME?.trim() ||
					join(homedir(), ".codex"),
			],
			[
				"claude-code",
				options.customRoot?.trim() ||
					options.claudeRoot?.trim() ||
					join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "projects"),
			],
		];
		// Custom scans append capabilities; automatic scans replace them after discovery settles.
		const candidates = new Map<string, CandidateFile>(options.customRoot ? this.candidates : []);
		const knownPaths = new Set([...candidates.values()].map((file) => `${file.candidate.source}\0${file.path}`));
		for (const [source, input] of roots) {
			try {
				const root = await realpath(input);
				if (!options.customRoot) result.roots[source] = root;
				if (root.split(sep).includes("archived_sessions") && !options.includeArchived) continue;
				const rootEntries = await readdir(root, { withFileTypes: true });
				const codexHome =
					source === "codex" &&
					rootEntries.some(
						(entry) =>
							(entry.isDirectory() && ["sessions", "archived_sessions"].includes(entry.name)) ||
							entry.name === "session_index.jsonl",
					);
				const titles = new Map<string, string>();
				if (source === "codex") {
					const index = join(root, "session_index.jsonl");
					try {
						const info = await stat(index);
						if (info.size > 32 * 1024 * 1024) throw new Error("Source title index exceeds 32 MiB");
						for (const line of (await readFile(index, "utf8")).split(/\r?\n/u)) {
							if (!line.trim()) continue;
							const entry = record(JSON.parse(line));
							if (typeof entry.id === "string" && typeof entry.thread_name === "string")
								titles.set(entry.id, entry.thread_name.slice(0, 120));
						}
					} catch (error) {
						if (record(error).code !== "ENOENT")
							result.errors.push({
								source,
								message: `Title index: ${error instanceof Error ? error.message : String(error)}`,
							});
					}
				}
				const walk = async (dir: string, depth: number): Promise<void> => {
					if (depth > MAX_DEPTH) throw new Error("Source directory depth limit exceeded");
					const files = await readdir(dir, { withFileTypes: true });
					for (const file of files) {
						if (this.closed) throw new Error("Importer is closed");
						if (file.isSymbolicLink()) continue;
						const archived = file.name === "archived_sessions";
						if (archived && !options.includeArchived) continue;
						if (
							["node_modules", ".git", "attachments", "worktrees", "backups", "backups_state"].includes(
								file.name,
							)
						)
							continue;
						const path = join(dir, file.name);
						if (file.isDirectory()) {
							if (
								source === "codex" &&
								codexHome &&
								dir === root &&
								!["sessions", "archived_sessions"].includes(file.name)
							)
								continue;
							await walk(path, depth + 1);
						} else if (
							file.isFile() &&
							file.name.endsWith(".jsonl") &&
							(!!options.customRoot || source !== "codex" || file.name.startsWith("rollout-"))
						) {
							const key = `${source}\0${path}`;
							if (knownPaths.has(key)) {
								result.existingCount++;
								result.roots[source] = root;
								continue;
							}
							if (candidates.size >= MAX_CANDIDATES)
								throw new Error("Session limit exceeded; select a narrower source directory");
							try {
								const candidate = await this.discover(
									source,
									path,
									root,
									!!options.customRoot,
									options.modifiedSince,
								);
								if (!candidate || (candidate.archived && !options.includeArchived)) continue;
								const indexedTitle = readableTitle(titles.get(candidate.sessionId));
								if (indexedTitle) {
									candidate.title = indexedTitle;
									this.explicitTitles.add(candidate);
								}
								candidates.set(candidate.id, { candidate, path, root });
								knownPaths.add(key);
								result.candidates.push(candidate);
								result.roots[source] = root;
							} catch (error) {
								result.errors.push({
									source,
									message: `${file.name}: ${error instanceof Error ? error.message : String(error)}`,
								});
							}
						}
					}
				};
				await walk(root, 0);
			} catch (error) {
				// An absent optional client is normal; permission and parse errors must remain visible.
				if (options.customRoot || record(error).code !== "ENOENT")
					result.errors.push({ source, message: error instanceof Error ? error.message : String(error) });
			}
		}
		this.candidates.clear();
		for (const [id, candidate] of candidates) this.candidates.set(id, candidate);
		result.candidates.sort((a, b) => b.modified.localeCompare(a.modified));
		return result;
	}

	private async discover(
		source: ImportSource,
		path: string,
		root: string,
		allowOtherFormat = false,
		modifiedSince?: number,
	): Promise<ImportCandidate | undefined> {
		const handle = await open(path, "r");
		try {
			const info = await handle.stat();
			if (modifiedSince !== undefined && info.mtimeMs < modifiedSince) return undefined;
			if (!info.isFile() || info.size > MAX_SOURCE_BYTES)
				throw new Error("Source is not a regular file or exceeds 128 MiB");
			let metadata: Record<string, unknown> | undefined;
			let detected: ImportSource | undefined;
			let projectCwd = "";
			let title = "";
			let firstUser = "";
			let pending: Buffer[] = [];
			const inspect = (bytes: Buffer): void => {
				const line = bytes.toString("utf8");
				if (!line.trim()) return;
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch (error) {
					// Only preview validates the transcript after discovery has established its identity.
					if (!metadata) throw error;
					return;
				}
				const r = record(value);
				if (r.type === "workspace-directories" || r.type === "runtime-config") detected = "qoder";
				if (r.type === "session-meta" || r.type === "ai-title") detected = "workbuddy";
				// Flat message records with a role only exist in WorkBuddy transcripts; Claude-derived
				// clients use type:"user"/"assistant", so this cannot cross-detect another harness.
				if (r.type === "message" && (r.role === "user" || r.role === "assistant")) detected = "workbuddy";
				if (typeof r.cwd === "string" && !projectCwd) projectCwd = r.cwd;
				if (source === "codex") {
					const p = record(r.payload);
					if (r.type === "session_meta") {
						metadata ??= p;
						title = readableTitle(p.title) || readableTitle(p.thread_name) || title;
					}
					if (!firstUser && r.type === "response_item" && p.type === "message" && p.role === "user")
						firstUser = userTitle(p.content);
					if (!firstUser && r.type === "event_msg" && p.type === "user_message") firstUser = userTitle(p.message);
				} else if (source === "workbuddy") {
					if (r.type === "session-meta" && typeof r.sessionId === "string") metadata ??= r;
					// Minimal transcripts carry no session-meta; any record with a session ID identifies them.
					if (!metadata && typeof r.sessionId === "string") metadata = r;
					if (r.type === "ai-title") title = readableTitle(r.aiTitle) || title;
					if (r.type === "message" && r.role === "user" && !firstUser) firstUser = userTitle(r.content);
				} else {
					if ((r.type === "user" || r.type === "assistant") && typeof r.sessionId === "string") metadata ??= r;
					if (r.isSidechain === true || (metadata && r.sessionId && r.sessionId !== metadata.sessionId)) return;
					if (r.type === "custom-title" || r.type === "summary")
						title = readableTitle(r.customTitle) || readableTitle(r.summary) || title;
					else title = readableTitle(r.customTitle) || title;
					if (!firstUser && r.type === "user") firstUser = userTitle(record(r.message).content);
				}
			};
			// Title reads stop at 1 MiB. Metadata may share a larger record with message/image content;
			// retain complete-record discovery up to the source cap until identity is established.
			let position = 0;
			while (position < info.size && (!metadata || position < HEADER_BYTES)) {
				const limit = metadata ? Math.min(info.size, HEADER_BYTES) : info.size;
				const buffer = Buffer.alloc(Math.min(limit - position, 64 * 1024));
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
				if (!bytesRead) break;
				position += bytesRead;
				const chunk = buffer.subarray(0, bytesRead);
				let start = 0;
				for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
					pending.push(chunk.subarray(start, end));
					inspect(Buffer.concat(pending));
					pending = [];
					start = end + 1;
					if (metadata && position - chunk.length + start >= HEADER_BYTES) {
						start = chunk.length;
						break;
					}
				}
				if (start < chunk.length) pending.push(chunk.subarray(start));
			}
			if (position === info.size && pending.length) inspect(Buffer.concat(pending));
			if (
				(detected && detected !== source) ||
				(source === "qoder" && detected !== "qoder") ||
				(source === "workbuddy" && detected !== "workbuddy")
			)
				return undefined;
			if (!metadata) {
				if (allowOtherFormat) return undefined;
				throw new Error("Session metadata is missing from the bounded header");
			}
			if (
				metadata.isSidechain === true ||
				metadata.parentAgentId ||
				record(metadata.source).subagent ||
				record(metadata.thread_source).subagent
			)
				return undefined;
			const sessionId = source === "codex" ? metadata.id : metadata.sessionId;
			if (typeof sessionId !== "string" || !sessionId) throw new Error("Invalid source session ID");
			const cwd = typeof metadata.cwd === "string" ? metadata.cwd : projectCwd;
			const archived =
				relative(root, path).split(sep).includes("archived_sessions") ||
				root.split(sep).includes("archived_sessions") ||
				metadata.archived === true;
			const candidate: ImportCandidate = {
				id: randomUUID(),
				sourcePath: path,
				source,
				sessionId,
				title: title || firstUser || `${cwd ? basename(cwd) : source} · ${sessionId.slice(0, 8)}`,
				cwd,
				modified: info.mtime.toISOString(),
				archived,
				version:
					typeof metadata.cli_version === "string"
						? metadata.cli_version
						: typeof metadata.version === "string"
							? metadata.version
							: "unknown",
			};
			if (title) this.explicitTitles.add(candidate);
			// A bounded record count keeps the row informative without reading unbounded history.
			const counted = await countRecords(handle, 0, info.size);
			candidate.messageCount = counted.count;
			if (counted.capped) candidate.messageCountCapped = true;
			return candidate;
		} finally {
			await handle.close();
		}
	}

	private async snapshot(
		id: string,
		file = this.candidates.get(id),
	): Promise<{ parsed: ParsedImport; preview: ImportPreview }> {
		if (!file) throw new SessionImportError("Candidate expired; scan again", 409);
		const path = await realpath(file.path);
		const rel = relative(file.root, path);
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || (await lstat(file.path)).isSymbolicLink())
			throw new SessionImportError("Source escaped its selected directory");
		const handle = await open(path, "r");
		let input: string;
		try {
			const before = await handle.stat();
			if (!before.isFile() || before.size > MAX_SOURCE_BYTES) throw new SessionImportError("Source exceeds 128 MiB");
			input = await handle.readFile("utf8");
			const after = await handle.stat();
			const current = await stat(path);
			if (
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ino !== current.ino ||
				current.size !== after.size ||
				current.mtimeMs !== after.mtimeMs
			)
				throw new SessionImportError("Source changed while reading; preview again", 409);
		} finally {
			await handle.close();
		}
		const attachments = await sourceAttachments(input, file.root);
		const parsed = parseForeignSession(file.candidate.source, attachments.input);
		if (parsed.child || parsed.sessionId !== file.candidate.sessionId)
			throw new SessionImportError("Source identity changed", 409);
		if (parsed.archived && !file.candidate.archived)
			throw new SessionImportError("Source was archived; scan again", 409);
		const messages = parsed.entries.filter((e) => e.type === "message");
		return {
			parsed,
			preview: {
				...file.candidate,
				title: this.explicitTitles.has(file.candidate)
					? file.candidate.title
					: parsed.title || file.candidate.title,
				fingerprint: createHash("sha256")
					.update(input)
					.update(attachments.digest ? `\0${attachments.digest}` : "")
					.digest("hex"),
				messageCount: messages.length,
				toolCount: messages.reduce(
					(n, e) =>
						n +
						(e.message.role === "assistant" ? e.message.content.filter((b) => b.type === "toolCall").length : 0),
					0,
				),
				warnings: parsed.warnings,
				excerpt: messages
					.flatMap((e) => {
						const m = e.message;
						if (!("content" in m)) return [];
						const body =
							typeof m.content === "string"
								? m.content
								: m.content
										.filter((b) => b.type === "text")
										.map((b) => b.text)
										.join("\n");
						return body ? [`${m.role}: ${body}`] : [];
					})
					.join("\n\n")
					.slice(0, 12000),
			},
		};
	}

	async preview(id: string): Promise<ImportPreview> {
		if (this.closed) throw new SessionImportError("Importer is closed", 503);
		const { parsed, preview } = await this.snapshot(id);
		if (this.closed) throw new SessionImportError("Importer is closed", 503);
		const key = `${id}:${preview.fingerprint}`;
		const existing = this.previews.get(key);
		if (existing) {
			existing.expires = Date.now() + PREVIEW_TTL_MS;
			return preview;
		}
		const document: ImportDocument = { preview, entries: parsed.entries };
		const data = JSON.stringify(document);
		const bytes = data.length * 2;
		if (bytes > MAX_PREVIEW_BYTES) throw new SessionImportError("Preview snapshot exceeds cache limit", 413);
		this.prunePreviews();
		let used = [...this.previews.values()].reduce((sum, entry) => sum + entry.bytes, 0);
		for (const [oldKey, entry] of this.previews) {
			if (used + bytes <= MAX_PREVIEW_BYTES) break;
			if (entry.users) continue;
			this.previews.delete(oldKey);
			used -= entry.bytes;
		}
		if (used + bytes > MAX_PREVIEW_BYTES)
			throw new SessionImportError("Preview cache is busy; wait for current imports to finish", 409);
		this.previews.set(key, { data, bytes, expires: Date.now() + PREVIEW_TTL_MS, users: 0 });
		return preview;
	}

	private prunePreviews(): void {
		for (const [key, entry] of this.previews) {
			if (!entry.users && entry.expires <= Date.now()) this.previews.delete(key);
		}
	}

	private async saveJob(job: ImportJob): Promise<void> {
		const dir = join(this.agentDir, "session-imports");
		await mkdir(dir, { recursive: true });
		const path = join(dir, `${job.id}.json`);
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(job), { flag: "wx", mode: 0o600 });
			await rename(temporary, path);
		} finally {
			await unlink(temporary).catch((error: unknown) => {
				// A successful rename has already removed the temporary directory entry.
				if (record(error).code !== "ENOENT") throw error;
			});
		}
	}

	async listJobs(): Promise<ImportJob[]> {
		const dir = join(this.agentDir, "session-imports");
		let names: string[];
		try {
			names = await readdir(dir);
		} catch (error) {
			if (record(error).code === "ENOENT") return [];
			throw error;
		}
		const jobs: ImportJob[] = [];
		for (const name of names.filter((n) => /^[a-f0-9-]{36}\.json$/u.test(n))) {
			const id = name.slice(0, -5);
			const job = await this.getJob(id);
			jobs.push(job);
		}
		return jobs;
	}

	async getJob(id: string): Promise<ImportJob> {
		if (!/^[a-f0-9-]{36}$/u.test(id)) throw new SessionImportError("Invalid job ID");
		const active = this.jobs.get(id);
		if (active) return structuredClone(active);
		let value: unknown;
		try {
			value = JSON.parse(await readFile(join(this.agentDir, "session-imports", `${id}.json`), "utf8"));
		} catch (error) {
			if (record(error).code === "ENOENT") throw new SessionImportError("Job not found", 404);
			throw error;
		}
		const r = record(value);
		if (
			r.id !== id ||
			!["running", "completed", "cancelled", "interrupted"].includes(String(r.status)) ||
			!Number.isSafeInteger(r.total) ||
			Number(r.total) < 1 ||
			Number(r.total) > 100 ||
			!Array.isArray(r.results)
		)
			throw new SessionImportError("Invalid persisted import job", 500);
		// Only this service owns live jobs; a previous host's unfinished batch cannot still be running.
		for (const value of r.results) {
			const result = record(value);
			if (
				typeof result.candidateId !== "string" ||
				!["imported", "skipped", "failed"].includes(String(result.status)) ||
				(result.source !== undefined && !isImportSource(result.source)) ||
				(result.sourcePath !== undefined && typeof result.sourcePath !== "string") ||
				(result.sessionId !== undefined && typeof result.sessionId !== "string") ||
				(result.path !== undefined && typeof result.path !== "string") ||
				(result.error !== undefined && typeof result.error !== "string") ||
				(result.warning !== undefined && typeof result.warning !== "string") ||
				(result.cwd !== undefined &&
					(typeof result.cwd !== "string" || !isAbsolute(result.cwd) || result.cwd.includes("\0"))) ||
				(result.title !== undefined && typeof result.title !== "string")
			)
				throw new SessionImportError("Invalid persisted import result", 500);
		}
		if (typeof r.createdAt !== "string" || !Number.isFinite(Date.parse(r.createdAt)))
			throw new SessionImportError("Invalid persisted import date", 500);
		// The envelope and every result were validated at this persistence boundary.
		const job = value as ImportJob;
		for (const result of job.results) {
			if (!result.path || (result.source && result.cwd && result.title)) continue;
			try {
				const root = await realpath(join(this.sessionRoot, "imported"));
				const path = await realpath(result.path);
				if (!within(root, path)) continue;
				const handle = await open(path, "r");
				try {
					const info = await handle.stat();
					if (!info.isFile()) continue;
					const buffer = Buffer.alloc(Math.min(info.size, HEADER_BYTES));
					const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
					const bytes = buffer.subarray(0, bytesRead);
					// Discard an incomplete final record, except at the actual file end.
					const complete = bytesRead === info.size ? bytes : bytes.subarray(0, bytes.lastIndexOf(10) + 1);
					let firstUser = "";
					let name = "";
					for (const line of complete.toString("utf8").split(/\r?\n/u)) {
						let value: unknown;
						try {
							value = JSON.parse(line);
						} catch {
							continue;
						}
						const entry = record(value);
						if (
							entry.type === "session" &&
							typeof entry.cwd === "string" &&
							isAbsolute(entry.cwd) &&
							!entry.cwd.includes("\0")
						)
							result.cwd ??= entry.cwd;
						if (entry.type === "session_info") name = readableTitle(entry.name) || name;
						const message = record(entry.message);
						if (!firstUser && entry.type === "message" && message.role === "user")
							firstUser = userTitle(message.content);
						if (!result.source && isImportProvenance(entry.imported)) result.source = entry.imported.source;
					}
					if (!result.title) {
						// Native imported names have a display prefix; journal titles do not.
						const title = name.replace(/^\[(codex|claude-code)\] /u, "") || firstUser;
						if (title) result.title = title;
					}
				} finally {
					await handle.close();
				}
			} catch {
				// Deleted or inaccessible native sessions leave truthful unknown metadata in old journals.
			}
		}
		if (job.status === "running") {
			job.status = "interrupted";
			await this.saveJob(job);
		}
		return job;
	}

	private reviewedSelections(selections: ImportSelection[]) {
		if (this.closed) throw new SessionImportError("Importer is closed", 503);
		if (!selections.length || selections.length > 100)
			throw new SessionImportError("Select between 1 and 100 sessions");
		this.prunePreviews();
		return selections.map((selection) => {
			const file = this.candidates.get(selection.candidateId);
			if (
				!file ||
				!/^[a-f0-9]{64}$/u.test(selection.fingerprint) ||
				!isAbsolute(selection.cwd) ||
				selection.cwd.includes("\0")
			)
				throw new SessionImportError("Invalid selection; preview and choose an absolute project directory");
			const snapshot = this.previews.get(`${selection.candidateId}:${selection.fingerprint}`);
			if (!snapshot || snapshot.expires <= Date.now())
				throw new SessionImportError("Preview expired; preview the selected session again", 409);
			return { selection: { ...selection }, file, snapshot };
		});
	}

	/** Reserve reviewed bytes for an external durable job, without starting a nested import job. */
	async reserve(selections: ImportSelection[]): Promise<ReservedSessionImports> {
		const submitted = this.reviewedSelections(selections);
		for (const { snapshot } of submitted) snapshot.users++;
		let released = false;
		let releasePromise: Promise<void> | undefined;
		const publications: Promise<ImportResult>[] = [];
		const release = (): Promise<void> => {
			if (releasePromise) return releasePromise;
			released = true;
			releasePromise = Promise.allSettled(publications).then(() => {
				for (const { snapshot } of submitted) snapshot.users--;
				this.prunePreviews();
			});
			return releasePromise;
		};
		try {
			const items: ReservedSessionImport[] = [];
			for (const { selection, snapshot } of submitted) {
				const prepared = await this.preparePublication(selection, snapshot, () => !released && !this.closed);
				if (this.closed) throw new SessionImportError("Importer is closed", 503);
				let publication: Promise<ImportResult> | undefined;
				items.push({
					candidate: prepared.candidate,
					cwd: prepared.cwd,
					path: prepared.path,
					fingerprint: prepared.fingerprint,
					get existing() {
						return prepared.existing;
					},
					publish: async () => {
						if (released) throw new SessionImportError("Import reservation was released", 409);
						if (this.closed) throw new SessionImportError("Importer is closed", 503);
						if (!publication) {
							publication = this.queue.then(() => {
								if (released) throw new SessionImportError("Import reservation was released", 409);
								if (this.closed) throw new SessionImportError("Importer is closed", 503);
								return prepared.publish();
							});
							publications.push(publication);
							this.queue = publication.then(
								() => undefined,
								() => undefined,
							);
						}
						return structuredClone(await publication);
					},
				});
			}
			return { items, release };
		} catch (error) {
			await release();
			throw error;
		}
	}

	async start(selections: ImportSelection[]): Promise<ImportJob> {
		const submitted = this.reviewedSelections(selections);
		const job: ImportJob = {
			id: randomUUID(),
			createdAt: new Date().toISOString(),
			status: "running",
			total: selections.length,
			results: [],
		};
		// Pin before the first await so scans, eviction and other jobs cannot replace reviewed content.
		for (const { snapshot } of submitted) snapshot.users++;
		try {
			await this.saveJob(job);
		} catch (error) {
			for (const { snapshot } of submitted) snapshot.users--;
			throw error;
		}
		this.jobs.set(job.id, job);
		const run = this.queue
			.then(async () => {
				for (const { selection, file, snapshot } of submitted) {
					if (this.cancelled.has(job.id) || this.closed) break;
					let result: ImportResult;
					try {
						result = await this.commit(selection, snapshot);
					} catch (error) {
						result = {
							candidateId: selection.candidateId,
							source: file.candidate.source,
							sourcePath: file.path,
							title: file.candidate.title,
							cwd: selection.cwd,
							status: "failed",
							error: error instanceof Error ? error.message : String(error),
						};
					}
					job.results.push(result);
					await this.saveJob(job);
				}
				job.status = this.cancelled.has(job.id) || this.closed ? "cancelled" : "completed";
				await this.saveJob(job);
			})
			.catch(async (error: unknown) => {
				job.status = "interrupted";
				job.results.push({
					candidateId: "",
					status: "failed",
					error: `Import journal failed: ${error instanceof Error ? error.message : String(error)}`,
				});
				// Keep the in-memory terminal failure available even if the disk journal is unavailable.
			})
			.finally(() => {
				for (const { snapshot } of submitted) snapshot.users--;
				this.prunePreviews();
				this.running.delete(job.id);
				this.cancelled.delete(job.id);
			});
		this.queue = run;
		this.running.set(job.id, run);
		return structuredClone(job);
	}

	async cancel(id: string): Promise<ImportJob> {
		const job = await this.getJob(id);
		if (job.status === "running") this.cancelled.add(id);
		return job;
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.queue;
		this.previews.clear();
	}

	private preparePublication(
		selection: ImportSelection,
		snapshot: ReviewedSnapshot,
		canPublish?: () => boolean,
	): Promise<ReservedSessionImport> {
		// Serialized by this service's preview, never accepted as client-supplied session entries.
		const document = JSON.parse(snapshot.data) as ImportDocument;
		return prepareSessionPublication({
			selection,
			document,
			sessionRoot: this.sessionRoot,
			onPersisted: this.onPersisted,
			canPublish,
		});
	}

	private async commit(selection: ImportSelection, snapshot: ReviewedSnapshot): Promise<ImportResult> {
		return (await this.preparePublication(selection, snapshot)).publish();
	}
}
