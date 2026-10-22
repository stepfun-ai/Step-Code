import type { FileEntry, SessionEntry } from "../session-manager.ts";

export type ImportSource = "codex" | "claude-code";

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
	title?: string;
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

export function isImportProvenance(value: unknown): value is ImportProvenance {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		(record.source === "codex" || record.source === "claude-code") &&
		typeof record.sessionId === "string" &&
		typeof record.itemId === "string"
	);
}
