import { api } from "../../lib/api";
import type {
	MigrationCandidate,
	MigrationDiagnostic,
	MigrationJob,
	MigrationPlan,
	MigrationPreview,
	MigrationRecoveryPreview,
	MigrationScanResult,
	MigrationScope,
} from "../../state/types";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function diagnostics(value: unknown): value is MigrationDiagnostic[] {
	return (
		Array.isArray(value) &&
		value.every(
			(item) =>
				record(item) &&
				typeof item.code === "string" &&
				(item.path === undefined || typeof item.path === "string") &&
				(item.count === undefined || typeof item.count === "number"),
		)
	);
}
function scope(value: unknown): value is MigrationScope {
	return record(value) && (value.kind === "global" || (value.kind === "project" && typeof value.cwd === "string"));
}
function location(value: unknown): boolean {
	return record(value) && scope(value.scope) && typeof value.path === "string" && typeof value.name === "string";
}
function member(value: unknown, values: readonly string[]): boolean {
	return typeof value === "string" && values.includes(value);
}
const kinds = ["sessions", "skills", "mcp", "rules"];
const legacyResultKinds = [...kinds, "prompts"];
const actions = ["copy", "import", "create", "append", "replace", "skip"];
const sources = ["codex", "claude-code", "workbuddy", "qoder", "shared", "stepcode", "plugin"];
const activations = ["history", "disabled", "next-resource-load", "unchanged"];
function acknowledgements(value: unknown): boolean {
	return (
		strings(value) &&
		value.every((item) => ["rules-impact", "scope-expansion", "independent-copy", "sensitive-values"].includes(item))
	);
}
function candidate(value: unknown): value is MigrationCandidate {
	return (
		record(value) &&
		typeof value.id === "string" &&
		member(value.kind, kinds) &&
		member(value.source, sources) &&
		typeof value.name === "string" &&
		typeof value.sourcePath === "string" &&
		scope(value.sourceScope) &&
		member(value.holding, ["external", "reference", "stepcode", "plugin"]) &&
		member(value.readiness, ["ready", "disabled", "shadowed", "untrusted", "unsupported", "unknown"]) &&
		typeof value.needsMigration === "boolean" &&
		(value.mcpTransport === undefined || (value.kind === "mcp" && member(value.mcpTransport, ["stdio", "http"]))) &&
		(value.messageCount === undefined || typeof value.messageCount === "number") &&
		(value.messageCountCapped === undefined || typeof value.messageCountCapped === "boolean") &&
		diagnostics(value.diagnostics)
	);
}
export function isScan(value: unknown): value is MigrationScanResult {
	return (
		record(value) &&
		Array.isArray(value.candidates) &&
		value.candidates.every(candidate) &&
		typeof value.truncated === "boolean" &&
		(value.sessionSummary === undefined ||
			(record(value.sessionSummary) &&
				typeof value.sessionSummary.total === "number" &&
				typeof value.sessionSummary.shown === "number" &&
				typeof value.sessionSummary.incomplete === "boolean" &&
				member(value.sessionSummary.range, ["all", "7", "30", "90"]) &&
				(value.sessionSummary.limit === null || [30, 50, 100].includes(value.sessionSummary.limit as number)))) &&
		Array.isArray(value.sources) &&
		value.sources.every(
			(item) =>
				record(item) &&
				member(item.kind, kinds) &&
				member(item.source, sources) &&
				scope(item.scope) &&
				typeof item.path === "string" &&
				member(item.status, ["ok", "missing", "empty", "partial", "error", "unsupported"]) &&
				diagnostics(item.diagnostics),
		)
	);
}
export function isPreview(value: unknown): value is MigrationPreview {
	return (
		record(value) &&
		typeof value.id === "string" &&
		candidate(value.candidate) &&
		typeof value.fingerprint === "string" &&
		typeof value.expiresAt === "string" &&
		location(value.target) &&
		member(value.action, actions) &&
		strings(value.allowedActions) &&
		value.allowedActions.every((item) => actions.includes(item)) &&
		typeof value.sourceText === "string" &&
		(value.targetText === undefined || typeof value.targetText === "string") &&
		(value.resultText === undefined || typeof value.resultText === "string") &&
		(value.files === undefined ||
			(Array.isArray(value.files) &&
				value.files.every(
					(file) => record(file) && typeof file.path === "string" && typeof file.bytes === "number",
				))) &&
		(value.ruleImpact === undefined ||
			(record(value.ruleImpact) &&
				strings(value.ruleImpact.before) &&
				strings(value.ruleImpact.after) &&
				strings(value.ruleImpact.shadowed) &&
				typeof value.ruleImpact.fingerprint === "string" &&
				typeof value.ruleImpact.backupRequired === "boolean")) &&
		acknowledgements(value.requiredAcknowledgements) &&
		diagnostics(value.warnings) &&
		diagnostics(value.blockers) &&
		member(value.activation, activations)
	);
}
export function isPlan(value: unknown): value is MigrationPlan {
	return (
		record(value) &&
		typeof value.id === "string" &&
		typeof value.digest === "string" &&
		typeof value.expiresAt === "string" &&
		Array.isArray(value.items) &&
		value.items.every(isPreview)
	);
}
export function isJob(value: unknown): value is MigrationJob {
	return (
		record(value) &&
		typeof value.id === "string" &&
		typeof value.createdAt === "string" &&
		Number.isSafeInteger(value.revision) &&
		member(value.status, ["queued", "running", "stopping", "completed", "cancelled", "interrupted"]) &&
		Array.isArray(value.items) &&
		value.items.every(
			(item) =>
				record(item) &&
				typeof item.id === "string" &&
				typeof item.candidateId === "string" &&
				member(item.kind, legacyResultKinds) &&
				member(item.source, sources) &&
				typeof item.name === "string" &&
				scope(item.sourceScope) &&
				location(item.requestedTarget) &&
				(item.actualTarget === undefined || location(item.actualTarget)) &&
				member(item.action, actions) &&
				member(item.status, ["pending", "running", "imported", "skipped", "failed", "not-run"]) &&
				diagnostics(item.diagnostics) &&
				member(item.activation, activations) &&
				(item.sessionId === undefined || typeof item.sessionId === "string") &&
				(item.backupId === undefined || typeof item.backupId === "string"),
		)
	);
}
export function isJobs(value: unknown): value is { jobs: MigrationJob[] } {
	return record(value) && Array.isArray(value.jobs) && value.jobs.every(isJob);
}
export function isRecovery(value: unknown): value is MigrationRecoveryPreview {
	return (
		record(value) &&
		typeof value.id === "string" &&
		typeof value.jobId === "string" &&
		typeof value.itemId === "string" &&
		location(value.target) &&
		typeof value.currentText === "string" &&
		typeof value.restoredText === "string" &&
		typeof value.expiresAt === "string" &&
		acknowledgements(value.requiredAcknowledgements) &&
		diagnostics(value.diagnostics)
	);
}
export async function migrationRequest<T>(
	path: string,
	guard: (value: unknown) => value is T,
	body?: unknown,
	signal?: AbortSignal,
): Promise<T> {
	const value = await api<unknown>(`/api/v1/migrations${path}`, {
		method: body === undefined ? "GET" : "POST",
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal,
	});
	if (!guard(value)) throw new Error("invalid-response");
	return value;
}
