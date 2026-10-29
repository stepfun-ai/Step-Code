/** HTTP-only migration shapes. Keep paired with coding-agent's product types; never import its implementation. */
export type MigrationKind = "sessions" | "skills" | "mcp" | "rules";
/** Legacy job history may still record the removed prompt kind. */
export type LegacyMigrationKind = MigrationKind | "prompts";
export type MigrationSource = "codex" | "claude-code" | "workbuddy" | "qoder" | "shared" | "stepcode" | "plugin";
export type MigrationScope = { kind: "global" } | { kind: "project"; cwd: string };
export type MigrationAction = "copy" | "import" | "create" | "append" | "replace" | "skip";
export type MigrationHolding = "external" | "reference" | "stepcode" | "plugin";
export type MigrationReadiness = "ready" | "disabled" | "shadowed" | "untrusted" | "unsupported" | "unknown";
export type MigrationAcknowledgement = "rules-impact" | "scope-expansion" | "independent-copy" | "sensitive-values";
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
	mcpTransport?: "stdio" | "http";
	sourceSessionId?: string;
	messageCount?: number;
	messageCountCapped?: boolean;
}
export interface MigrationSourceReport {
	kind: MigrationKind;
	source: MigrationSource;
	scope: MigrationScope;
	path: string;
	status: "ok" | "missing" | "empty" | "error" | "unsupported";
	diagnostics: MigrationDiagnostic[];
}
export interface MigrationScanRequest {
	kinds?: MigrationKind[];
	projectCwds?: string[];
	mcpSourcePaths?: Partial<Record<"claude-code" | "codex", string>>;
	sessionOptions?: { range?: "all" | "7" | "30" | "90"; limit?: 30 | 50 | 100 | null; includeArchived?: boolean };
}
export interface MigrationScanResult {
	candidates: MigrationCandidate[];
	sources: MigrationSourceReport[];
	truncated: boolean;
	/** Only present for session scans; totals describe this scan, never a guarantee over all history. */
	sessionSummary?: {
		total: number;
		shown: number;
		incomplete: boolean;
		range: "all" | "7" | "30" | "90";
		limit: 30 | 50 | 100 | null;
	};
}
/** Session destinations may ask for a missing workspace folder to be created. */
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
	/** Legacy job history may still record the removed prompt kind. */
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
