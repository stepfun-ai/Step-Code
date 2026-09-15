import { Type } from "typebox";
import type { WorkflowJsonValue } from "./types.ts";

/** Structured Planner contract (D_t in the HoH algorithm). */
export const HOH_PLAN_SCHEMA = Type.Object(
	{
		objective: Type.String({ description: "One bounded objective for this iteration" }),
		taskSpecification: Type.Array(
			Type.Object(
				{
					task: Type.String(),
					filesLikely: Type.Array(Type.String()),
				},
				{ additionalProperties: false },
			),
		),
		preservationConstraints: Type.Array(Type.String()),
		validationRequirements: Type.Array(Type.String()),
		rationale: Type.String(),
	},
	{ additionalProperties: false },
);

/** Structured Developer handoff contract. */
export const HOH_DEVELOPER_SCHEMA = Type.Object(
	{
		filesChanged: Type.Array(Type.String()),
		selfTestsPassed: Type.Array(
			Type.Object({ name: Type.String(), evidence: Type.String() }, { additionalProperties: false }),
		),
		selfTestsFailed: Type.Array(
			Type.Object({ name: Type.String(), error: Type.String() }, { additionalProperties: false }),
		),
		designDecisions: Type.Array(Type.String()),
		handoff: Type.String(),
	},
	{ additionalProperties: false },
);

const EVIDENCE_DIMENSION = Type.Array(
	Type.Object({ criterion: Type.String(), pass: Type.Boolean(), obs: Type.String() }, { additionalProperties: false }),
);

/** Structured independent QA evidence contract (E_t). */
export const HOH_EVIDENCE_SCHEMA = Type.Object(
	{
		dimensions: Type.Object(
			{
				functionalCorrectness: EVIDENCE_DIMENSION,
				buildTestIntegrity: EVIDENCE_DIMENSION,
				interfaceInteraction: EVIDENCE_DIMENSION,
				dataDependencies: EVIDENCE_DIMENSION,
				configuration: EVIDENCE_DIMENSION,
				stabilityCompleteness: EVIDENCE_DIMENSION,
			},
			{ additionalProperties: false },
		),
		verifiedBehaviors: Type.Array(Type.String()),
		unresolvedGaps: Type.Array(Type.String()),
		prioritizedTaskScope: Type.Array(Type.String()),
		specCoverage: Type.Number({ minimum: 0, maximum: 1 }),
		coverageDelta: Type.Optional(Type.Number({ minimum: -1, maximum: 1 })),
		nextAction: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export interface HohPromptsInput {
	spec: string;
	iteration: number;
	artifactPath: string;
	previousEvidence: readonly unknown[];
}

export function buildPlannerPrompt(input: HohPromptsInput): string {
	return [
		"You are the HoH Planner. Produce one bounded, verifiable development objective.",
		"The repository and artifact are read-only for this role. Balance repair against capability growth.",
		`<hoh-spec iteration="${input.iteration}">${jsonBounded(input.spec, 20_000)}</hoh-spec>`,
		`<hoh-artifact-readonly>${jsonBounded(input.artifactPath, 2_000)}</hoh-artifact-readonly>`,
		`<hoh-evidence-window>${jsonData(input.previousEvidence)}</hoh-evidence-window>`,
		"Return only the requested PLAN JSON object.",
	].join("\n");
}

export function buildDeveloperPrompt(input: HohPromptsInput, plan: unknown): string {
	return [
		"You are the HoH Developer and the single writer for this iteration.",
		"Implement only the bounded PLAN objective, preserve validated behavior, and run shift-left self-tests.",
		`<hoh-spec>${jsonBounded(input.spec, 20_000)}</hoh-spec>`,
		`<hoh-artifact-writable>${jsonBounded(input.artifactPath, 2_000)}</hoh-artifact-writable>`,
		`<hoh-plan>${jsonData(plan)}</hoh-plan>`,
		`<hoh-previous-evidence>${jsonData(input.previousEvidence)}</hoh-previous-evidence>`,
		"Return only the requested DEV_REPORT JSON object after making the changes.",
	].join("\n");
}

export function buildQaPrompt(input: HohPromptsInput, plan: unknown, developer: unknown): string {
	return [
		"You are the independent HoH QA role. The artifact is read-only for this role.",
		"Run the validation requirements and report observations, regressions, and bounded spec coverage.",
		`<hoh-spec>${jsonBounded(input.spec, 20_000)}</hoh-spec>`,
		`<hoh-artifact-readonly>${jsonBounded(input.artifactPath, 2_000)}</hoh-artifact-readonly>`,
		`<hoh-plan>${jsonData(plan)}</hoh-plan>`,
		`<hoh-developer-report>${jsonData(developer)}</hoh-developer-report>`,
		"Return only the requested EVIDENCE JSON object.",
	].join("\n");
}

export function evidenceWindow(evidence: readonly unknown[], limit = 5): unknown[] {
	return evidence.slice(Math.max(0, evidence.length - Math.max(1, limit)));
}

export function readSpecCoverage(value: unknown, fallback: number): number {
	if (!value || typeof value !== "object" || Array.isArray(value)) return clampCoverage(fallback);
	const candidate = value as Record<string, unknown>;
	const coverage = typeof candidate.specCoverage === "number" ? candidate.specCoverage : fallback;
	return clampCoverage(coverage);
}

export function readCoverageDelta(value: unknown, previousCoverage: number, nextCoverage: number): number {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const candidate = value as Record<string, unknown>;
		if (typeof candidate.coverageDelta === "number" && Number.isFinite(candidate.coverageDelta)) {
			return Math.max(-1, Math.min(1, candidate.coverageDelta));
		}
	}
	return Math.max(-1, Math.min(1, nextCoverage - previousCoverage));
}

export function redactHohValue(value: unknown, maxLength = 12_000): WorkflowJsonValue {
	let encoded: string;
	try {
		encoded = JSON.stringify(value) ?? "null";
	} catch {
		encoded = JSON.stringify(String(value));
	}
	if (encoded.length > maxLength) encoded = `${encoded.slice(0, maxLength)}…`;
	try {
		return JSON.parse(encoded) as WorkflowJsonValue;
	} catch {
		return encoded;
	}
}

function clampCoverage(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function bounded(value: string, maxLength: number): string {
	return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function jsonBounded(value: string, maxLength: number): string {
	return JSON.stringify(bounded(value, maxLength));
}

function jsonData(value: unknown): string {
	return JSON.stringify(redactHohValue(value));
}
