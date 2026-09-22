import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkflowJournalEntry, WorkflowJsonValue, WorkflowTelemetryRecord } from "./types.ts";

const JOURNAL_FILENAME = "journal.jsonl";
const PROGRESS_FILENAME = "progress.json";
const TELEMETRY_FILENAME = "telemetry.jsonl";
const EVIDENCE_FILENAME = "evidence.jsonl";

export interface WorkflowRunPaths {
	root: string;
	runDir: string;
	scriptPath: string;
	journalPath: string;
	progressPath: string;
	telemetryPath: string;
	evidencePath: string;
}

export function resolveWorkflowRoot(cwd: string): string {
	return path.join(path.resolve(cwd), ".stepcode", "workflows");
}

export function createWorkflowRunPaths(cwd: string, runId: string): WorkflowRunPaths {
	const root = resolveWorkflowRoot(cwd);
	const runDir = path.join(root, "runs", safeRunId(runId));
	return {
		root,
		runDir,
		scriptPath: path.join(runDir, "script.js"),
		journalPath: path.join(runDir, JOURNAL_FILENAME),
		progressPath: path.join(runDir, PROGRESS_FILENAME),
		telemetryPath: path.join(runDir, TELEMETRY_FILENAME),
		evidencePath: path.join(runDir, EVIDENCE_FILENAME),
	};
}

function safeRunId(value: string): string {
	const trimmed = value.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(trimmed)) {
		throw new Error("Invalid workflow run id");
	}
	return trimmed;
}

export function newWorkflowRunId(): string {
	return `wf_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/** Stable JSON encoding used for script call hashes and resume keys. */
export function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		if (typeof value === "number" && !Number.isFinite(value)) return "null";
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

export function workflowHash(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

export async function readJsonLines<T>(filePath: string): Promise<T[]> {
	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch (error: unknown) {
		if (isFileNotFound(error)) return [];
		throw error;
	}
	const lines = content.split(/\r?\n/u);
	const values: T[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			values.push(JSON.parse(line) as T);
		} catch {
			// A partial final line can be left by a killed process. Stop here so a
			// later run can only resume the verified contiguous prefix.
			break;
		}
	}
	return values;
}

export async function writeWorkflowFileAtomic(filePath: string, content: string): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, filePath);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

/** Append-only run journal with conservative prefix-only resume semantics. */
export class WorkflowJournal {
	readonly paths: WorkflowRunPaths;
	private readonly entries = new Map<number, WorkflowJournalEntry>();
	private appendQueue: Promise<void> = Promise.resolve();
	private resumeEnabled = false;
	private initialized = false;

	constructor(paths: WorkflowRunPaths, resumeFrom?: WorkflowRunPaths) {
		this.paths = paths;
		this.resumeFromPath = resumeFrom?.journalPath;
	}

	private readonly resumeFromPath?: string;

	async initialize(script: string, resumeFrom?: WorkflowRunPaths): Promise<void> {
		if (this.initialized) return;
		await mkdir(this.paths.runDir, { recursive: true });
		try {
			await writeFile(this.paths.scriptPath, script, { encoding: "utf8", mode: 0o600, flag: "wx" });
		} catch (error: unknown) {
			if (
				!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST")
			) {
				throw error;
			}
		}
		const source = resumeFrom?.journalPath ?? this.resumeFromPath;
		if (source) {
			const previous = await readJsonLines<WorkflowJournalEntry>(source);
			for (const entry of previous) {
				if (isJournalEntry(entry)) this.entries.set(entry.seq, entry);
			}
			this.resumeEnabled = this.entries.size > 0;
		}
		this.initialized = true;
	}

	/** Return a cached result only while every prior call has matched. */
	getCached(seq: number, callHash: string): WorkflowJournalEntry | undefined {
		if (!this.resumeEnabled) return undefined;
		const entry = this.entries.get(seq);
		if (!entry || entry.callHash !== callHash || (entry.status !== "completed" && entry.status !== "cached")) {
			this.resumeEnabled = false;
			return undefined;
		}
		return entry;
	}

	async append(entry: WorkflowJournalEntry): Promise<void> {
		this.entries.set(entry.seq, entry);
		const line = `${JSON.stringify(entry)}\n`;
		await this.enqueue(async () => {
			await mkdir(path.dirname(this.paths.journalPath), { recursive: true });
			await appendFile(this.paths.journalPath, line, { encoding: "utf8", mode: 0o600 });
		});
	}

	async appendTelemetry(record: WorkflowTelemetryRecord): Promise<void> {
		const line = `${JSON.stringify(record)}\n`;
		await this.enqueue(async () => {
			await mkdir(path.dirname(this.paths.telemetryPath), { recursive: true });
			await appendFile(this.paths.telemetryPath, line, { encoding: "utf8", mode: 0o600 });
		});
	}

	async appendEvidence(value: WorkflowJsonValue, evidencePath = this.paths.evidencePath): Promise<void> {
		const target = path.resolve(evidencePath);
		const line = `${JSON.stringify(value)}\n`;
		await this.enqueue(async () => {
			await mkdir(path.dirname(target), { recursive: true });
			await appendFile(target, line, { encoding: "utf8", mode: 0o600 });
		});
	}

	async flush(): Promise<void> {
		await this.appendQueue;
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const pending = this.appendQueue.then(operation, operation);
		this.appendQueue = pending.catch(() => undefined);
		return pending;
	}
}

function isJournalEntry(value: unknown): value is WorkflowJournalEntry {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Partial<WorkflowJournalEntry>;
	return (
		candidate.schemaVersion === 1 &&
		typeof candidate.seq === "number" &&
		typeof candidate.callHash === "string" &&
		(candidate.status === "completed" || candidate.status === "cached")
	);
}

export function workflowJsonValue(value: unknown): WorkflowJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (Array.isArray(value)) return value.map((item) => workflowJsonValue(item));
	if (typeof value === "object") {
		const result = Object.create(null) as { [key: string]: WorkflowJsonValue };
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			result[key] = workflowJsonValue(item);
		}
		return result;
	}
	return String(value);
}

function isFileNotFound(error: unknown): boolean {
	return (
		error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"
	);
}
