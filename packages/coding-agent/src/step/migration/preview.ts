import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { StepMcpServerConfig } from "../config-toml.ts";
import { hash, info, type PackageFile, stable, text } from "./filesystem.ts";
import { mcpIdentity, redactedMcp, sanitizedMcp, targetServers } from "./mcp.ts";
import { type MigrationPaths, resourceName } from "./paths.ts";
import {
	copiedSkillEnabled,
	promptName,
	type ResourceCandidate,
	ResourceInspector,
	renamedSkill,
	resourceIgnoreFingerprint,
	resourceSnapshot,
	targetResourceEnabled,
	targetResourceUncertain,
} from "./resources.ts";
import { ruleImpact } from "./rules.ts";
import type { MigrationPreview, MigrationPreviewRequest } from "./types.ts";

export interface PreparedMigration {
	dto: MigrationPreview;
	request: MigrationPreviewRequest;
	item?: ResourceCandidate;
	sourceHash: string;
	targetHash: string | null;
	projectIdentity?: string;
	result: string;
	files: PackageFile[];
	mcp?: StepMcpServerConfig;
	session?: { candidateId: string; fingerprint: string; cwd: string };
}
export const PREVIEW_TTL = 15 * 60 * 1000;
export function prepareResource(
	paths: MigrationPaths,
	item: ResourceCandidate,
	request: MigrationPreviewRequest,
	records: ResourceCandidate[],
	publishedSkills: ReadonlySet<string> = new Set(),
): PreparedMigration {
	const candidate = structuredClone(item.dto);
	const scope = paths.scope(request.target, candidate.sourceScope);
	const source = resourceSnapshot(
		item,
		request.action !== "skip" && (request.action !== undefined || candidate.needsMigration),
	);
	let name = request.targetName ?? candidate.name;
	if (candidate.kind === "skills") name = resourceName(name, true);
	else if (candidate.kind === "prompts") name = promptName(name);
	else if (candidate.kind === "mcp") name = resourceName(name);
	let path =
		candidate.kind === "mcp"
			? paths.config
			: candidate.kind === "rules"
				? join(scope.kind === "global" ? paths.agent : scope.cwd, "AGENTS.md")
				: join(paths.resourceRoot(scope), candidate.kind, candidate.kind === "skills" ? name : `${name}.md`);
	const dto: MigrationPreview = {
		id: randomUUID(),
		candidate,
		fingerprint: "",
		expiresAt: new Date(Date.now() + PREVIEW_TTL).toISOString(),
		target: { scope, path, name },
		action:
			request.action ??
			(candidate.needsMigration
				? candidate.kind === "rules"
					? "create"
					: candidate.kind === "mcp"
						? "import"
						: "copy"
				: "skip"),
		allowedActions: ["skip"],
		sourceText: source.sourceText,
		requiredAcknowledgements: [],
		warnings: [],
		blockers: [],
		activation: "next-resource-load",
	};
	const block = (code: string): void => {
		dto.blockers.push({ code });
	};
	if (candidate.holding === "plugin" && dto.action !== "skip") block("plugin-managed");
	if (["unsupported", "unknown", "untrusted"].includes(candidate.readiness)) block(`resource-${candidate.readiness}`);
	if (candidate.kind !== "rules" && scope.kind === "project" && !paths.trusted(scope.cwd)) block("target-untrusted");
	if (candidate.sourceScope.kind === "project" && scope.kind === "global")
		dto.requiredAcknowledgements.push("scope-expansion");
	let result = source.sourceText;
	let mcp: StepMcpServerConfig | undefined;
	let targetText: string | undefined;
	let targetHash: string | null = null;
	const files = source.files.map((file) => ({ ...file }));
	const destination =
		candidate.kind === "skills"
			? new ResourceInspector(paths).destinationSkills(scope, records, publishedSkills)
			: undefined;
	if (candidate.kind === "mcp") {
		dto.activation = "disabled";
		if (scope.kind !== "global") block("mcp-global-only");
		const servers = targetServers(paths);
		const original = item.mcp?.config;
		if (!original) block("unsupported-mcp-config");
		else {
			const sanitized = sanitizedMcp(original, request.includeSensitiveValues === true);
			mcp = sanitized.config;
			if (sanitized.stripped) dto.warnings.push({ code: "sensitive-values-omitted" });
			if (request.includeSensitiveValues) dto.requiredAcknowledgements.push("sensitive-values");
			if (original.cwd && !original.cwd.startsWith("/")) block("relative-mcp-path-unsupported");
			const same = Object.entries(servers).find(([, value]) => mcpIdentity(value) === mcpIdentity(original));
			if (same) {
				name = same[0];
				dto.target.name = name;
				dto.action = "skip";
			} else if (servers[name]) block("target-conflict");
		}
		targetHash = text(path, true) === undefined ? null : hash(text(path)!);
		dto.sourceText = original ? redactedMcp(original) : "[unsupported configuration]";
		targetText = servers[name] ? redactedMcp(servers[name]) : undefined;
		result = mcp ? redactedMcp(mcp) : "";
		dto.allowedActions.push("import");
	} else if (candidate.kind === "skills") {
		if (info(path)) block("target-conflict");
		const independent =
			candidate.holding === "reference" || candidate.readiness === "disabled" || candidate.readiness === "shadowed";
		if (independent && dto.action !== "skip") {
			dto.requiredAcknowledgements.push("independent-copy");
			if (name === candidate.name) block("independent-copy-needs-new-name");
		}
		if (
			destination?.skills.some(
				(other) =>
					other.name === name &&
					other.path !== candidate.sourcePath &&
					["ready", "shadowed", "unknown"].includes(other.readiness),
			)
		)
			block("skill-name-conflict");
		if (destination?.uncertain) dto.warnings.push({ code: "target-activation-unknown" });
		if (name !== candidate.name) {
			result = renamedSkill(source.sourceText, candidate.sourcePath, name);
			const skill = files.find((file) => file.path === "SKILL.md");
			if (skill) skill.data = Buffer.from(result);
		}
		dto.files = files.map((file) => ({ path: file.path, bytes: file.data.length }));
		dto.allowedActions.push("copy");
	} else {
		targetText = text(path, true);
		targetHash = targetText === undefined ? null : hash(targetText);
		if (candidate.kind === "rules") {
			dto.target.name = "AGENTS.md";
			if (request.targetName && request.targetName !== "AGENTS.md") block("invalid-rule-target");
			dto.allowedActions.push(
				...(targetText === undefined ? ["create" as const] : ["append" as const, "replace" as const]),
			);
			if (dto.action === "append") result = `${targetText ?? ""}\n\n${source.sourceText}`;
			const inspection = ruleImpact(paths, scope, path, result);
			dto.ruleImpact = inspection.impact;
			if (inspection.blocked) block("rule-higher-priority-override");
			if (dto.action !== "skip") dto.requiredAcknowledgements.push("rules-impact");
			dto.warnings.push({ code: "rules-default-model-context" }, { code: "rules-no-active-reload" });
		} else {
			dto.allowedActions.push("copy");
			if (targetText !== undefined) {
				if (targetText === result) dto.action = "skip";
				else block("target-conflict");
			}
		}
	}
	if (
		dto.action !== "skip" &&
		(candidate.kind === "skills" || candidate.kind === "prompts") &&
		(!targetResourceEnabled(
			paths,
			scope,
			candidate.kind,
			candidate.kind === "skills" ? join(path, "SKILL.md") : path,
		) ||
			(candidate.kind === "skills" && !copiedSkillEnabled(files)))
	) {
		dto.activation = "disabled";
		dto.warnings.push({ code: "target-disabled" });
	}
	if (dto.action !== "skip" && (candidate.kind === "skills" || candidate.kind === "prompts")) {
		dto.warnings.push({ code: "resource-load-timing-only" });
		if (targetResourceUncertain(paths, scope, candidate.kind))
			dto.warnings.push({ code: "target-activation-unknown" });
	}
	if (candidate.holding === "plugin") dto.allowedActions = ["skip"];
	if (dto.action === "skip") {
		dto.activation = "unchanged";
		dto.blockers = [];
		dto.requiredAcknowledgements = [];
		if (candidate.holding === "reference" || candidate.source === "plugin" || candidate.source === "stepcode") {
			path = candidate.sourcePath;
			dto.target.path = path;
			dto.target.scope = candidate.sourceScope;
		} else if (candidate.kind === "mcp" && candidate.holding === "plugin") {
			dto.target.path = candidate.diagnostics.find((d) => d.code === "plugin-provided")?.path ?? path;
		}
	} else if (!dto.allowedActions.includes(dto.action)) block("unsupported-action");
	dto.targetText = targetText;
	dto.resultText = result;
	dto.fingerprint = hash(
		stable({
			candidate,
			destination: destination?.fingerprint,
			projectIdentity: paths.projectIdentity(dto.target.scope),
			ignore:
				dto.action !== "skip" && (candidate.kind === "skills" || candidate.kind === "prompts")
					? {
							source: resourceIgnoreFingerprint(item.root, candidate.sourcePath),
							target: resourceIgnoreFingerprint(
								join(paths.resourceRoot(scope), candidate.kind),
								candidate.kind === "skills" ? join(dto.target.path, "SKILL.md") : dto.target.path,
							),
						}
					: undefined,
			source: source.fingerprint,
			targetHash,
			target: dto.target,
			result: hash(mcp ? stable(mcp) : result),
			action: dto.action,
			ruleImpact: dto.ruleImpact,
			required: dto.requiredAcknowledgements,
			blockers: dto.blockers,
			activation: dto.activation,
			warnings: dto.warnings,
		}),
	);
	return {
		dto,
		request: structuredClone(request),
		item,
		sourceHash: source.fingerprint,
		targetHash,
		projectIdentity: paths.projectIdentity(dto.target.scope),
		result,
		files,
		mcp,
	};
}
