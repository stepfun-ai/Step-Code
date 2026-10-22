import { createHash, randomUUID } from "node:crypto";
import {
	link,
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
import type { FileEntry, SessionFilePersistedEvent } from "../session-manager.ts";
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

const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
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
	codexRoot?: string;
	claudeRoot?: string;
	includeArchived?: boolean;
}

export interface ImportScanResult {
	candidates: ImportCandidate[];
	errors: { source: ImportSource; message: string }[];
}

export class SessionImportError extends Error {
	readonly status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

/** A local, offline migration service. Source files are opened read-only, never as live sessions. */
export class SessionImportService {
	private readonly agentDir: string;
	private readonly sessionRoot: string;
	private readonly onPersisted?: (event: SessionFilePersistedEvent) => void;
	private readonly candidates = new Map<string, CandidateFile>();
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
		const result: ImportScanResult = { candidates: [], errors: [] };
		const roots: [ImportSource, string][] = [
			["codex", options.codexRoot?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")],
			[
				"claude-code",
				options.claudeRoot?.trim() ||
					join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "projects"),
			],
		];
		// Replace capabilities only after the scan finishes. In-flight previews keep their own file reference.
		const candidates = new Map<string, CandidateFile>();
		for (const [source, input] of roots) {
			try {
				const root = await realpath(input);
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
							(source !== "codex" || file.name.startsWith("rollout-"))
						) {
							if (candidates.size >= MAX_CANDIDATES)
								throw new Error("Session limit exceeded; select a narrower source directory");
							try {
								const candidate = await this.discover(source, path, root);
								if (!candidate || (candidate.archived && !options.includeArchived)) continue;
								candidate.title = titles.get(candidate.sessionId) || candidate.title;
								candidates.set(candidate.id, { candidate, path, root });
								result.candidates.push(candidate);
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
				if (record(error).code !== "ENOENT")
					result.errors.push({ source, message: error instanceof Error ? error.message : String(error) });
			}
		}
		this.candidates.clear();
		for (const [id, candidate] of candidates) this.candidates.set(id, candidate);
		result.candidates.sort((a, b) => b.modified.localeCompare(a.modified));
		return result;
	}

	private async discover(source: ImportSource, path: string, root: string): Promise<ImportCandidate | undefined> {
		const handle = await open(path, "r");
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.size > MAX_SOURCE_BYTES)
				throw new Error("Source is not a regular file or exceeds 128 MiB");
			let metadata: Record<string, unknown> | undefined;
			let pending: Buffer[] = [];
			const inspect = (bytes: Buffer): void => {
				const line = bytes.toString("utf8");
				if (!line.trim()) return;
				const r = record(JSON.parse(line));
				if (source === "codex" && r.type === "session_meta") {
					metadata = record(r.payload);
				} else if (source === "claude-code" && typeof r.sessionId === "string") {
					metadata = r;
				}
			};
			// Metadata can share a large record with message/image content. Decode only complete records.
			let position = 0;
			while (!metadata && position < info.size) {
				const buffer = Buffer.alloc(Math.min(info.size - position, 64 * 1024));
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
					if (metadata) break;
				}
				if (!metadata && start < chunk.length) pending.push(chunk.subarray(start));
			}
			if (!metadata && pending.length) inspect(Buffer.concat(pending));
			if (!metadata) throw new Error("Session metadata is missing from the bounded header");
			if (
				metadata.isSidechain === true ||
				metadata.parentAgentId ||
				record(metadata.source).subagent ||
				record(metadata.thread_source).subagent
			)
				return undefined;
			const sessionId = source === "codex" ? metadata.id : metadata.sessionId;
			if (typeof sessionId !== "string" || !sessionId) throw new Error("Invalid source session ID");
			const cwd = typeof metadata.cwd === "string" ? metadata.cwd : "";
			const archived =
				relative(root, path).split(sep).includes("archived_sessions") ||
				root.split(sep).includes("archived_sessions") ||
				metadata.archived === true;
			return {
				id: randomUUID(),
				source,
				sessionId,
				title:
					typeof metadata.customTitle === "string"
						? metadata.customTitle.slice(0, 120)
						: `${basename(cwd) || source} · ${sessionId.slice(0, 8)}`,
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
				title: file.candidate.title.includes(` · ${file.candidate.sessionId.slice(0, 8)}`)
					? parsed.title || file.candidate.title
					: file.candidate.title,
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
				(result.sessionId !== undefined && typeof result.sessionId !== "string") ||
				(result.path !== undefined && typeof result.path !== "string") ||
				(result.error !== undefined && typeof result.error !== "string") ||
				(result.warning !== undefined && typeof result.warning !== "string") ||
				(result.title !== undefined && typeof result.title !== "string")
			)
				throw new SessionImportError("Invalid persisted import result", 500);
		}
		if (typeof r.createdAt !== "string" || !Number.isFinite(Date.parse(r.createdAt)))
			throw new SessionImportError("Invalid persisted import date", 500);
		// The envelope and every result were validated at this persistence boundary.
		const job = value as ImportJob;
		if (job.status === "running") {
			job.status = "interrupted";
			await this.saveJob(job);
		}
		return job;
	}

	async start(selections: ImportSelection[]): Promise<ImportJob> {
		if (this.closed) throw new SessionImportError("Importer is closed", 503);
		if (!selections.length || selections.length > 100)
			throw new SessionImportError("Select between 1 and 100 sessions");
		this.prunePreviews();
		const submitted = selections.map((selection) => {
			const file = this.candidates.get(selection.candidateId);
			if (!file || !/^[a-f0-9]{64}$/u.test(selection.fingerprint) || !isAbsolute(selection.cwd))
				throw new SessionImportError("Invalid selection; preview and choose an absolute project directory");
			const snapshot = this.previews.get(`${selection.candidateId}:${selection.fingerprint}`);
			if (!snapshot || snapshot.expires <= Date.now())
				throw new SessionImportError("Preview expired; preview the selected session again", 409);
			return { selection: { ...selection }, file, snapshot };
		});
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
							title: file.candidate.title,
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

	private async commit(selection: ImportSelection, snapshot: ReviewedSnapshot): Promise<ImportResult> {
		// This immutable document was serialized by preview(), not supplied by the client or source.
		const { entries: reviewedEntries, preview } = JSON.parse(snapshot.data) as ImportDocument;
		const cwd = await realpath(selection.cwd);
		if (!(await stat(cwd)).isDirectory()) throw new SessionImportError("Project directory does not exist");
		const hash = createHash("sha256")
			.update(`${preview.source}\0${preview.sessionId}\0${preview.fingerprint}`)
			.digest("hex");
		const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
		const dir = join(this.sessionRoot, "imported");
		await mkdir(dir, { recursive: true });
		const path = join(dir, `${id}.jsonl`);
		const temporary = join(dir, `.${id}.${randomUUID()}.tmp`);
		const timestamp = new Date().toISOString();
		const last = reviewedEntries.at(-1);
		const leaf = last && "id" in last ? last.id : null;
		const entries: FileEntry[] = [
			{ type: "session", version: 3, id, timestamp, cwd },
			...reviewedEntries,
			{
				type: "custom",
				id: randomUUID().slice(0, 8),
				parentId: leaf,
				timestamp,
				customType: "stepcode.session-import",
				data: {
					source: preview.source,
					sourceSessionId: preview.sessionId,
					fingerprint: preview.fingerprint,
					version: preview.version,
					sourceCwd: preview.cwd,
					warnings: preview.warnings,
				},
			},
		];
		const metadataId = entries.at(-1);
		entries.push({
			type: "session_info",
			id: randomUUID().slice(0, 8),
			parentId: metadataId && "parentId" in metadataId ? metadataId.id : leaf,
			timestamp,
			name: `[${preview.source}] ${preview.title}`,
		});
		const handle = await open(temporary, "wx", 0o600);
		let status: "imported" | "skipped" = "imported";
		try {
			await handle.writeFile(`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
			await handle.sync();
			await handle.close();
			// A hard-link publication is atomic and, unlike rename, never overwrites another importer.
			await link(temporary, path);
		} catch (error) {
			if (record(error).code === "EEXIST") status = "skipped";
			else throw error;
		} finally {
			await handle.close();
			await unlink(temporary);
		}
		let warning: string | undefined;
		try {
			this.onPersisted?.({ path, kind: "append" });
		} catch (error) {
			// Publication is already durable. An index failure must not misreport it as a failed import.
			warning = `Session saved; search index notification failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		return { candidateId: selection.candidateId, title: preview.title, status, sessionId: id, path, warning };
	}
}
