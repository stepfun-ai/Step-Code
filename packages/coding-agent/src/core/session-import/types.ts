import type { FileEntry, SessionEntry } from "../session-manager.ts";

export type ImportSource = "codex" | "claude-code" | "workbuddy" | "qoder";

export interface ImportProvenance {
	source: ImportSource;
	sessionId: string;
	itemId: string;
	historicalUsage?: Record<string, number>;
}

export interface ImportCandidate {
	id: string;
	source: ImportSource;
	sessionId: string;
	title: string;
	cwd: string;
	modified: string;
	archived: boolean;
	version: string;
	/** Absolute source JSONL path discovered by the offline scanner. */
	sourcePath?: string;
	/** Non-empty source records found by the bounded discovery read. */
	messageCount?: number;
	/** True when the source is larger than the counting cap, so the count is a lower bound. */
	messageCountCapped?: boolean;
}

export interface ImportWarning {
	code: string;
	count: number;
}

export interface ImportPreview extends ImportCandidate {
	fingerprint: string;
	messageCount: number;
	toolCount: number;
	warnings: ImportWarning[];
	excerpt: string;
}

export interface ParsedImport {
	sessionId: string;
	cwd: string;
	title: string;
	version: string;
	archived: boolean;
	child: boolean;
	entries: SessionEntry[];
	warnings: ImportWarning[];
}

export interface ImportSelection {
	candidateId: string;
	fingerprint: string;
	cwd: string;
}

export interface ImportResult {
	candidateId: string;
	source?: ImportSource;
	sourcePath?: string;
	title?: string;
	/** Selected absolute destination project directory, not the source cwd. */
	cwd?: string;
	status: "imported" | "skipped" | "failed";
	sessionId?: string;
	path?: string;
	error?: string;
	warning?: string;
}

export interface ImportJob {
	id: string;
	createdAt: string;
	status: "running" | "completed" | "cancelled" | "interrupted";
	total: number;
	results: ImportResult[];
}

export interface ImportDocument {
	preview: ImportPreview;
	entries: FileEntry[];
}

export function isImportSource(value: unknown): value is ImportSource {
	return value === "codex" || value === "claude-code" || value === "workbuddy" || value === "qoder";
}

export function isImportProvenance(value: unknown): value is ImportProvenance {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return isImportSource(record.source) && typeof record.sessionId === "string" && typeof record.itemId === "string";
}
