import type { ImportSource } from "../../core/session-import/types.ts";

export type MigrationKind = "sessions" | "skills" | "mcp" | "rules";
/** Legacy journals may still record prompt items from before prompt migration was removed. */
export type LegacyMigrationKind = MigrationKind | "prompts";
export type MigrationSource = ImportSource | "shared" | "stepcode" | "plugin";
export type MigrationScope = { kind: "global" } | { kind: "project"; cwd: string };
export type MigrationAction = "copy" | "import" | "create" | "append" | "replace" | "skip";
export type MigrationHolding = "external" | "reference" | "stepcode" | "plugin";
export type MigrationReadiness = "ready" | "disabled" | "shadowed" | "untrusted" | "unsupported" | "unknown";
export type MigrationAcknowledgement = "rules-impact" | "scope-expansion" | "independent-copy" | "sensitive-values";

/** Diagnostics are codes plus safe metadata, never configuration values or source text. */
export interface MigrationDiagnostic {
	code: string;
	count?: number;
	path?: string;
}

export interface MigrationCandidate {
	id: string;
	kind: MigrationKind;
	source: MigrationSource;
	name: string;
	sourcePath: string;
	sourceScope: MigrationScope;
	holding: MigrationHolding;
	readiness: MigrationReadiness;
	needsMigration: boolean;
	diagnostics: MigrationDiagnostic[];
	modified?: string;
	/** Safe declaration metadata; command, URL and literal values never enter the DTO. */
	mcpTransport?: "stdio" | "http";
	/** Rules only: the AGENTS.md a default preview writes. The preview target remains authoritative. */
	targetPath?: string;
	/** Native session identity is metadata, not an authority to read an arbitrary file. */
	sourceSessionId?: string;
	/** Non-empty source records found during discovery; never source content. */
	messageCount?: number;
	/** True when the count is a lower bound because the source exceeded the counting cap. */
	messageCountCapped?: boolean;
}

export interface MigrationSourceReport {
	kind: MigrationKind;
	source: MigrationSource;
	scope: MigrationScope;
	path: string;
	status: "ok" | "missing" | "empty" | "partial" | "error" | "unsupported";
	diagnostics: MigrationDiagnostic[];
}

export interface MigrationSessionScanOptions {
	range?: "all" | "7" | "30" | "90";
	limit?: 30 | 50 | 100 | null;
	includeArchived?: boolean;
}
export interface MigrationScanRequest {
	kinds?: MigrationKind[];
	/** Explicitly chosen, host-validated source projects; never inferred from every historical cwd. */
	projectCwds?: string[];
	/** Explicit per-source MCP configuration files; does not change session or skill roots. */
	sessionOptions?: MigrationSessionScanOptions;
	mcpSourcePaths?: Partial<Record<"claude-code" | "codex", string>>;
}

export interface MigrationScanResult {
	candidates: MigrationCandidate[];
	sources: MigrationSourceReport[];
	truncated: boolean;
	sessionSummary?: {
		total: number;
		shown: number;
		incomplete: boolean;
		range: "all" | "7" | "30" | "90";
		limit: 30 | 50 | 100 | null;
	};
}

/** Session destinations may additionally ask for the workspace folder to be created. */
export type MigrationTargetRequest = MigrationScope | { kind: "project"; cwd: string; create: true };

export interface MigrationPreviewRequest {
	candidateId: string;
	target?: MigrationTargetRequest;
	action?: MigrationAction;
	targetName?: string;
	includeSensitiveValues?: boolean;
}

export interface MigrationLocation {
	scope: MigrationScope;
	path: string;
	name: string;
}

export interface MigrationRuleImpact {
	before: string[];
	after: string[];
	shadowed: string[];
	/** Binds consent to the effective rules, including a higher-priority file appearing later. */
	fingerprint: string;
	backupRequired: boolean;
}

export interface MigrationPreview {
	id: string;
	candidate: MigrationCandidate;
	fingerprint: string;
	expiresAt: string;
	target: MigrationLocation;
	action: MigrationAction;
	allowedActions: MigrationAction[];
	sourceText: string;
	targetText?: string;
	resultText?: string;
	files?: { path: string; bytes: number }[];
	ruleImpact?: MigrationRuleImpact;
	requiredAcknowledgements: MigrationAcknowledgement[];
	warnings: MigrationDiagnostic[];
	blockers: MigrationDiagnostic[];
	/** Persisted data, resource loading and external activation are distinct outcomes. */
	activation: "history" | "disabled" | "next-resource-load" | "unchanged";
}

export interface MigrationSelection {
	previewId: string;
	acknowledged: MigrationAcknowledgement[];
}

export interface MigrationPlan {
	id: string;
	digest: string;
	expiresAt: string;
	items: MigrationPreview[];
}

export interface MigrationStartRequest {
	planId: string;
	digest: string;
	idempotencyKey: string;
}

export interface MigrationItemResult {
	id: string;
	candidateId: string;
	/** Legacy journal items may name the removed prompt kind. */
	kind: LegacyMigrationKind;
	source: MigrationSource;
	name: string;
	sourceScope: MigrationScope;
	requestedTarget: MigrationLocation;
	actualTarget?: MigrationLocation;
	action: MigrationAction;
	status: "pending" | "running" | "imported" | "skipped" | "failed" | "not-run";
	diagnostics: MigrationDiagnostic[];
	activation: MigrationPreview["activation"];
	sessionId?: string;
	backupId?: string;
}

export interface MigrationJob {
	id: string;
	createdAt: string;
	revision: number;
	status: "queued" | "running" | "stopping" | "completed" | "cancelled" | "interrupted";
	items: MigrationItemResult[];
}

export interface MigrationRecoveryPreview {
	id: string;
	jobId: string;
	itemId: string;
	target: MigrationLocation;
	currentText: string;
	restoredText: string;
	expiresAt: string;
	requiredAcknowledgements: MigrationAcknowledgement[];
	diagnostics: MigrationDiagnostic[];
}
